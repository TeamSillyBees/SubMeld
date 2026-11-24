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
  aiOnlyConfig,
  assertAvailabilityStats,
  assertThreeSurfaceAi,
  basicAndAiConfig,
  basicAndBandwidthConfig,
  basicOnlyConfig,
  buildDraft,
  buildProxyNode,
  buildSource,
  uniqueId,
  unwrapLatestForDevice,
} from '../helpers/fixtures.ts'
import {
  attachErrorCollectors,
  openNodesPage,
  openQualityPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface DraftStateResponse {
  id: string
  revision: number
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

interface QualityReportRow {
  key: string
  available: boolean
  error: string | null
  samples: Array<{ tlsMs: number | null; httpsMs: number | null }>
  tlsMedianMs: number | null
  httpsMedianMs: number | null
  jitterMs: number | null
  lossRate: number | null
  exit: { ip: string; region: string | null } | null
  aiSkipped?: 'missing_exit' | 'weak_connection'
  speed: { bytes: number; averageBps: number } | null
  ai: unknown
}

interface QualityReportPayload {
  jobId: string
  results: QualityReportRow[]
}

async function setupModularContext() {
  const nodes = [
    buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10201 }),
    buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10202 }),
    buildProxyNode('🇸🇬 SG-SIN-01', { server: 'sg-sin-01.example.net', port: 10203 }),
  ]
  const subServer = await startMockSubServer({ feed1: { format: 'yaml', nodes } })
  const harness = await startAppHarness({ useRealCore: false })

  const state0 = await harness.apiGet<DraftStateResponse>('/api/state')
  assert.equal(state0.status, 200)

  const source = buildSource({ id: uniqueId('src_'), name: '模块化测速订阅', url: subServer.urlFor('feed1') })
  const probeSrc = await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })
  assert.equal(probeSrc.status, 200)

  const draftRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
    revision: state0.data.revision,
    draft: buildDraft({ sources: [source] }),
  })
  assert.equal(draftRes.status, 200)

  const nodeKeys = (draftRes.data.sources[source.id]?.good?.nodes ?? []).map(n => ({
    key: `${source.id}/${n.id}`,
    name: n.name,
  }))
  assert.equal(nodeKeys.length, 3)

  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Probe-Modular' })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<Array<{ id: string }>>('/api/quality/devices')
  assert.equal(devicesRes.status, 200)
  const deviceId = devicesRes.data[0]?.id
  assert.ok(deviceId)

  return { subServer, harness, nodeKeys, probe, deviceId }
}

test.describe('Tier 1 — F3: Modular Probe Execution (basic vs ai vs bandwidth)', () => {
  test('T1-F3-01 basicOnlyConfig populates basic metrics and availability with ai=null and speed=null', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let probe: MockProbeAgent | undefined

    try {
      const ctx = await setupModularContext()
      subServer = ctx.subServer
      harness = ctx.harness
      probe = ctx.probe

      const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: basicOnlyConfig({ rounds: 3 }),
      })
      assert.equal(queueRes.status, 200)

      const completed = await probe.pollAndComplete(() => ({ latencyMs: 65, tlsMs: 22 }))
      assert.equal(completed.assignment?.config.basic, true)
      assert.equal(completed.assignment?.config.bandwidth, false)
      assert.equal(completed.assignment?.config.ai, false)
      assert.equal(completed.completeResponse?.status, 200)

      const reportRes = await harness.apiGet<QualityReportPayload>(`/api/quality/report?id=${encodeURIComponent(queueRes.data.id)}`)
      assert.equal(reportRes.status, 200)
      for (const row of reportRes.data.results) {
        assert.equal(row.available, true)
        assert.equal(row.samples.length, 3)
        assert.equal(row.ai, null)
        assert.equal(row.speed, null)
      }

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      assert.equal(latestRes.status, 200)
      const latestMap = unwrapLatestForDevice(latestRes.data, ctx.deviceId)
      for (const { key } of ctx.nodeKeys) {
        const rec = latestMap[key]
        assert.ok(rec?.basic)
        assert.equal(rec.basic.available, true)
        assert.equal(rec.ai, null)
        assert.equal(rec.speed, null)
        assertAvailabilityStats(rec.availability, 1, 1)
      }
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F3-02 aiOnlyConfig skips basic samples & bandwidth while persisting 3-surface AI results', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let probe: MockProbeAgent | undefined

    try {
      const ctx = await setupModularContext()
      subServer = ctx.subServer
      harness = ctx.harness
      probe = ctx.probe

      const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: aiOnlyConfig(),
      })
      assert.equal(queueRes.status, 200)

      const completed = await probe.pollAndComplete((_node, idx) => {
        if (idx === 0) return { exit: { ip: '198.51.100.1', region: 'US' }, ai: aiPresets.allGreen('US') }
        if (idx === 1) return { exit: null, ai: aiPresets.allRestricted('HK') }
        return { aiSkipped: 'missing_exit' }
      })
      assert.equal(completed.assignment?.config.basic, false)
      assert.equal(completed.assignment?.config.ai, true)
      assert.equal(completed.completeResponse?.status, 200)

      const reportRes = await harness.apiGet<QualityReportPayload>(`/api/quality/report?id=${encodeURIComponent(queueRes.data.id)}`)
      assert.equal(reportRes.status, 200)
      const rows = reportRes.data.results
      assert.equal(rows.length, 3)
      for (const row of rows) {
        assert.deepEqual(row.samples, [])
        assert.equal(row.httpsMedianMs, null)
        assert.equal(row.tlsMedianMs, null)
        assert.equal(row.jitterMs, null)
        assert.equal(row.lossRate, null)
        assert.equal(row.speed, null)
      }
      assert.equal(rows[0].available, true)
      assertThreeSurfaceAi(rows[0].ai)
      assert.equal(rows[1].available, true)
      assertThreeSurfaceAi(rows[1].ai)
      assert.equal(rows[2].available, false)
      assert.equal(rows[2].aiSkipped, 'missing_exit')

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      assert.equal(latestRes.status, 200)
      const latestMap = unwrapLatestForDevice(latestRes.data, ctx.deviceId)
      for (const { key } of ctx.nodeKeys) {
        const rec = latestMap[key]
        assert.equal(rec?.basic, null)
        assert.equal(rec?.speed, null)
        assert.equal(rec?.availability, null)
        assert.ok(rec?.ai)
      }
      assertThreeSurfaceAi(latestMap[ctx.nodeKeys[0].key].ai?.results)
      assertThreeSurfaceAi(latestMap[ctx.nodeKeys[1].key].ai?.results)
      assert.equal(latestMap[ctx.nodeKeys[2].key].ai?.aiSkipped, 'missing_exit')
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F3-03 basicAndAiConfig populates basic, AI, and availability with speed=null', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let probe: MockProbeAgent | undefined

    try {
      const ctx = await setupModularContext()
      subServer = ctx.subServer
      harness = ctx.harness
      probe = ctx.probe

      const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: basicAndAiConfig({ rounds: 4 }),
      })
      assert.equal(queueRes.status, 200)

      const completed = await probe.pollAndComplete(() => ({ latencyMs: 55, ai: aiPresets.allGreen('US') }))
      assert.equal(completed.completeResponse?.status, 200)

      const reportRes = await harness.apiGet<QualityReportPayload>(`/api/quality/report?id=${encodeURIComponent(queueRes.data.id)}`)
      assert.equal(reportRes.status, 200)
      for (const row of reportRes.data.results) {
        assert.equal(row.samples.length, 4)
        assertThreeSurfaceAi(row.ai)
        assert.equal(row.speed, null)
      }

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      const latestMap = unwrapLatestForDevice(latestRes.data, ctx.deviceId)
      for (const { key } of ctx.nodeKeys) {
        const rec = latestMap[key]
        assert.ok(rec?.basic?.available)
        assertThreeSurfaceAi(rec?.ai?.results)
        assert.equal(rec?.speed, null)
        assertAvailabilityStats(rec?.availability, 1, 1)
      }
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F3-04 basicAndBandwidthConfig populates speed reading while keeping ai=null', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let probe: MockProbeAgent | undefined

    try {
      const ctx = await setupModularContext()
      subServer = ctx.subServer
      harness = ctx.harness
      probe = ctx.probe

      const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: basicAndBandwidthConfig(),
      })
      assert.equal(queueRes.status, 200)

      const completed = await probe.pollAndComplete(() => ({ latencyMs: 45, speedMbps: 150 }))
      assert.equal(completed.completeResponse?.status, 200)

      const reportRes = await harness.apiGet<QualityReportPayload>(`/api/quality/report?id=${encodeURIComponent(queueRes.data.id)}`)
      assert.equal(reportRes.status, 200)
      for (const row of reportRes.data.results) {
        assert.ok(row.speed && row.speed.averageBps > 0 && row.speed.bytes > 0)
        assert.equal(row.ai, null)
      }

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      const latestMap = unwrapLatestForDevice(latestRes.data, ctx.deviceId)
      for (const { key } of ctx.nodeKeys) {
        const rec = latestMap[key]
        assert.equal(rec?.speed?.speedMbps, 150)
        assert.equal(rec?.speed?.speedFailed, false)
        assert.equal(rec?.ai, null)
      }
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F3-05 #/quality modular detection toggles emit matching basic/bandwidth/ai QualityConfig', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupModularContext()
      subServer = ctx.subServer
      harness = ctx.harness

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      // Prefer #/quality probes/reports manual launch; fallback to #/nodes quality launch button if mounted there.
      await openQualityPage(page, harness.baseUrl, 'probes')
      const launchOnQuality = page.getByRole('button', { name: /发起检测|立即检测|新建检测|节点质量检测|质量检测/ }).first()
      if ((await launchOnQuality.count()) > 0 && (await launchOnQuality.isVisible())) {
        await launchOnQuality.click()
      } else {
        await openNodesPage(page, harness.baseUrl)
        const launchOnNodes = page.getByRole('button', { name: /节点质量检测|质量检测/ }).first()
        await expect(launchOnNodes).toBeVisible()
        await launchOnNodes.click()
      }

      const basicToggle = page.getByLabel(/常规质量检测|基础指标|延迟与出口/).first()
      const bwToggle = page.getByLabel(/下载测速/).first()
      const aiToggle = page.getByLabel(/AI\s*平台检测|AI\s*解锁检测/).first()

      await expect(basicToggle).toBeVisible()
      await expect(bwToggle).toBeVisible()
      await expect(aiToggle).toBeVisible()

      const setSwitch = async (locator: typeof basicToggle, desired: boolean) => {
        const tag = await locator.evaluate(el => el.tagName.toLowerCase())
        const active = tag === 'input'
          ? await locator.isChecked()
          : (await locator.getAttribute('aria-checked')) === 'true' || (await locator.getAttribute('data-state')) === 'checked'
        if (active !== desired) {
          await locator.click()
        }
      }

      // Case 1: AI-only (basic: false, bandwidth: false, ai: true)
      if (await bwToggle.isEnabled()) {
        await setSwitch(bwToggle, false)
      }
      await setSwitch(basicToggle, false)
      if (await bwToggle.isEnabled()) {
        await setSwitch(bwToggle, false)
      }
      await setSwitch(aiToggle, true)

      const submitBtn = page.getByRole('button', { name: /创建检测任务|开始检测/ }).first()
      await expect(submitBtn).toBeVisible()

      const [res1] = await Promise.all([
        page.waitForResponse(
          res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/quality/queue') && res.ok(),
        ),
        submitBtn.click(),
      ])
      const body1 = res1.request().postDataJSON() as { config: { basic?: boolean; bandwidth?: boolean; ai?: boolean } }
      expect(body1.config.basic).toBe(false)
      expect(body1.config.bandwidth).toBe(false)
      expect(body1.config.ai).toBe(true)

      const completed1 = await ctx.probe.pollAndComplete(() => ({ exit: null, ai: aiPresets.allGreen('US') }))
      assert.equal(completed1.completeResponse?.status, 200)

      // Case 2: Basic + Bandwidth (basic: true, bandwidth: true, ai: false)
      const newRunBtn = page.getByRole('button', { name: /新建检测|发起检测/ }).first()
      if ((await newRunBtn.count()) > 0 && (await newRunBtn.isVisible())) {
        await newRunBtn.click()
      }
      await setSwitch(basicToggle, true)
      await setSwitch(bwToggle, true)
      await setSwitch(aiToggle, false)

      const [res2] = await Promise.all([
        page.waitForResponse(
          res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/quality/queue') && res.ok(),
        ),
        page.getByRole('button', { name: /创建检测任务|开始检测/ }).first().click(),
      ])
      const body2 = res2.request().postDataJSON() as { config: { basic?: boolean; bandwidth?: boolean; ai?: boolean } }
      expect(body2.config.basic).toBe(true)
      expect(body2.config.bandwidth).toBe(true)
      expect(body2.config.ai).toBe(false)

      const completed2 = await ctx.probe.pollAndComplete(() => ({ latencyMs: 50, speedMbps: 100 }))
      assert.equal(completed2.completeResponse?.status, 200)
      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
