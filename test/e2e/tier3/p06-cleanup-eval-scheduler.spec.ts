import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  createMockProbe,
  legacyV3Capabilities,
  parseInviteLink,
  type QualityNode,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  assertNoLegacyAiStrings,
  assertYamlGroupExactOrder,
  basicOnlyConfig,
  buildDraft,
  buildLegacyPreR1Documents,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildQualitySchedule,
  buildSource,
  parseMihomoYaml,
  uniqueId,
  type QualityScheduleConfig,
} from '../helpers/fixtures.ts'

interface StateResponse {
  id: string
  revision: number
  draft: ReturnType<typeof buildDraft>
}

interface SourceNodesResponse {
  good: {
    nodes: Array<{ id: string; name: string }>
  } | null
}

interface QualityDeviceSummary {
  id: string
  name: string
}

interface VersionSummary {
  seq: number
  kind: 'publish' | 'auto' | 'rollback'
  parent: number | null
}

interface LinkResponse {
  url: string | null
  active: boolean
  revoked: boolean
}

interface ScheduleRunResponse {
  jobs: Array<{ id: string; targetDeviceId: string; scheduleKind?: string }>
  skipped: Array<{ kind: string; reason: string }>
  schedule: QualityScheduleConfig
}

test.describe('T3-P06 Legacy Cleanup, Single-Probe Group Evaluation & Quality Scheduler (F2, F6, F7)', () => {
  test('T3-P06-01 (F2,F6,F7): cleans legacy pinning/registration docs, blocks legacy v3 probe in schedule, and executes tick() scheduled check to auto-publish updated single-probe group', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    const profileId = uniqueId('prof_')
    const legacySourceId = uniqueId('src_')
    const legacyNodeId = uniqueId('nod_')
    const legacyGroupId = uniqueId('grp_')
    const legacyReportId = randomUUID()
    const legacyDeviceId = randomUUID()

    try {
      subServer = await startMockSubServer({
        main: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-Fast', { server: 'us-fast.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-Slow', { server: 'jp-slow.example.net', port: 10002 }),
          ],
        },
      })

      harness = await startAppHarness({
        tickMs: 0,
        seedLegacy: seeder => {
          seeder.seedEntries(
            buildLegacyPreR1Documents(profileId, {
              sourceId: legacySourceId,
              nodeId: legacyNodeId,
              nodeKey: `${legacySourceId}/${legacyNodeId}`,
              groupId: legacyGroupId,
              reportId: legacyReportId,
              deviceId: legacyDeviceId,
            }),
          )
        },
      })

      // (F2,F6): Verify startup cleanup stripped fixedQualitySnapshot, qualityBaselinePolicy, qualityReportId, qualitySnapshot
      const cleanedProfile = harness.readDbDoc<Record<string, unknown>>('profiles', profileId)
      expect(cleanedProfile).toBeDefined()
      assertNoLegacyAiStrings(cleanedProfile)
      expect(Object.hasOwn(cleanedProfile!, 'fixedQualitySnapshot')).toBe(false)
      expect(Object.hasOwn((cleanedProfile!.draft as Record<string, unknown>) ?? {}, 'qualityBaselinePolicy')).toBe(false)

      const cleanedVersion1 = harness.readDbDoc<Record<string, unknown>>(`versions/${profileId}`, '000000000001')
      expect(cleanedVersion1).toBeDefined()
      assertNoLegacyAiStrings(cleanedVersion1)
      expect(Object.hasOwn(cleanedVersion1!, 'qualityReportId')).toBe(false)
      expect(Object.hasOwn(cleanedVersion1!, 'qualitySnapshot')).toBe(false)
      expect(harness.readDbDoc(`quality-device/${profileId}`, 'registration')).toBeUndefined()
      expect(harness.readDbDoc(`quality-device/${profileId}`, 'next')).toBeUndefined()

      // (F2,F7): Enroll an online legacy v3 (1.3.1) probe and verify schedule/run rejects it with 409
      const legacyInvite = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {}, { profile: profileId })
      expect(legacyInvite.status).toBe(200)
      const parsedLegacy = parseInviteLink(legacyInvite.data.pairing)
      const onlineLegacyProbe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsedLegacy.profileId,
        name: 'Online-Legacy-V3',
        capabilities: legacyV3Capabilities(),
      })
      expect((await onlineLegacyProbe.enroll(parsedLegacy.ticket)).status).toBe(200)

      // Enroll modern v4 (2.0.0) probe
      const v4Invite = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {}, { profile: profileId })
      expect(v4Invite.status).toBe(200)
      const parsedV4 = parseInviteLink(v4Invite.data.pairing)
      const v4Probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsedV4.profileId,
        name: 'P06-V4-Probe',
      })
      expect((await v4Probe.enroll(parsedV4.ticket)).status).toBe(200)

      const devicesRes = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices', { profile: profileId })
      const onlineLegacyDev = devicesRes.data.find(d => d.name === 'Online-Legacy-V3')!
      const v4Dev = devicesRes.data.find(d => d.name === 'P06-V4-Probe')!

      // Configure live subscription source + Group bound to v4Dev
      const stateRes = await harness.apiGet<StateResponse>('/api/state', { profile: profileId })
      expect(stateRes.ok).toBe(true)

      const sourceId = uniqueId('src_')
      const source = buildSource({ id: sourceId, name: 'P06 订阅', url: subServer.urlFor('main') })
      expect(
        (await harness.apiPost('/api/probe', { kind: 'source', id: sourceId, url: source.url }, { profile: profileId }))
          .ok,
      ).toBe(true)

      const group = buildProxyGroup({
        name: 'Eval-Scheduled-Group',
        qualityDeviceId: v4Dev.id,
        members: [
          buildPoolMember({
            sourceIds: [sourceId],
            quality: buildQualityCondition({
              alive: true,
              fallbackWhenEmpty: false,
            }),
          }),
        ],
      })

      const draftSaveRes = await harness.apiPost<StateResponse>(
        '/api/draft',
        {
          revision: stateRes.data.revision,
          draft: buildDraft({
            ...stateRes.data.draft,
            sources: [source],
            groups: [group],
          }),
        },
        { profile: profileId },
      )
      expect(draftSaveRes.status).toBe(200)

      // Verify schedule targeting online legacy v3 probe fails with 409 on schedule/run & skips with device_incompatible on due
      const legacySchedRes = await harness.apiPost<QualityScheduleConfig>(
        '/api/quality/schedule',
        buildQualitySchedule({
          targetDeviceId: onlineLegacyDev.id,
          basic: {
            enabled: true,
            intervalMinutes: 60,
            rounds: 2,
            concurrency: 4,
            bandwidth: false,
            lastRunAt: null,
            lastJobId: null,
          },
        }),
        { profile: profileId },
      )
      expect(legacySchedRes.status).toBe(200)

      const legacyRunBasic = await harness.apiPost(
        '/api/quality/schedule/run',
        { kind: 'basic' },
        { profile: profileId },
      )
      expect(legacyRunBasic.status).toBe(409)

      const legacyRunDue = await harness.apiPost<ScheduleRunResponse>(
        '/api/quality/schedule/run',
        { kind: 'due' },
        { profile: profileId },
      )
      expect(legacyRunDue.status).toBe(200)
      expect(legacyRunDue.data.jobs).toHaveLength(0)
      expect(legacyRunDue.data.skipped.some(s => s.kind === 'basic' && s.reason === 'device_incompatible')).toBe(true)

      // (F6,F7): Run initial basic check where both nodes pass, then publish manually
      const nodesRes = await harness.apiGet<SourceNodesResponse>(
        `/api/source-nodes?id=${encodeURIComponent(sourceId)}`,
        { profile: profileId },
      )
      const keys = (nodesRes.data.good?.nodes ?? []).map(n => `${sourceId}/${n.id}`)
      expect(keys).toHaveLength(2)

      expect(
        (
          await harness.apiPost(
            '/api/quality/queue',
            { targetDeviceId: v4Dev.id, keys, config: basicOnlyConfig({ rounds: 2 }) },
            { profile: profileId },
          )
        ).status,
      ).toBe(200)
      const initRun = await v4Probe.pollAndComplete(() => ({ latencyMs: 55 }))
      expect(initRun.completeResponse?.status).toBe(200)

      const prePubState = await harness.apiGet<StateResponse>('/api/state', { profile: profileId })
      const pubRes = await harness.apiPost<StateResponse>(
        '/api/publish',
        { revision: prePubState.data.revision },
        { profile: profileId },
      )
      expect(pubRes.status).toBe(200)

      const linkRes = await harness.apiPost<LinkResponse>('/api/link', { action: 'rotate' }, { profile: profileId })
      expect(linkRes.status).toBe(200)
      assert.ok(linkRes.data.url)

      const v2Sub = await harness.subGet(linkRes.data.url)
      expect(v2Sub.status).toBe(200)
      assertYamlGroupExactOrder(parseMihomoYaml(v2Sub.text), 'Eval-Scheduled-Group', ['🇺🇸 US-Fast', '🇯🇵 JP-Slow'])

      // Save schedule targeting v4Dev (`lastRunAt: null` -> immediately due on triggerTick)
      const v4SchedRes = await harness.apiPost<QualityScheduleConfig>(
        '/api/quality/schedule',
        buildQualitySchedule({
          targetDeviceId: v4Dev.id,
          scope: 'kept',
          autoRefreshGroups: true,
          basic: {
            enabled: true,
            intervalMinutes: 60,
            rounds: 2,
            concurrency: 4,
            bandwidth: false,
            lastRunAt: null,
            lastJobId: null,
          },
        }),
        { profile: profileId },
      )
      expect(v4SchedRes.status).toBe(200)

      await harness.triggerTick()

      // Complete scheduled basic run where JP-Slow fails
      const schedRun = await v4Probe.pollAndComplete((node: QualityNode) => {
        if (node.name.includes('JP-Slow')) return { available: false }
        return { latencyMs: 42 }
      })
      assert.ok(schedRun.assignment, 'Expected workspace.tick() to enqueue scheduled basic job for v4 probe')
      expect(schedRun.assignment.config.basic).toBe(true)
      expect(schedRun.completeResponse?.status).toBe(200)

      // Schedule metadata updated with lastRunAt & lastJobId
      const postSched = await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule', { profile: profileId })
      expect(postSched.status).toBe(200)
      expect(postSched.data.basic.lastRunAt).not.toBeNull()
      expect(postSched.data.basic.lastJobId).toBe(schedRun.assignment.jobId)

      // Auto-published version created cleanly without legacy snapshot/pinning fields
      const historyRes = await harness.apiGet<VersionSummary[]>('/api/history', { profile: profileId })
      expect(historyRes.status).toBe(200)
      const latestVer = historyRes.data[0]
      assert.ok(latestVer)
      expect(latestVer.seq).toBe(3)
      expect(latestVer.kind).toBe('auto')
      expect(latestVer.parent).toBe(2)

      const storedAutoVer = harness.readDbDoc<Record<string, unknown>>(
        `versions/${profileId}`,
        String(latestVer.seq).padStart(12, '0'),
      )
      expect(storedAutoVer).toBeDefined()
      assertNoLegacyAiStrings(storedAutoVer)
      expect(Object.hasOwn(storedAutoVer!, 'qualitySnapshot')).toBe(false)
      expect(Object.hasOwn(storedAutoVer!, 'qualityReportId')).toBe(false)

      // Subscription YAML now reflects only US-Fast
      const v3Sub = await harness.subGet(linkRes.data.url)
      expect(v3Sub.status).toBe(200)
      const v3Yaml = parseMihomoYaml(v3Sub.text)
      assertNoLegacyAiStrings(v3Yaml)
      assertYamlGroupExactOrder(v3Yaml, 'Eval-Scheduled-Group', ['🇺🇸 US-Fast'])
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
