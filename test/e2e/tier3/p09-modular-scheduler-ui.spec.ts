import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertThreeSurfaceAi,
  buildProxyNode,
  buildQualitySchedule,
  buildSource,
  unwrapLatestForDevice,
  type QualityScheduleConfig,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  aiReading,
  createMockProbe,
  parseInviteLink,
  type AutoResponderHandle,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  configureQualitySchedule,
  expectAiUnlockCell,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  findNodeRow,
  openNodesPage,
  openQualityPage,
  triggerScheduleRunButton,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface SourceNodesPayload {
  good: {
    nodes: Array<{ id: string; name: string }>
  } | null
}

interface WorkspaceStatePayload {
  id: string
  revision: number
  draft: {
    sources: Array<Record<string, unknown>>
    groups: Array<Record<string, unknown>>
    services: unknown[]
    rules: unknown[]
    base: Record<string, unknown>
  }
}

test.describe('T3-P09 Modular Probe x Latest Store x Scheduler x Unified AI UI (F3, F4, F7, F8)', () => {
  test('T3-P09-01 (F3,F7) (F4,F7) (F3,F8) (F7,F8): scheduled basic and ai UI runs merge into quality-latest and render unified 3-surface AI column with preserved basic metrics', async ({ page }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        feed: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
            buildProxyNode('🇭🇰 HK-HKG-01', { server: 'hk-hkg-01.example.net', port: 10003 }),
          ],
        },
      })
      harness = await startAppHarness()

      const stateRes = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const profileId = stateRes.data.id
      const source = buildSource({ name: 'Schedule Feed', url: subServer.urlFor('feed') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })).status, 200)
      assert.equal(
        (await harness.apiPost('/api/draft', {
          revision: stateRes.data.revision,
          draft: { ...stateRes.data.draft, sources: [source] },
        })).status,
        200,
      )

      const nodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
      const nodes = nodesRes.data.good?.nodes ?? []
      const usKey = `${source.id}/${nodes.find(n => n.name.includes('US-LAX-01'))!.id}`
      const jpKey = `${source.id}/${nodes.find(n => n.name.includes('JP-TYO-01'))!.id}`
      const hkKey = `${source.id}/${nodes.find(n => n.name.includes('HK-HKG-01'))!.id}`

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const { ticket } = parseInviteLink(inviteRes.data.pairing)
      const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Desk-Sched-Probe' })
      assert.equal((await probe.enroll(ticket)).status, 200)
      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      const deviceId = devicesRes.data.find(d => d.name === 'Desk-Sched-Probe')!.id

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      // (F3, F7) Configure basic & ai schedules on #/quality 定时任务 tab
      await openQualityPage(page, harness.baseUrl, 'schedules')
      await configureQualitySchedule(page, {
        probeName: /Desk-Sched-Probe/,
        scope: 'kept',
        autoRefreshGroups: true,
        basic: { enabled: true, intervalMinutes: 1440, bandwidth: false },
        ai: { enabled: true, intervalMinutes: 4320 },
      })

      // Trigger modular basic scheduled job via UI
      await triggerScheduleRunButton(page, 'basic')
      const basicRun = await probe.pollAndComplete(node => {
        if (node.key === usKey) return { latencyMs: 62, exit: { ip: '198.51.100.1', region: 'US' } }
        if (node.key === jpKey) return { latencyMs: 78, exit: { ip: '198.51.100.2', region: 'JP' } }
        return { latencyMs: 44, exit: { ip: '198.51.100.3', region: 'HK' } }
      })
      assert.equal(basicRun.assignment?.config.basic, true)
      assert.equal(basicRun.assignment?.config.ai, false)
      assert.equal(basicRun.assignment?.config.bandwidth, false)
      assert.equal(basicRun.completeResponse?.status, 200)

      // (F4, F7) Verify quality-latest recorded basic metrics with ai: null
      let latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)
      let latest = unwrapLatestForDevice(latestRes.data, deviceId)
      assert.equal(latest[usKey].basic?.httpsMs, 64)
      assert.equal(latest[usKey].ai, null)

      // Trigger modular ai scheduled job via UI
      await triggerScheduleRunButton(page, 'ai')
      const aiRun = await probe.pollAndComplete(node => {
        if (node.key === usKey) {
          return {
            exit: { ip: '198.51.100.1', region: 'US' },
            ai: {
              chatgptWeb: aiReading.green('US', 'chatgptWeb'),
              chatgptApp: aiReading.restricted('region_restricted', 'HK'),
              gemini: aiReading.uncertain('challenge'),
            },
          }
        }
        if (node.key === jpKey) {
          return {
            exit: { ip: '198.51.100.2', region: 'JP' },
            ai: aiPresets.allGreen('JP'),
          }
        }
        assert.equal(node.key, hkKey)
        return {
          exit: null,
          ai: aiPresets.allRestricted('HK'),
        }
      })
      assert.equal(aiRun.assignment?.config.basic, false)
      assert.equal(aiRun.assignment?.config.ai, true)
      assert.ok(aiRun.report?.results.every(row => row.samples.length === 0))
      assert.equal(aiRun.completeResponse?.status, 200)

      // (F4, F7) Verify quality-latest preserved basic latency/exit and merged 3-surface AI
      latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)
      latest = unwrapLatestForDevice(latestRes.data, deviceId)
      assert.equal(latest[usKey].basic?.httpsMs, 64)
      assertThreeSurfaceAi(latest[usKey].ai?.results)
      assert.equal(latest[hkKey].basic?.httpsMs, 46)
      assertThreeSurfaceAi(latest[hkKey].ai?.results)

      // (F3, F8) & (F7, F8) Verify #/quality Reports tab renders scheduled modular AI results cleanly
      await openQualityPage(page, harness.baseUrl, 'reports')
      await expectNoAiPlatformFilterDropdown(page)
      await expectNoLegacyAiPlatforms(page)

      await expectAiUnlockCell(findNodeRow(page, '🇺🇸 US-LAX-01'), [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])
      await expectAiUnlockCell(findNodeRow(page, '🇯🇵 JP-TYO-01'), [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'JP' },
        { surface: 'Gemini Web', tone: 'success', label: 'JP' },
      ])
      await expectAiUnlockCell(findNodeRow(page, '🇭🇰 HK-HKG-01'), [
        { surface: 'ChatGPT Web', tone: 'danger', label: '受限' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'danger', label: '受限' },
      ])

      // (F3, F8) & (F7, F8) Verify #/nodes merges scheduled basic latency + scheduled 3-surface AI unlock
      await openNodesPage(page, harness.baseUrl)
      await expectNoAiPlatformFilterDropdown(page)
      await expectNoLegacyAiPlatforms(page)

      const usNodeRow = findNodeRow(page, '🇺🇸 US-LAX-01')
      await expectAiUnlockCell(usNodeRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])
      await expect(usNodeRow).toContainText(/64\s*ms/i)

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T3-P09-02 (F3,F7) (F4,F7): workspace.tick() dispatches due modular basic and ai schedules and updates quality-latest', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        feed: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
          ],
        },
      })
      harness = await startAppHarness({ tickMs: 0 })

      const stateRes = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const profileId = stateRes.data.id
      const source = buildSource({ name: 'Tick Feed', url: subServer.urlFor('feed') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })).status, 200)
      assert.equal(
        (await harness.apiPost('/api/draft', {
          revision: stateRes.data.revision,
          draft: { ...stateRes.data.draft, sources: [source] },
        })).status,
        200,
      )
      const nodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
      const usKey = `${source.id}/${nodesRes.data.good!.nodes[0].id}`

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Tick-Probe' })
      assert.equal((await probe.enroll(parseInviteLink(inviteRes.data.pairing).ticket)).status, 200)
      const deviceId = (await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')).data[0].id

      // Send a poll first so device is online
      assert.equal((await probe.poll({ wait: false })).status, 200)

      const schedCfg = buildQualitySchedule({
        targetDeviceId: deviceId,
        scope: 'kept',
        autoRefreshGroups: false,
        basic: { enabled: true, intervalMinutes: 1440, rounds: 3, concurrency: 6, bandwidth: false, lastRunAt: null, lastJobId: null },
        ai: { enabled: true, intervalMinutes: 4320, concurrency: 6, lastRunAt: null, lastJobId: null },
      })
      assert.equal((await harness.apiPost('/api/quality/schedule', schedCfg)).status, 200)

      // Deterministic workspace.tick() triggers both due modular jobs
      await harness.triggerTick()

      const first = await probe.pollAndComplete(() => ({ latencyMs: 58, exit: { ip: '198.51.100.9', region: 'US' } }))
      assert.ok(first.assignment)
      assert.equal(first.completeResponse?.status, 200)

      const second = await probe.pollAndComplete(() => ({ exit: { ip: '198.51.100.9', region: 'US' }, ai: aiPresets.allGreen('US') }))
      assert.ok(second.assignment)
      assert.equal(second.completeResponse?.status, 200)

      const configs = [first.assignment.config, second.assignment.config]
      assert.ok(configs.some(c => c.basic === true && c.ai === false))
      assert.ok(configs.some(c => c.basic === false && c.ai === true))

      const latest = unwrapLatestForDevice(
        (await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)).data,
        deviceId,
      )
      assert.equal(latest[usKey].basic?.httpsMs, 60)
      assertThreeSurfaceAi(latest[usKey].ai?.results)

      const savedSchedule = (await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')).data
      assert.ok(savedSchedule.basic.lastRunAt)
      assert.ok(savedSchedule.basic.lastJobId)
      assert.ok(savedSchedule.ai.lastRunAt)
      assert.ok(savedSchedule.ai.lastJobId)
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
