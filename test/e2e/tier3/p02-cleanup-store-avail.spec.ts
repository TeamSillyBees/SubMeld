import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  aiPresets,
  createMockProbe,
  parseInviteLink,
  type QualityNode,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  aiOnlyConfig,
  assertAvailabilityStats,
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  basicOnlyConfig,
  buildDraft,
  buildInfoProxy,
  buildLegacyPreR1Documents,
  buildProxyNode,
  buildSource,
  uniqueId,
  unwrapLatestForDevice,
  type LatestNodeQuality,
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
  status: string
}

test.describe('T3-P02 Legacy Cleanup, Per-Probe Latest Store & Multi-Check Availability (F2, F4, F5)', () => {
  test('T3-P02-01 (F2,F4,F5): cleaned legacy workspace starts with empty quality-latest, accumulates 4 basic checks into rolling availability, and preserves stats on AI-only run', async () => {
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
            buildProxyNode('🇺🇸 US-Node-A', { server: 'us-a.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-Node-B', { server: 'jp-b.example.net', port: 10002 }),
            buildInfoProxy('剩余流量：500 GB'),
          ],
        },
      })

      harness = await startAppHarness({
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

      // (F2,F4): Legacy snapshot fields are stripped and quality-latest starts clean
      const storedProfile = harness.readDbDoc<Record<string, unknown>>('profiles', profileId)
      expect(storedProfile).toBeDefined()
      assertNoLegacyAiStrings(storedProfile)
      expect(Object.hasOwn(storedProfile!, 'fixedQualitySnapshot')).toBe(false)
      expect(Object.hasOwn((storedProfile!.draft as Record<string, unknown>) ?? {}, 'qualityBaselinePolicy')).toBe(false)

      const storedVersion = harness.readDbDoc<Record<string, unknown>>(`versions/${profileId}`, '000000000001')
      expect(storedVersion).toBeDefined()
      expect(Object.hasOwn(storedVersion!, 'qualitySnapshot')).toBe(false)
      expect(Object.hasOwn(storedVersion!, 'qualityReportId')).toBe(false)
      expect(harness.readDbDoc(`quality-device/${profileId}`, 'registration')).toBeUndefined()
      expect(harness.readDbDoc(`quality-device/${profileId}`, 'next')).toBeUndefined()

      const initialLatest = await harness.apiGet<Record<string, unknown>>('/api/quality/latest', { profile: profileId })
      expect(initialLatest.status).toBe(200)
      expect(initialLatest.data).toEqual({})
      expect(harness.listDbSpace(`quality-latest/${profileId}`)).toEqual([])

      // Add live subscription source and pair v4 (2.0.0) probe
      const stateRes = await harness.apiGet<StateResponse>('/api/state', { profile: profileId })
      expect(stateRes.ok).toBe(true)

      const liveSourceId = uniqueId('src_')
      const liveSource = buildSource({
        id: liveSourceId,
        name: 'P02 实时订阅',
        url: subServer.urlFor('main'),
      })
      expect(
        (
          await harness.apiPost(
            '/api/probe',
            { kind: 'source', id: liveSource.id, url: liveSource.url },
            { profile: profileId },
          )
        ).ok,
      ).toBe(true)

      const saveRes = await harness.apiPost(
        '/api/draft',
        {
          revision: stateRes.data.revision,
          draft: buildDraft({
            ...stateRes.data.draft,
            sources: [liveSource],
            groups: [],
          }),
        },
        { profile: profileId },
      )
      expect(saveRes.ok).toBe(true)

      const nodesRes = await harness.apiGet<SourceNodesResponse>(
        `/api/source-nodes?id=${encodeURIComponent(liveSource.id)}`,
        { profile: profileId },
      )
      expect(nodesRes.ok).toBe(true)
      const nodes = nodesRes.data.good?.nodes ?? []
      expect(nodes).toHaveLength(3)

      const usKey = `${liveSource.id}/${nodes.find(n => n.name.includes('US-Node-A'))!.id}`
      const jpKey = `${liveSource.id}/${nodes.find(n => n.name.includes('JP-Node-B'))!.id}`
      const infoKey = `${liveSource.id}/${nodes.find(n => n.name.includes('剩余流量'))!.id}`
      const keys = [usKey, jpKey, infoKey]

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {}, { profile: profileId })
      expect(inviteRes.status).toBe(200)
      const parsed = parseInviteLink(inviteRes.data.pairing)
      const probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsed.profileId,
        name: 'P02-V4-Probe',
      })
      expect((await probe.enroll(parsed.ticket)).status).toBe(200)

      const devicesRes = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices', { profile: profileId })
      const v4Device = devicesRes.data.find(d => d.name === 'P02-V4-Probe')
      assert.ok(v4Device)

      // (F4,F5): Run 4 basicOnly checks:
      // US-Node-A: [true, true, true, false] -> 3/4 = 0.75 (latest basic.available === false)
      // JP-Node-B: [true, true, true, true]  -> 4/4 = 1.00
      // Info node: info_node -> availability remains null
      const usOutcomes = [true, true, true, false] as const
      for (let roundIdx = 0; roundIdx < usOutcomes.length; roundIdx++) {
        const queueRes = await harness.apiPost(
          '/api/quality/queue',
          { targetDeviceId: v4Device.id, keys, config: basicOnlyConfig({ rounds: 2 }) },
          { profile: profileId },
        )
        expect(queueRes.status).toBe(200)

        const usAvailable = usOutcomes[roundIdx]
        const run = await probe.pollAndComplete((node: QualityNode) => {
          if (node.key === usKey) {
            return usAvailable ? { latencyMs: 70 + roundIdx } : { available: false }
          }
          if (node.key === jpKey) {
            return { latencyMs: 45 + roundIdx }
          }
          return {}
        })
        expect(run.completeResponse?.status).toBe(200)
      }

      const afterBasicRes = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(v4Device.id)}`,
        { profile: profileId },
      )
      expect(afterBasicRes.status).toBe(200)
      const latestAfterBasic = unwrapLatestForDevice(afterBasicRes.data, v4Device.id)

      assertAvailabilityStats(latestAfterBasic[usKey]?.availability, 3, 4)
      expect(latestAfterBasic[usKey]?.availability?.window).toEqual([true, true, true, false])
      expect(latestAfterBasic[usKey]?.basic?.available).toBe(false)
      expect(latestAfterBasic[usKey]?.ai).toBeNull()

      assertAvailabilityStats(latestAfterBasic[jpKey]?.availability, 4, 4)
      expect(latestAfterBasic[jpKey]?.basic?.available).toBe(true)

      expect(latestAfterBasic[infoKey]?.basic?.infoNode).toBe(true)
      expect(latestAfterBasic[infoKey]?.availability).toBeNull()

      // (F4,F5) + (F2,F5): Run standalone AI-only check and verify availability window & basic metrics are preserved
      const aiQueueRes = await harness.apiPost(
        '/api/quality/queue',
        { targetDeviceId: v4Device.id, keys, config: aiOnlyConfig() },
        { profile: profileId },
      )
      expect(aiQueueRes.status).toBe(200)

      const aiRun = await probe.pollAndComplete((node: QualityNode) => {
        if (node.key === usKey) return { exit: { ip: '198.51.100.31', region: 'US' }, ai: aiPresets.allGreen('US') }
        if (node.key === jpKey) return { exit: { ip: '198.51.100.32', region: 'JP' }, ai: aiPresets.mixed('JP') }
        return {}
      })
      expect(aiRun.completeResponse?.status).toBe(200)

      const afterAiRes = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(v4Device.id)}`,
        { profile: profileId },
      )
      expect(afterAiRes.status).toBe(200)
      assertNoLegacyAiStrings(afterAiRes.data)
      const latestAfterAi = unwrapLatestForDevice(afterAiRes.data, v4Device.id)

      // Availability & basic preserved verbatim across AI-only check
      assertAvailabilityStats(latestAfterAi[usKey]?.availability, 3, 4)
      expect(latestAfterAi[usKey]?.availability?.window).toEqual([true, true, true, false])
      expect(latestAfterAi[usKey]?.basic?.available).toBe(false)
      assertThreeSurfaceAi(latestAfterAi[usKey]?.ai?.results)

      assertAvailabilityStats(latestAfterAi[jpKey]?.availability, 4, 4)
      expect(latestAfterAi[jpKey]?.basic?.httpsMs).toBe(latestAfterBasic[jpKey]?.basic?.httpsMs)
      assertThreeSurfaceAi(latestAfterAi[jpKey]?.ai?.results)

      expect(latestAfterAi[infoKey]?.availability).toBeNull()
      expect(latestAfterAi[infoKey]?.ai).toBeNull()

      // Confirm profiles & versions remain clean of legacy snapshot/pinning fields after runs
      const profilePostRun = harness.readDbDoc<Record<string, unknown>>('profiles', profileId)
      assertNoLegacyAiStrings(profilePostRun)
      expect(Object.hasOwn(profilePostRun!, 'fixedQualitySnapshot')).toBe(false)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T3-P02-02 (F4,F5): rolling window caps at 20 basic checks per probe and isolates stats between two v4 probes', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      subServer = await startMockSubServer({
        main: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇸🇬 SG-Rolling-01', { server: 'sg-roll.example.net', port: 10001 }),
          ],
        },
      })
      harness = await startAppHarness()

      const sourceId = uniqueId('src_')
      const source = buildSource({ id: sourceId, name: 'Rolling Source', url: subServer.urlFor('main') })
      const stateRes = await harness.apiGet<StateResponse>('/api/state')
      expect(stateRes.ok).toBe(true)
      expect((await harness.apiPost('/api/probe', { kind: 'source', id: sourceId, url: source.url })).ok).toBe(true)
      expect(
        (
          await harness.apiPost('/api/draft', {
            revision: stateRes.data.revision,
            draft: buildDraft({ ...stateRes.data.draft, sources: [source] }),
          })
        ).ok,
      ).toBe(true)

      const nodesRes = await harness.apiGet<SourceNodesResponse>(`/api/source-nodes?id=${encodeURIComponent(sourceId)}`)
      const nodeKey = `${sourceId}/${nodesRes.data.good!.nodes[0].id}`

      // Pair Probe A and Probe B
      const inviteA = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const parsedA = parseInviteLink(inviteA.data.pairing)
      const probeA = createMockProbe({ origin: harness.baseUrl, profileId: parsedA.profileId, name: 'Probe-A' })
      expect((await probeA.enroll(parsedA.ticket)).status).toBe(200)

      const inviteB = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const parsedB = parseInviteLink(inviteB.data.pairing)
      const probeB = createMockProbe({ origin: harness.baseUrl, profileId: parsedB.profileId, name: 'Probe-B' })
      expect((await probeB.enroll(parsedB.ticket)).status).toBe(200)

      const devicesRes = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices')
      const devA = devicesRes.data.find(d => d.name === 'Probe-A')!
      const devB = devicesRes.data.find(d => d.name === 'Probe-B')!

      // Run 25 basic checks on Probe A: first 5 fail, next 20 pass -> 20-cap window evicts 5 fails -> 20/20 = 1.0
      for (let i = 0; i < 25; i++) {
        const qRes = await harness.apiPost('/api/quality/queue', {
          targetDeviceId: devA.id,
          keys: [nodeKey],
          config: basicOnlyConfig({ rounds: 2 }),
        })
        expect(qRes.status).toBe(200)
        const run = await probeA.pollAndComplete(() => (i < 5 ? { available: false } : { latencyMs: 40 }))
        expect(run.completeResponse?.status).toBe(200)
      }

      // Run 2 basic checks on Probe B: 1 pass, 1 fail -> 1/2 = 0.5
      for (const pass of [true, false]) {
        const qRes = await harness.apiPost('/api/quality/queue', {
          targetDeviceId: devB.id,
          keys: [nodeKey],
          config: basicOnlyConfig({ rounds: 2 }),
        })
        expect(qRes.status).toBe(200)
        const run = await probeB.pollAndComplete(() => (pass ? { latencyMs: 80 } : { available: false }))
        expect(run.completeResponse?.status).toBe(200)
      }

      const latestARes = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(devA.id)}`,
      )
      const latestBRes = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(devB.id)}`,
      )
      const latestA = unwrapLatestForDevice(latestARes.data, devA.id)
      const latestB = unwrapLatestForDevice(latestBRes.data, devB.id)

      assertAvailabilityStats(latestA[nodeKey]?.availability, 20, 20)
      assertAvailabilityStats(latestB[nodeKey]?.availability, 1, 2)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
