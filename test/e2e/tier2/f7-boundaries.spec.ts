import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertYamlGroupExactOrder,
  basicOnlyConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildQualitySchedule,
  buildSource,
  parseMihomoYaml,
  uniqueId,
  type DraftConfig,
  type QualityScheduleConfig,
} from '../helpers/fixtures.ts'
import {
  buildAgentReport,
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  expectNoHorizontalOverflow,
  navigateToHash,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface WorkspaceStateResponse {
  id: string
  revision: number
  draft: DraftConfig
  sources: Record<
    string,
    {
      good: {
        nodes: Array<{ id: string; name: string; region: string }>
      } | null
    }
  >
}

interface ProbeDeviceItem {
  id: string
  name: string
  offline?: boolean
}

interface QualityJobItem {
  id: string
  status: string
  targetDeviceId?: string | null
  trigger?: 'manual' | 'schedule'
  scheduleKind?: 'basic' | 'ai'
  config: {
    basic?: boolean
    ai: boolean
    bandwidth: boolean
  }
}

interface ScheduleRunResponse {
  jobs: QualityJobItem[]
  skipped: Array<{ kind: 'basic' | 'ai'; reason: string }>
  schedule: QualityScheduleConfig
}

interface HistoryVersionItem {
  seq: number
  kind: 'publish' | 'auto' | 'rollback'
  parent: number | null
}

async function pairMockProbe(
  harness: AppHarness,
  name: string,
): Promise<{ probe: MockProbeAgent; deviceId: string }> {
  const invite = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  expect(invite.status).toBe(200)
  const parsed = parseInviteLink(invite.data.pairing)
  const probe = createMockProbe({
    origin: harness.baseUrl,
    profileId: parsed.profileId,
    name,
  })
  const enrollRes = await probe.enroll(parsed.ticket)
  expect(enrollRes.status).toBe(200)
  const devicesRes = await harness.apiGet<ProbeDeviceItem[]>('/api/quality/devices')
  expect(devicesRes.status).toBe(200)
  const device = devicesRes.data.find(d => d.name === name)
  expect(device).toBeDefined()
  return { probe, deviceId: device!.id }
}

async function seedSourceAndDraft(
  harness: AppHarness,
  subServer: MockSubServer,
  feedId: string,
  nodes: ReturnType<typeof buildProxyNode>[],
  buildGroups?: (srcId: string, draft: DraftConfig) => DraftConfig['groups'],
): Promise<{ state: WorkspaceStateResponse; sourceId: string; nodeKeys: string[]; nodeNames: string[] }> {
  subServer.setFeed(feedId, { format: 'yaml', nodes })
  const initial = await harness.apiGet<WorkspaceStateResponse>('/api/state')
  expect(initial.status).toBe(200)
  const sourceId = uniqueId('src_')
  const srcUrl = subServer.urlFor(feedId)
  const probeRes = await harness.apiPost('/api/probe', { kind: 'source', id: sourceId, url: srcUrl })
  expect(probeRes.status).toBe(200)

  const src = buildSource({ id: sourceId, name: `F7源-${feedId}`, url: srcUrl })
  const draft = buildDraft({
    ...initial.data.draft,
    sources: [src],
  })
  if (buildGroups) {
    draft.groups = buildGroups(sourceId, draft)
  }
  const saved = await harness.apiPost<WorkspaceStateResponse>('/api/draft', {
    revision: initial.data.revision,
    draft,
  })
  expect(saved.status).toBe(200)
  const storedNodes = saved.data.sources[sourceId]?.good?.nodes ?? []
  expect(storedNodes.length).toBe(nodes.length)
  return {
    state: saved.data,
    sourceId,
    nodeKeys: storedNodes.map(n => `${sourceId}/${n.id}`),
    nodeNames: storedNodes.map(n => n.name),
  }
}

test.describe('Tier 2 F7 — Quality Scheduler & Dynamic Group Sync Boundaries', () => {
  let harness: AppHarness | undefined
  let subServer: MockSubServer | undefined

  test.afterEach(async () => {
    await subServer?.close()
    subServer = undefined
    await harness?.close()
    harness = undefined
  })

  test('T2-F7-01 rejects invalid schedule payloads and unknown targetDeviceId with 400/404', async () => {
    harness = await startAppHarness()
    const { deviceId } = await pairMockProbe(harness, 'F7-Validator-Probe')

    const initialGet = await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')
    expect(initialGet.status).toBe(200)
    expect(initialGet.data.targetDeviceId).toBeNull()
    expect(initialGet.data.scope).toBe('kept')
    expect(initialGet.data.autoRefreshGroups).toBe(true)

    const baseValid = buildQualitySchedule({
      targetDeviceId: deviceId,
      basic: {
        enabled: true,
        intervalMinutes: 60,
        rounds: 3,
        concurrency: 6,
        bandwidth: false,
        lastRunAt: null,
        lastJobId: null,
      },
      ai: {
        enabled: true,
        intervalMinutes: 180,
        concurrency: 6,
        lastRunAt: null,
        lastJobId: null,
      },
    })

    const badPayloads: Array<{ label: string; payload: unknown }> = [
      {
        label: 'basic.intervalMinutes = 0',
        payload: { ...baseValid, basic: { ...baseValid.basic, intervalMinutes: 0 } },
      },
      {
        label: 'basic.intervalMinutes = -1',
        payload: { ...baseValid, basic: { ...baseValid.basic, intervalMinutes: -1 } },
      },
      {
        label: 'basic.intervalMinutes = 43201 (above max 43200)',
        payload: { ...baseValid, basic: { ...baseValid.basic, intervalMinutes: 43201 } },
      },
      {
        label: 'basic.intervalMinutes = 1.5 (non-integer)',
        payload: { ...baseValid, basic: { ...baseValid.basic, intervalMinutes: 1.5 } },
      },
      {
        label: 'ai.intervalMinutes = 0',
        payload: { ...baseValid, ai: { ...baseValid.ai, intervalMinutes: 0 } },
      },
      {
        label: 'basic.rounds = 1 (below min 2)',
        payload: { ...baseValid, basic: { ...baseValid.basic, rounds: 1 } },
      },
      {
        label: 'basic.concurrency = 13 (above max 12)',
        payload: { ...baseValid, basic: { ...baseValid.basic, concurrency: 13 } },
      },
      {
        label: 'scope = invalid',
        payload: { ...baseValid, scope: 'invalid' },
      },
      {
        label: 'targetDeviceId non-UUID',
        payload: { ...baseValid, targetDeviceId: 'not-a-uuid' },
      },
      {
        label: 'extra strictObject key',
        payload: { ...baseValid, unexpectedExtraKey: true },
      },
    ]

    for (const item of badPayloads) {
      const res = await harness.apiPost('/api/quality/schedule', item.payload)
      expect(res.status, `Expected 400 for ${item.label}`).toBe(400)
    }

    const unknownUuidRes = await harness.apiPost('/api/quality/schedule', {
      ...baseValid,
      targetDeviceId: randomUUID(),
    })
    expect(unknownUuidRes.status).toBe(404)

    const badRunKind = await harness.apiPost('/api/quality/schedule/run', { kind: 'invalid' })
    expect(badRunKind.status).toBe(400)

    const badRunExtra = await harness.apiPost('/api/quality/schedule/run', { kind: 'basic', extra: true })
    expect(badRunExtra.status).toBe(400)

    const afterGet = await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')
    expect(afterGet.status).toBe(200)
    expect(afterGet.data).toEqual(initialGet.data)
  })

  test('T2-F7-02 deduplicates pending/running scheduled jobs and avoids duplicate queue entries', async () => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const { probe, deviceId } = await pairMockProbe(harness, 'F7-Dedup-Probe')
    await seedSourceAndDraft(harness, subServer, 'dedup', [
      buildProxyNode('🇺🇸 US-01', { server: 'us-01.example.net', port: 10101 }),
      buildProxyNode('🇯🇵 JP-01', { server: 'jp-01.example.net', port: 10102 }),
    ])

    const saveRes = await harness.apiPost<QualityScheduleConfig>(
      '/api/quality/schedule',
      buildQualitySchedule({
        targetDeviceId: deviceId,
        basic: {
          enabled: true,
          intervalMinutes: 60,
          rounds: 2,
          concurrency: 4,
          bandwidth: false,
          lastRunAt: null,
          lastJobId: null,
        },
        ai: {
          enabled: true,
          intervalMinutes: 120,
          concurrency: 4,
          lastRunAt: null,
          lastJobId: null,
        },
      }),
    )
    expect(saveRes.status).toBe(200)

    await harness.triggerTick()

    const jobsAfterTick = await harness.apiGet<QualityJobItem[]>('/api/quality/jobs')
    expect(jobsAfterTick.status).toBe(200)
    expect(jobsAfterTick.data).toHaveLength(2)
    expect(jobsAfterTick.data.filter(j => j.scheduleKind === 'basic' && j.status === 'waiting')).toHaveLength(1)
    expect(jobsAfterTick.data.filter(j => j.scheduleKind === 'ai' && j.status === 'waiting')).toHaveLength(1)

    const dueAgain = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'due' })
    expect(dueAgain.status).toBe(200)
    expect(dueAgain.data.jobs).toEqual([])
    expect(dueAgain.data.skipped).toEqual(
      expect.arrayContaining([
        { kind: 'basic', reason: 'not_due' },
        { kind: 'ai', reason: 'not_due' },
      ]),
    )

    await harness.triggerTick()
    const jobsAfterSecondTick = await harness.apiGet<QualityJobItem[]>('/api/quality/jobs')
    expect(jobsAfterSecondTick.data).toHaveLength(2)

    const dupBasic = await harness.apiPost('/api/quality/schedule/run', { kind: 'basic' })
    expect(dupBasic.status).toBe(409)

    const dupAi = await harness.apiPost('/api/quality/schedule/run', { kind: 'ai' })
    expect(dupAi.status).toBe(409)

    // Claim the basic job (moves to running), verify running still deduplicates, then complete it.
    const claimed = await probe.poll({ wait: false })
    expect(claimed.status).toBe(200)
    expect(claimed.body).not.toBeNull()
    if (!claimed.body || !('jobId' in claimed.body)) {
      throw new Error('Expected Assignment payload from probe.poll()')
    }
    const assignment = claimed.body
    expect(assignment.config.basic).toBe(true)
    expect(assignment.config.ai).toBe(false)

    const jobsWhileRunning = await harness.apiGet<QualityJobItem[]>('/api/quality/jobs')
    expect(jobsWhileRunning.status).toBe(200)
    expect(jobsWhileRunning.data.find(j => j.id === assignment.jobId)?.status).toBe('running')

    const dupBasicWhileRunning = await harness.apiPost('/api/quality/schedule/run', { kind: 'basic' })
    expect(dupBasicWhileRunning.status).toBe(409)

    const dueWhileRunning = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'due' })
    expect(dueWhileRunning.status).toBe(200)
    expect(dueWhileRunning.data.jobs).toEqual([])

    const completeRes = await probe.complete(assignment.jobId, buildAgentReport(assignment))
    expect(completeRes.status).toBe(200)

    // AI job is still waiting -> running AI again must still be rejected with 409
    const stillDupAi = await harness.apiPost('/api/quality/schedule/run', { kind: 'ai' })
    expect(stillDupAi.status).toBe(409)

    // Basic job completed -> manual trigger for basic now succeeds (200) without affecting waiting AI job
    const nextBasic = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'basic' })
    expect(nextBasic.status).toBe(200)
    expect(nextBasic.data.jobs).toHaveLength(1)

    const jobsFinal = await harness.apiGet<QualityJobItem[]>('/api/quality/jobs')
    expect(jobsFinal.data.filter(j => j.status === 'waiting')).toHaveLength(2)
  })

  test('T2-F7-03 handles offline and revoked target probe gracefully on schedule/run and tick()', async () => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const { probe, deviceId } = await pairMockProbe(harness, 'F7-Lifecycle-Probe')
    await seedSourceAndDraft(harness, subServer, 'offline', [
      buildProxyNode('🇺🇸 US-01', { server: 'us-01.example.net', port: 10201 }),
    ])

    const saveRes = await harness.apiPost<QualityScheduleConfig>(
      '/api/quality/schedule',
      buildQualitySchedule({
        targetDeviceId: deviceId,
        basic: {
          enabled: true,
          intervalMinutes: 60,
          rounds: 2,
          concurrency: 4,
          bandwidth: false,
          lastRunAt: null,
          lastJobId: null,
        },
        ai: {
          enabled: true,
          intervalMinutes: 60,
          concurrency: 4,
          lastRunAt: null,
          lastJobId: null,
        },
      }),
    )
    expect(saveRes.status).toBe(200)

    const offRes = await probe.offline()
    expect(offRes.status).toBe(200)

    const runBasicOffline = await harness.apiPost('/api/quality/schedule/run', { kind: 'basic' })
    expect(runBasicOffline.status).toBe(409)

    const runAiOffline = await harness.apiPost('/api/quality/schedule/run', { kind: 'ai' })
    expect(runAiOffline.status).toBe(409)

    const runDueOffline = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'due' })
    expect(runDueOffline.status).toBe(200)
    expect(runDueOffline.data.jobs).toEqual([])
    expect(runDueOffline.data.skipped).toEqual(
      expect.arrayContaining([
        { kind: 'basic', reason: 'device_offline' },
        { kind: 'ai', reason: 'device_offline' },
      ]),
    )

    await harness.triggerTick()
    const jobsWhileOffline = await harness.apiGet<QualityJobItem[]>('/api/quality/jobs')
    expect(jobsWhileOffline.data).toEqual([])

    const revokeRes = await harness.apiPost('/api/quality/revoke', { id: deviceId })
    expect(revokeRes.status).toBe(200)

    const scheduleAfterRevoke = await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')
    expect(scheduleAfterRevoke.status).toBe(200)
    expect(scheduleAfterRevoke.data.targetDeviceId).toBeNull()

    const runBasicNoDevice = await harness.apiPost('/api/quality/schedule/run', { kind: 'basic' })
    expect(runBasicNoDevice.status).toBe(422)

    const runDueNoDevice = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'due' })
    expect(runDueNoDevice.status).toBe(200)
    expect(runDueNoDevice.data.jobs).toEqual([])
    expect(runDueNoDevice.data.skipped).toEqual(
      expect.arrayContaining([
        { kind: 'basic', reason: 'no_device' },
        { kind: 'ai', reason: 'no_device' },
      ]),
    )

    await harness.triggerTick()
    const jobsAfterRevoke = await harness.apiGet<QualityJobItem[]>('/api/quality/jobs')
    expect(jobsAfterRevoke.data).toEqual([])
  })

  test('T2-F7-04 suppresses spurious auto version when autoRefreshGroups is false or YAML is unchanged', async () => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const { probe, deviceId } = await pairMockProbe(harness, 'F7-AutoRefresh-Probe')

    const { state, nodeKeys, nodeNames } = await seedSourceAndDraft(
      harness,
      subServer,
      'autorefresh',
      [
        buildProxyNode('🇺🇸 US-Fast', { server: 'us-fast.example.net', port: 10301 }),
        buildProxyNode('🇯🇵 JP-Slow', { server: 'jp-slow.example.net', port: 10302 }),
      ],
      srcId => [
        buildProxyGroup({
          id: uniqueId('grp_'),
          name: 'AutoSyncGroup',
          type: 'select',
          qualityDeviceId: deviceId,
          members: [
            buildPoolMember({
              sourceIds: [srcId],
              quality: buildQualityCondition({ maxLatencyMs: 200 }),
            }),
          ],
        }),
      ],
    )

    const [usKey, jpKey] = nodeKeys
    const [usName, jpName] = nodeNames

    // Initial manual probe: US-Fast passes (50ms), JP-Slow fails latency (300ms)
    const initQueue = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicOnlyConfig({ rounds: 2 }),
    })
    expect(initQueue.status).toBe(200)
    const initDone = await probe.pollAndComplete(node =>
      node.key === usKey ? { latencyMs: 50 } : { latencyMs: 300 },
    )
    expect(initDone.completeResponse?.status).toBe(200)

    const publishRes = await harness.apiPost('/api/publish', { revision: state.revision })
    expect(publishRes.status).toBe(200)

    const linkRes = await harness.apiGet<{ url: string }>('/api/link')
    expect(linkRes.status).toBe(200)
    const initialSub = await harness.subGet(linkRes.data.url)
    expect(initialSub.status).toBe(200)
    assertYamlGroupExactOrder(parseMihomoYaml(initialSub.text), 'AutoSyncGroup', [usName])

    // Step 1: autoRefreshGroups = false — even if both nodes pass (which would alter YAML), no auto version is published
    const disableAutoRes = await harness.apiPost<QualityScheduleConfig>(
      '/api/quality/schedule',
      buildQualitySchedule({
        targetDeviceId: deviceId,
        autoRefreshGroups: false,
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
    )
    expect(disableAutoRes.status).toBe(200)

    const runDisabled = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'basic' })
    expect(runDisabled.status).toBe(200)
    const doneDisabled = await probe.pollAndComplete(() => ({ latencyMs: 45 }))
    expect(doneDisabled.completeResponse?.status).toBe(200)

    const historyAfterDisabled = await harness.apiGet<HistoryVersionItem[]>('/api/history')
    expect(historyAfterDisabled.status).toBe(200)
    expect(historyAfterDisabled.data).toHaveLength(1)
    expect(historyAfterDisabled.data[0].kind).toBe('publish')

    const subAfterDisabled = await harness.subGet(linkRes.data.url)
    assertYamlGroupExactOrder(parseMihomoYaml(subAfterDisabled.text), 'AutoSyncGroup', [usName])

    // Step 2: autoRefreshGroups = true, but YAML remains identical to active v1 ([usName]) -> still no auto version
    const enableAutoRes = await harness.apiPost<QualityScheduleConfig>(
      '/api/quality/schedule',
      buildQualitySchedule({
        targetDeviceId: deviceId,
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
    )
    expect(enableAutoRes.status).toBe(200)

    const runSameYaml = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'basic' })
    expect(runSameYaml.status).toBe(200)
    const doneSameYaml = await probe.pollAndComplete(node =>
      node.key === usKey ? { latencyMs: 55 } : { latencyMs: 310 },
    )
    expect(doneSameYaml.completeResponse?.status).toBe(200)

    const historyAfterSameYaml = await harness.apiGet<HistoryVersionItem[]>('/api/history')
    expect(historyAfterSameYaml.data).toHaveLength(1)

    // Step 3: autoRefreshGroups = true and YAML changes ([usName, jpName]) -> auto version v2 published!
    const runChangedYaml = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'basic' })
    expect(runChangedYaml.status).toBe(200)
    const doneChangedYaml = await probe.pollAndComplete(() => ({ latencyMs: 40 }))
    expect(doneChangedYaml.completeResponse?.status).toBe(200)

    const historyAfterChange = await harness.apiGet<HistoryVersionItem[]>('/api/history')
    expect(historyAfterChange.data).toHaveLength(2)
    expect(historyAfterChange.data[0]).toMatchObject({ seq: 2, kind: 'auto', parent: 1 })

    const subAfterChange = await harness.subGet(linkRes.data.url)
    assertYamlGroupExactOrder(parseMihomoYaml(subAfterChange.text), 'AutoSyncGroup', [usName, jpName])
  })

  test('T2-F7-05 falls back cleanly on invalid #/quality sub-routes without runtime or layout errors', async ({ page }) => {
    harness = await startAppHarness()
    const collector = attachErrorCollectors(page)
    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

    for (const invalidHash of [
      '#/quality/invalid-tab',
      '#/quality/%E4%B8%8D%E5%AD%98%E5%9C%A8',
      '#/quality/schedules/extra',
    ]) {
      await navigateToHash(page, harness.baseUrl, invalidHash, /质量检测/)
      const schedulesTab = page.getByRole('tab', { name: /定时任务/ })
      const reportsTab = page.getByRole('tab', { name: /检测报告/ })
      const probesTab = page.getByRole('tab', { name: /探针管理/ })
      await expect(schedulesTab).toBeVisible()
      await expect(reportsTab).toBeVisible()
      await expect(probesTab).toBeVisible()
      await expect(schedulesTab).toHaveAttribute('aria-selected', 'true')
      await expectNoHorizontalOverflow(page)
    }

    await page.getByRole('tab', { name: /检测报告/ }).click()
    await expect(page.getByRole('tab', { name: /检测报告/ })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: /探针管理/ }).click()
    await expect(page.getByRole('tab', { name: /探针管理/ })).toHaveAttribute('aria-selected', 'true')
    await expectNoHorizontalOverflow(page)

    collector.assertNoErrors()
  })
})
