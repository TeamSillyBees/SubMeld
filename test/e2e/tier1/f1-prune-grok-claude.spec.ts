import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  aiPresets,
  aiReading,
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'
import {
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  assertYamlGroupExactOrder,
  basicAndAiConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildSource,
  parseMihomoYaml,
  uniqueId,
  unwrapLatestForDevice,
} from '../helpers/fixtures.ts'
import {
  attachErrorCollectors,
  closeModal,
  expectAiUnlockCell,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  findNodeRow,
  getRuleFilterSection,
  openAdvancedQualityModal,
  openGroupsPage,
  openNodesPage,
  openQualityPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface DraftStateResponse {
  id: string
  revision: number
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

interface QualityDeviceSummary {
  id: string
  name: string
}

interface QualityReportRow {
  key: string
  ai: unknown
  exit: { ip: string; region: string | null } | null
}

interface QualityReportPayload {
  jobId: string
  results: QualityReportRow[]
}

async function setupWorkspaceAndProbe(
  nodes = [
    buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
    buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
    buildProxyNode('🇸🇬 SG-SIN-01', { server: 'sg-sin-01.example.net', port: 10003 }),
  ],
) {
  const subServer = await startMockSubServer({
    feed1: { format: 'yaml', nodes },
  })
  const harness = await startAppHarness({ useRealCore: false })

  const state0 = await harness.apiGet<DraftStateResponse>('/api/state')
  assert.equal(state0.status, 200)

  const source = buildSource({
    id: uniqueId('src_'),
    name: '主线路订阅',
    url: subServer.urlFor('feed1'),
  })

  const probeSourceRes = await harness.apiPost('/api/probe', {
    kind: 'source',
    id: source.id,
    url: source.url,
  })
  assert.equal(probeSourceRes.status, 200)

  const draftRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
    revision: state0.data.revision,
    draft: buildDraft({ sources: [source] }),
  })
  assert.equal(draftRes.status, 200)

  const committedNodes = draftRes.data.sources[source.id]?.good?.nodes ?? []
  const nodeKeys = committedNodes.map(n => ({ key: `${source.id}/${n.id}`, name: n.name }))
  assert.equal(nodeKeys.length, nodes.length)

  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({
    origin: harness.baseUrl,
    profileId,
    name: 'Probe-Alpha',
  })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices')
  assert.equal(devicesRes.status, 200)
  const deviceId = devicesRes.data[0]?.id
  assert.ok(deviceId)

  return {
    subServer,
    harness,
    source,
    revision: draftRes.data.revision,
    profileId,
    nodeKeys,
    probe,
    deviceId,
  }
}

async function openLatestReportIfNeeded(page: import('@playwright/test').Page) {
  await expect(page.getByText('正在读取检测记录…')).toBeHidden()
  await expect(page.getByText('正在读取报告…')).toBeHidden()

  const detailBtn = page.getByRole('button', { name: /查看检测详情/ }).first()
  const openBtn = page.getByRole('button', { name: /Probe-Alpha|查看报告|查看详情/ }).first()
  await expect(detailBtn.or(openBtn).first()).toBeVisible()

  if ((await detailBtn.count()) === 0 && (await openBtn.isVisible())) {
    await openBtn.click()
    await expect(page.getByText('正在读取报告…')).toBeHidden()
  }
}

test.describe('Tier 1 — F1: Prune Grok & Claude from Contracts & UI', () => {
  test('T1-F1-01 API complete/report/latest persists only 3 AI surfaces with zero Grok or Claude keys', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let probe: MockProbeAgent | undefined

    try {
      const ctx = await setupWorkspaceAndProbe()
      subServer = ctx.subServer
      harness = ctx.harness
      probe = ctx.probe

      const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: basicAndAiConfig(),
      })
      assert.equal(queueRes.status, 200)
      const jobId = queueRes.data.id

      const completed = await probe.pollAndComplete((node) => {
        if (node.name.includes('US-LAX-01')) return { ai: aiPresets.allGreen('US') }
        if (node.name.includes('JP-TYO-01')) return { ai: aiPresets.allRestricted('HK') }
        return { ai: aiPresets.mixed('SG') }
      })
      assert.equal(completed.completeResponse?.status, 200)

      const reportRes = await harness.apiGet<QualityReportPayload>(`/api/quality/report?id=${encodeURIComponent(jobId)}`)
      assert.equal(reportRes.status, 200)
      assert.equal(reportRes.data.jobId, jobId)
      assert.equal(reportRes.data.results.length, 3)
      assertNoLegacyAiStrings(reportRes.data)
      for (const row of reportRes.data.results) {
        assertThreeSurfaceAi(row.ai)
      }

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      assert.equal(latestRes.status, 200)
      const latestMap = unwrapLatestForDevice(latestRes.data, ctx.deviceId)
      assertNoLegacyAiStrings(latestMap)
      for (const { key } of ctx.nodeKeys) {
        assert.ok(latestMap[key]?.ai?.results, `Expected latest AI results for ${key}`)
        assertThreeSurfaceAi(latestMap[key].ai.results)
      }
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F1-02 #/quality Reports & Node Detail render 3-surface AI UI without Grok or Claude', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupWorkspaceAndProbe()
      subServer = ctx.subServer
      harness = ctx.harness

      const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: basicAndAiConfig(),
      })
      assert.equal(queueRes.status, 200)

      const completed = await ctx.probe.pollAndComplete((node) => {
        if (node.name.includes('US-LAX-01')) return { ai: aiPresets.allGreen('US') }
        if (node.name.includes('JP-TYO-01')) return { ai: aiPresets.mixed('JP') }
        return { ai: aiPresets.allRestricted('HK') }
      })
      assert.equal(completed.completeResponse?.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openQualityPage(page, harness.baseUrl, 'reports')
      await openLatestReportIfNeeded(page)

      const usRow = findNodeRow(page, '🇺🇸 US-LAX-01')
      await expect(page.locator('table thead th', { hasText: /AI\s*解锁/ }).first()).toBeVisible()
      await expect(usRow).toBeVisible()
      await expect(usRow).not.toContainText('读取中…')

      await expectNoAiPlatformFilterDropdown(page)
      await expectNoLegacyAiPlatforms(page)

      await expectAiUnlockCell(usRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])

      const detailBtn = page.getByRole('button', { name: /查看检测详情.*US-LAX-01/ }).first()
      await expect(detailBtn).toBeVisible()
      await detailBtn.click()

      await expectNoLegacyAiPlatforms(page)
      await expect(page.getByText('ChatGPT Web').first()).toBeVisible()
      await expect(page.getByText('ChatGPT APP').first()).toBeVisible()
      await expect(page.getByText('Gemini Web').first()).toBeVisible()

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F1-03 #/nodes table & sort controls omit Grok and Claude and show 3 surfaces', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupWorkspaceAndProbe()
      subServer = ctx.subServer
      harness = ctx.harness

      const queueRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: basicAndAiConfig(),
      })
      assert.equal(queueRes.status, 200)
      const completed = await ctx.probe.pollAndComplete((node) => {
        if (node.name.includes('US-LAX-01')) return { ai: aiPresets.allGreen('US') }
        return { ai: aiPresets.mixed('JP') }
      })
      assert.equal(completed.completeResponse?.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openNodesPage(page, harness.baseUrl)

      const usRow = findNodeRow(page, '🇺🇸 US-LAX-01')
      await expect(page.locator('table thead th', { hasText: /AI\s*解锁/ }).first()).toBeVisible()
      await expect(usRow).toBeVisible()
      await expect(usRow).not.toContainText('读取中…')

      await expectNoLegacyAiPlatforms(page)
      await expectNoAiPlatformFilterDropdown(page)

      const sortBar = page.getByRole('group', { name: /节点质量排序/ })
      await expect(sortBar).toBeVisible()
      const sortText = (await sortBar.textContent()) ?? ''
      expect(sortText).not.toMatch(/grok|claude/i)

      await expectAiUnlockCell(usRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F1-04 GroupFilter & 高级质量筛选 modal expose only 3 AI surfaces with no Grok or Claude', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupWorkspaceAndProbe()
      subServer = ctx.subServer
      harness = ctx.harness

      const group = buildProxyGroup({
        name: 'AI 筛选组',
        qualityDeviceId: ctx.deviceId,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition({ aiAll: true }) })],
      })
      const saveRes = await harness.apiPost('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({
          sources: [ctx.source],
          groups: [group],
        }),
      })
      assert.equal(saveRes.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      const ruleScope = getRuleFilterSection(page)
      await expectNoLegacyAiPlatforms(ruleScope)

      const dialog = await openAdvancedQualityModal(page, ruleScope)
      await expectNoLegacyAiPlatforms(dialog)
      await expect(dialog.getByText('ChatGPT Web').first()).toBeVisible()
      await expect(dialog.getByText('ChatGPT APP').first()).toBeVisible()
      await expect(dialog.getByText('Gemini Web').first()).toBeVisible()

      const selectOptions = await dialog.locator('select option').allTextContents()
      for (const optionText of selectOptions) {
        expect(optionText).not.toMatch(/grok|claude/i)
      }

      await closeModal(dialog)
      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F1-05 inferredExitRegion triggers with >= 2/3 agreeing AI surfaces and drives pool exitRegions', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const nodeA = buildProxyNode('Alpha-Node-01', { server: 'alpha-01.example.net', port: 10011 })
      const nodeB = buildProxyNode('Beta-Node-02', { server: 'beta-02.example.net', port: 10012 })
      const ctx = await setupWorkspaceAndProbe([nodeA, nodeB])
      subServer = ctx.subServer
      harness = ctx.harness

      const queueRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: basicAndAiConfig(),
      })
      assert.equal(queueRes.status, 200)

      const completed = await ctx.probe.pollAndComplete((node) => {
        if (node.name === 'Alpha-Node-01') {
          return {
            exit: { ip: '198.51.100.55', region: null },
            ai: {
              chatgptWeb: aiReading.green('SG', 'chatgptWeb'),
              chatgptApp: aiReading.green('SG', 'chatgptApp'),
              gemini: aiReading.uncertain('challenge', null),
            },
          }
        }
        return {
          exit: { ip: '198.51.100.56', region: null },
          ai: {
            chatgptWeb: aiReading.green('SG', 'chatgptWeb'),
            chatgptApp: aiReading.uncertain('unknown', null),
            gemini: aiReading.uncertain('unknown', null),
          },
        }
      })
      assert.equal(completed.completeResponse?.status, 200)

      const group = buildProxyGroup({
        name: 'SG 推定出口组',
        qualityDeviceId: ctx.deviceId,
        members: [
          buildPoolMember({
            sourceIds: [ctx.source.id],
            quality: buildQualityCondition({ alive: true, exitRegions: ['SG'] }),
          }),
        ],
      })

      const saveRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const checkRes = await harness.apiPost<{ groups: Array<{ id: string; members: Array<{ name: string }> }> }>('/api/check', {})
      assert.equal(checkRes.status, 200)
      assert.deepEqual(checkRes.data.groups[0]?.members.map(m => m.name), ['Alpha-Node-01'])

      const publishRes = await harness.apiPost('/api/publish', { revision: saveRes.data.revision })
      assert.equal(publishRes.status, 200)

      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.equal(linkRes.status, 200)
      assert.ok(linkRes.data.url)

      const subRes = await harness.subGet(linkRes.data.url)
      assert.equal(subRes.status, 200)
      const yamlObj = parseMihomoYaml(subRes.text)
      assertYamlGroupExactOrder(yamlObj, group.name, ['Alpha-Node-01'])
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
