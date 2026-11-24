import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { aiPresets, createMockProbe, parseInviteLink, type QualityNode } from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  aiOnlyConfig,
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  basicOnlyConfig,
  buildDraft,
  buildProxyNode,
  buildSource,
  uniqueId,
  unwrapLatestForDevice,
  type LatestNodeQuality,
} from '../helpers/fixtures.ts'
import {
  attachErrorCollectors,
  expectAiUnlockCell,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  expectNoReportBaselinePicker,
  findNodeRow,
  openNodesPage,
  openQualityPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface StateResponse {
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

test.describe('T3-P03 R1 3-Surface AI, Latest Store Merge & Unified Column UI (F1, F4, F8)', () => {
  test('T3-P03-01 (F1,F4,F8): basic-then-AI merge persists 3 surfaces in quality-latest and renders unified AI column in Reports & Node Management without dropdowns or Grok/Claude', async ({
    page,
  }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      subServer = await startMockSubServer({
        main: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-Mixed-01', { server: 'us-mixed.example.net', port: 10001 }),
            buildProxyNode('🇭🇰 HK-Strict-02', { server: 'hk-strict.example.net', port: 10002 }),
            buildProxyNode('🇯🇵 JP-Green-03', { server: 'jp-green.example.net', port: 10003 }),
          ],
        },
      })
      harness = await startAppHarness()

      const sourceId = uniqueId('src_')
      const source = buildSource({ id: sourceId, name: 'P03 订阅', url: subServer.urlFor('main') })
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
      const nodes = nodesRes.data.good?.nodes ?? []
      expect(nodes).toHaveLength(3)
      const usKey = `${sourceId}/${nodes.find(n => n.name.includes('US-Mixed-01'))!.id}`
      const hkKey = `${sourceId}/${nodes.find(n => n.name.includes('HK-Strict-02'))!.id}`
      const jpKey = `${sourceId}/${nodes.find(n => n.name.includes('JP-Green-03'))!.id}`
      const keys = [usKey, hkKey, jpKey]

      // Pair v4 probe
      const invite = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(invite.status).toBe(200)
      const parsed = parseInviteLink(invite.data.pairing)
      const probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsed.profileId,
        name: 'P03-V4-Probe',
      })
      expect((await probe.enroll(parsed.ticket)).status).toBe(200)

      const devicesRes = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices')
      const device = devicesRes.data.find(d => d.name === 'P03-V4-Probe')
      assert.ok(device)

      // Step 1: Run basic-only check (records latency & exit)
      const basicQueue = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: device.id,
        keys,
        config: basicOnlyConfig({ rounds: 2 }),
      })
      expect(basicQueue.status).toBe(200)
      const basicRun = await probe.pollAndComplete((node: QualityNode) => {
        if (node.key === usKey) return { latencyMs: 65, exit: { ip: '198.51.100.11', region: 'US' } }
        if (node.key === hkKey) return { latencyMs: 95, exit: { ip: '198.51.100.12', region: 'HK' } }
        return { latencyMs: 55, exit: { ip: '198.51.100.13', region: 'JP' } }
      })
      expect(basicRun.completeResponse?.status).toBe(200)

      // Step 2: Run AI-only check with 3-state mixed, all-restricted, and all-green results
      const aiQueue = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: device.id,
        keys,
        config: aiOnlyConfig(),
      })
      expect(aiQueue.status).toBe(200)
      const aiRun = await probe.pollAndComplete((node: QualityNode) => {
        if (node.key === usKey) {
          return { exit: { ip: '198.51.100.11', region: 'US' }, ai: aiPresets.mixed('US') }
        }
        if (node.key === hkKey) {
          // Omit `available: false` per aiOnlyConfig invariant so buildQualityRow derives available: true
          return { exit: null, ai: aiPresets.allRestricted('HK') }
        }
        return { exit: { ip: '198.51.100.13', region: 'JP' }, ai: aiPresets.allGreen('JP') }
      })
      expect(aiRun.completeResponse?.status).toBe(200)

      // (F1,F4): Verify merged quality-latest store retains basic latency + 3-surface AI without Grok/Claude
      const latestRes = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(device.id)}`,
      )
      expect(latestRes.status).toBe(200)
      assertNoLegacyAiStrings(latestRes.data)
      const latest = unwrapLatestForDevice(latestRes.data, device.id)
      expect(latest[usKey]?.basic?.httpsMs).not.toBeNull()
      expect(latest[hkKey]?.basic?.httpsMs).not.toBeNull()
      assertThreeSurfaceAi(latest[usKey]?.ai?.results)
      assertThreeSurfaceAi(latest[hkKey]?.ai?.results)
      assertThreeSurfaceAi(latest[jpKey]?.ai?.results)

      // (F1,F8) & (F4,F8): Verify #/quality Reports tab & #/nodes unified 3-surface AI column
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      await openQualityPage(page, harness.baseUrl, 'reports')
      await expectNoLegacyAiPlatforms(page)
      await expectNoAiPlatformFilterDropdown(page)

      const reportUsRow = findNodeRow(page, '🇺🇸 US-Mixed-01')
      await expectAiUnlockCell(reportUsRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      const reportHkRow = findNodeRow(page, '🇭🇰 HK-Strict-02')
      await expectAiUnlockCell(reportHkRow, [
        { surface: 'ChatGPT Web', tone: 'danger', label: '受限' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'danger', label: '受限' },
      ])

      // Inspect NodeDetail inside Reports tab and verify 3-surface view has zero Grok/Claude
      const detailBtn = page.getByRole('button', { name: /查看检测详情.*US-Mixed-01/ }).first()
      await expect(detailBtn).toBeVisible()
      await detailBtn.click()
      await expectNoLegacyAiPlatforms(page)
      await expect(page.getByText(/ChatGPT Web/).first()).toBeVisible()
      await expect(page.getByText(/ChatGPT APP/).first()).toBeVisible()
      await expect(page.getByText(/Gemini Web/).first()).toBeVisible()
      await page.getByRole('button', { name: '返回检测结果' }).click()

      // Verify #/nodes unified AI column reflects latest merged store + preserved basic latency
      await openNodesPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)
      await expectNoLegacyAiPlatforms(page)
      await expectNoAiPlatformFilterDropdown(page)

      const nodesUsRow = findNodeRow(page, '🇺🇸 US-Mixed-01')
      await expectAiUnlockCell(nodesUsRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])
      await expect(nodesUsRow).toContainText(/ms/)

      const nodesJpRow = findNodeRow(page, '🇯🇵 JP-Green-03')
      await expectAiUnlockCell(nodesJpRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'JP' },
        { surface: 'Gemini Web', tone: 'success', label: 'JP' },
      ])

      errors.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
