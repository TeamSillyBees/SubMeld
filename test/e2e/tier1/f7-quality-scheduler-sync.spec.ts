import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  aiPresets,
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'
import {
  assertYamlGroupExactOrder,
  basicAndAiConfig,
  buildDraft,
  buildFilter,
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
import {
  attachErrorCollectors,
  configureQualitySchedule,
  expectNoHorizontalOverflow,
  openQualityPage,
  runAxeAudit,
  triggerScheduleRunButton,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface DraftStateResponse {
  id: string
  revision: number
  current: { seq: number; kind: string; parent: number | null } | null
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

interface QualityJobSummary {
  id: string
  status: string
  trigger?: 'manual' | 'schedule'
  scheduleKind?: 'basic' | 'ai'
  total: number
  config: {
    basic?: boolean
    ai: boolean
    bandwidth: boolean
    rounds: number
    concurrency: number
  }
}

interface ScheduleRunResponse {
  jobs: QualityJobSummary[]
  skipped: Array<{ kind: 'basic' | 'ai'; reason: string }>
  schedule: QualityScheduleConfig
}

async function setupSchedulerContext(
  nodeNames = ['Node-A', 'Node-B'],
  filter = buildFilter(),
) {
  const nodes = nodeNames.map((name, idx) =>
    buildProxyNode(name, { server: `sched-${idx}.example.net`, port: 10600 + idx }),
  )
  const subServer = await startMockSubServer({ feed1: { format: 'yaml', nodes } })
  const harness = await startAppHarness({ useRealCore: false })

  const state0 = await harness.apiGet<DraftStateResponse>('/api/state')
  assert.equal(state0.status, 200)

  const source = buildSource({
    id: uniqueId('src_'),
    name: '定时检测订阅源',
    url: subServer.urlFor('feed1'),
    filter,
  })
  const probeSrc = await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })
  assert.equal(probeSrc.status, 200)

  const draftRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
    revision: state0.data.revision,
    draft: buildDraft({ sources: [source] }),
  })
  assert.equal(draftRes.status, 200)

  const keys = (draftRes.data.sources[source.id]?.good?.nodes ?? []).map(n => ({
    key: `${source.id}/${n.id}`,
    name: n.name,
  }))

  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Probe-Sched' })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<Array<{ id: string }>>('/api/quality/devices')
  const deviceId = devicesRes.data[0]?.id
  assert.ok(deviceId)

  return {
    subServer,
    harness,
    profileId,
    revision: draftRes.data.revision,
    source,
    keys,
    probe,
    deviceId,
  }
}

test.describe('Tier 1 — F7: Quality Detection Scheduler & Dynamic Group Sync', () => {
  test('T1-F7-01 #/quality renders 定时任务/检测报告/探针管理 tabs, saves schedule UI, runs basic job & passes Axe', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupSchedulerContext()
      subServer = ctx.subServer
      harness = ctx.harness

      // Seed one completed report so the reports tab also has real data
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.keys.map(k => k.key),
        config: basicAndAiConfig(),
      })
      await ctx.probe.pollAndComplete(() => ({ latencyMs: 55, ai: aiPresets.allGreen('US') }))

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      await openQualityPage(page, harness.baseUrl)
      await expect(page.locator('#main-content h1').first()).toHaveText(/质量检测/)

      await openQualityPage(page, harness.baseUrl, 'reports')
      await openQualityPage(page, harness.baseUrl, 'probes')
      await openQualityPage(page, harness.baseUrl, 'schedules')
      await expect(page.getByText('正在读取定时检测配置…')).toBeHidden()
      await expect(page.getByRole('button', { name: /保存定时配置|保存设置/ }).first()).toBeVisible()

      await configureQualitySchedule(page, {
        probeName: /Probe-Sched/,
        scope: 'kept',
        autoRefreshGroups: true,
        basic: { enabled: true, intervalMinutes: 1440, bandwidth: false },
        ai: { enabled: true, intervalMinutes: 4320 },
      })

      await openQualityPage(page, harness.baseUrl, 'schedules')
      await expect(page.getByText('正在读取定时检测配置…')).toBeHidden()
      const savedSchedule = await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')
      assert.equal(savedSchedule.status, 200)
      assert.equal(savedSchedule.data.targetDeviceId, ctx.deviceId)
      assert.equal(savedSchedule.data.basic.enabled, true)
      assert.equal(savedSchedule.data.basic.intervalMinutes, 1440)
      assert.equal(savedSchedule.data.ai.enabled, true)
      assert.equal(savedSchedule.data.ai.intervalMinutes, 4320)

      await ctx.probe.poll({ wait: false })
      await triggerScheduleRunButton(page, 'basic')
      const completed = await ctx.probe.pollAndComplete(() => ({ latencyMs: 45 }))
      assert.equal(completed.completeResponse?.status, 200)

      await expectNoHorizontalOverflow(page)
      await runAxeAudit(page, 'Quality schedules tab desktop')
      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F7-02 GET/POST /api/quality/schedule persists configuration across server restarts', async () => {
    let subServer: MockSubServer | undefined
    let harness1: AppHarness | undefined
    let harness2: AppHarness | undefined

    try {
      const ctx = await setupSchedulerContext()
      subServer = ctx.subServer
      harness1 = ctx.harness

      const initialRes = await harness1.apiGet<QualityScheduleConfig>('/api/quality/schedule')
      assert.equal(initialRes.status, 200)
      assert.equal(initialRes.data.scope, 'kept')
      assert.equal(initialRes.data.autoRefreshGroups, true)
      assert.equal(initialRes.data.basic.intervalMinutes, 1440)
      assert.equal(initialRes.data.ai.intervalMinutes, 4320)

      const customSchedule = buildQualitySchedule({
        targetDeviceId: ctx.deviceId,
        scope: 'all',
        autoRefreshGroups: false,
        basic: {
          enabled: true,
          intervalMinutes: 360,
          rounds: 5,
          concurrency: 4,
          bandwidth: true,
          lastRunAt: null,
          lastJobId: null,
        },
        ai: {
          enabled: true,
          intervalMinutes: 2880,
          concurrency: 3,
          lastRunAt: null,
          lastJobId: null,
        },
      })

      const saveRes = await harness1.apiPost<QualityScheduleConfig>('/api/quality/schedule', customSchedule)
      assert.equal(saveRes.status, 200)
      assert.deepEqual(saveRes.data, customSchedule)

      const dbSchedule = harness1.readDbDoc<QualityScheduleConfig>(`quality-schedules/${ctx.profileId}`, 'config')
      assert.deepEqual(dbSchedule, customSchedule)

      const seedEntries: Array<readonly [string, string, unknown]> = []
      for (const space of [
        'profiles',
        `quality-devices/${ctx.profileId}`,
        `quality-schedules/${ctx.profileId}`,
      ]) {
        for (const row of harness1.listDbSpace(space)) {
          seedEntries.push([space, row.key, row.data])
        }
      }

      await harness1.close()
      harness1 = undefined

      harness2 = await startAppHarness({
        useRealCore: false,
        seedLegacy: (seeder) => {
          seeder.seedEntries(seedEntries)
        },
      })

      const afterRestartRes = await harness2.apiGet<QualityScheduleConfig>('/api/quality/schedule', {
        profile: ctx.profileId,
      })
      assert.equal(afterRestartRes.status, 200)
      assert.deepEqual(afterRestartRes.data, customSchedule)
    } finally {
      await harness1?.close()
      await harness2?.close()
      await subServer?.close()
    }
  })

  test('T1-F7-03 POST /api/quality/schedule/run dispatches basic and ai jobs with matching scope and QualityConfig', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupSchedulerContext(
        ['Node-Kept-1', 'Node-Kept-2', '试用-Excluded-3'],
        buildFilter({ keywords: ['试用'] }),
      )
      subServer = ctx.subServer
      harness = ctx.harness

      const schedulePayload = buildQualitySchedule({
        targetDeviceId: ctx.deviceId,
        scope: 'kept',
        basic: {
          enabled: false,
          intervalMinutes: 1440,
          rounds: 4,
          concurrency: 3,
          bandwidth: true,
          lastRunAt: null,
          lastJobId: null,
        },
        ai: {
          enabled: false,
          intervalMinutes: 4320,
          concurrency: 5,
          lastRunAt: null,
          lastJobId: null,
        },
      })
      const saveRes = await harness.apiPost('/api/quality/schedule', schedulePayload)
      assert.equal(saveRes.status, 200)

      await ctx.probe.poll({ wait: false })
      const runBasicRes = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'basic' })
      assert.equal(runBasicRes.status, 200)
      assert.equal(runBasicRes.data.jobs.length, 1)
      const basicJob = runBasicRes.data.jobs[0]
      assert.equal(basicJob.trigger, 'schedule')
      assert.equal(basicJob.scheduleKind, 'basic')
      assert.equal(basicJob.total, 2)
      assert.equal(basicJob.config.basic, true)
      assert.equal(basicJob.config.ai, false)
      assert.equal(basicJob.config.bandwidth, true)
      assert.equal(basicJob.config.rounds, 4)
      assert.equal(basicJob.config.concurrency, 3)

      const basicComplete = await ctx.probe.pollAndComplete(() => ({ latencyMs: 50, speedMbps: 90 }))
      assert.equal(basicComplete.completeResponse?.status, 200)

      await ctx.probe.poll({ wait: false })
      const runAiRes = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'ai' })
      assert.equal(runAiRes.status, 200)
      assert.equal(runAiRes.data.jobs.length, 1)
      const aiJob = runAiRes.data.jobs[0]
      assert.equal(aiJob.trigger, 'schedule')
      assert.equal(aiJob.scheduleKind, 'ai')
      assert.equal(aiJob.total, 2)
      assert.equal(aiJob.config.basic, false)
      assert.equal(aiJob.config.ai, true)
      assert.equal(aiJob.config.bandwidth, false)
      assert.equal(aiJob.config.concurrency, 5)

      const aiComplete = await ctx.probe.pollAndComplete(() => ({ exit: null, ai: aiPresets.allGreen('US') }))
      assert.equal(aiComplete.completeResponse?.status, 200)

      const scheduleAfter = await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')
      assert.equal(scheduleAfter.data.basic.lastJobId, basicJob.id)
      assert.ok(scheduleAfter.data.basic.lastRunAt)
      assert.equal(scheduleAfter.data.ai.lastJobId, aiJob.id)
      assert.ok(scheduleAfter.data.ai.lastRunAt)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F7-04 workspace.tick() triggers due schedules once and respects interval deduplication', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupSchedulerContext(['Node-A', 'Node-B'])
      subServer = ctx.subServer
      harness = ctx.harness

      await ctx.probe.poll({ wait: false })

      const schedulePayload = buildQualitySchedule({
        targetDeviceId: ctx.deviceId,
        scope: 'kept',
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
          intervalMinutes: 120,
          concurrency: 6,
          lastRunAt: null,
          lastJobId: null,
        },
      })
      const saveRes = await harness.apiPost('/api/quality/schedule', schedulePayload)
      assert.equal(saveRes.status, 200)

      await harness.triggerTick()

      const jobsAfterFirstTick = await harness.apiGet<QualityJobSummary[]>('/api/quality/jobs')
      assert.equal(jobsAfterFirstTick.status, 200)
      const scheduledJobs = jobsAfterFirstTick.data.filter(j => j.trigger === 'schedule')
      assert.equal(scheduledJobs.length, 2)
      assert.deepEqual(
        scheduledJobs.map(j => j.scheduleKind).sort(),
        ['ai', 'basic'],
      )

      const c1 = await ctx.probe.pollAndComplete((_n, _i) => ({ exit: null, ai: aiPresets.allGreen('US') }))
      assert.equal(c1.completeResponse?.status, 200)
      const c2 = await ctx.probe.pollAndComplete((_n, _i) => ({ exit: null, ai: aiPresets.allGreen('US') }))
      assert.equal(c2.completeResponse?.status, 200)

      const scheduleAfter = await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')
      assert.ok(scheduleAfter.data.basic.lastJobId)
      assert.ok(scheduleAfter.data.ai.lastJobId)

      await harness.triggerTick()
      const jobsAfterSecondTick = await harness.apiGet<QualityJobSummary[]>('/api/quality/jobs')
      assert.equal(jobsAfterSecondTick.data.length, 2)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F7-05 Scheduled job completion runs refreshQuality() and auto-publishes auto Version on YAML diff', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupSchedulerContext(['Node-A', 'Node-B'])
      subServer = ctx.subServer
      harness = ctx.harness

      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.keys.map(k => k.key),
        config: basicAndAiConfig(),
      })
      await ctx.probe.pollAndComplete(() => ({ latencyMs: 50, ai: aiPresets.allGreen('US') }))

      const group = buildProxyGroup({
        name: 'Auto-Sync-Group',
        qualityDeviceId: ctx.deviceId,
        members: [
          buildPoolMember({
            sourceIds: [ctx.source.id],
            quality: buildQualityCondition({ alive: true, aiAll: true }),
          }),
        ],
      })
      const saveDraftRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveDraftRes.status, 200)

      const pubRes = await harness.apiPost<DraftStateResponse>('/api/publish', {
        revision: saveDraftRes.data.revision,
      })
      assert.equal(pubRes.status, 200)
      assert.equal(pubRes.data.current?.seq, 1)

      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.ok(linkRes.data.url)
      const yamlV1 = parseMihomoYaml((await harness.subGet(linkRes.data.url)).text)
      assertYamlGroupExactOrder(yamlV1, group.name, ['Node-A', 'Node-B'])

      const scheduleRes = await harness.apiPost(
        '/api/quality/schedule',
        buildQualitySchedule({
          targetDeviceId: ctx.deviceId,
          autoRefreshGroups: true,
          ai: {
            enabled: true,
            intervalMinutes: 4320,
            concurrency: 6,
            lastRunAt: null,
            lastJobId: null,
          },
        }),
      )
      assert.equal(scheduleRes.status, 200)

      await ctx.probe.poll({ wait: false })
      const runRes = await harness.apiPost<ScheduleRunResponse>('/api/quality/schedule/run', { kind: 'ai' })
      assert.equal(runRes.status, 200)
      assert.equal(runRes.data.jobs.length, 1)

      const completed = await ctx.probe.pollAndComplete((node) =>
        node.name === 'Node-A'
          ? { exit: null, ai: aiPresets.allGreen('US') }
          : { exit: null, ai: aiPresets.allRestricted('HK') },
      )
      assert.equal(completed.completeResponse?.status, 200)

      const historyRes = await harness.apiGet<Array<{ seq: number; kind: string; parent: number | null }>>('/api/history')
      assert.equal(historyRes.status, 200)
      assert.equal(historyRes.data[0]?.seq, 2)
      assert.equal(historyRes.data[0]?.kind, 'auto')
      assert.equal(historyRes.data[0]?.parent, 1)

      const stateAfter = await harness.apiGet<DraftStateResponse>('/api/state')
      assert.equal(stateAfter.data.current?.seq, 2)
      assert.equal(stateAfter.data.current?.kind, 'auto')

      const v2Doc = harness.readDbDoc<{ seq: number; kind: string; parent: number | null }>(
        `versions/${ctx.profileId}`,
        '000000000002',
      )
      assert.equal(v2Doc?.seq, 2)
      assert.equal(v2Doc?.kind, 'auto')
      assert.equal(v2Doc?.parent, 1)

      const yamlV2 = parseMihomoYaml((await harness.subGet(linkRes.data.url)).text)
      assertYamlGroupExactOrder(yamlV2, group.name, ['Node-A'])
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
