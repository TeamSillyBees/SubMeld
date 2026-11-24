import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  aiPresets,
  aiReading,
  createMockProbe,
  parseInviteLink,
  type RowSpecOverride,
} from '../helpers/mock-probe.ts'
import {
  basicAndAiConfig,
  buildDraft,
  buildProxyNode,
  buildSource,
  uniqueId,
} from '../helpers/fixtures.ts'
import {
  attachErrorCollectors,
  expectAiUnlockCell,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  findNodeRow,
  openNodesPage,
  openQualityPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface DraftStateResponse {
  id: string
  revision: number
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

async function setupNodesAndCompletedReport(
  nodeNames: string[],
  perNode: (nodeName: string) => RowSpecOverride,
) {
  const nodes = nodeNames.map((name, idx) =>
    buildProxyNode(name, { server: `ui-ai-${idx}.example.net`, port: 10700 + idx }),
  )
  const subServer = await startMockSubServer({ feed1: { format: 'yaml', nodes } })
  const harness = await startAppHarness({ useRealCore: false })

  const state0 = await harness.apiGet<DraftStateResponse>('/api/state')
  assert.equal(state0.status, 200)

  const source = buildSource({
    id: uniqueId('src_'),
    name: '主线路订阅',
    url: subServer.urlFor('feed1'),
  })
  const probeSrc = await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })
  assert.equal(probeSrc.status, 200)

  const draftRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
    revision: state0.data.revision,
    draft: buildDraft({ sources: [source] }),
  })
  assert.equal(draftRes.status, 200)

  const keys = (draftRes.data.sources[source.id]?.good?.nodes ?? []).map(n => `${source.id}/${n.id}`)

  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Probe-UI-AI' })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<Array<{ id: string }>>('/api/quality/devices')
  const deviceId = devicesRes.data[0]?.id
  assert.ok(deviceId)

  const queueRes = await harness.apiPost('/api/quality/queue', {
    targetDeviceId: deviceId,
    keys,
    config: basicAndAiConfig(),
  })
  assert.equal(queueRes.status, 200)

  const completed = await probe.pollAndComplete((node) => perNode(node.name))
  assert.equal(completed.completeResponse?.status, 200)

  return { subServer, harness }
}

async function openLatestReportIfNeeded(page: import('@playwright/test').Page) {
  await expect(page.getByText('正在读取检测记录…')).toBeHidden()
  await expect(page.getByText('正在读取报告…')).toBeHidden()

  const detailBtn = page.getByRole('button', { name: /查看检测详情/ }).first()
  const openBtn = page.getByRole('button', { name: /Probe-UI-AI|查看报告|查看详情/ }).first()
  await expect(detailBtn.or(openBtn).first()).toBeVisible()

  if ((await detailBtn.count()) === 0 && (await openBtn.isVisible())) {
    await openBtn.click()
    await expect(page.getByText('正在读取报告…')).toBeHidden()
  }
}

async function waitForAiTableReady(page: import('@playwright/test').Page, firstNodeName: string) {
  await expect(page.locator('table thead th', { hasText: /AI\s*解锁/ }).first()).toBeVisible()
  const firstRow = findNodeRow(page, firstNodeName)
  await expect(firstRow).toBeVisible()
  await expect(firstRow).not.toContainText('读取中…')
}

test.describe('Tier 1 — F8: Unified 3-Platform AI Unlock Column & Filter Removal', () => {
  test('T1-F8-01 #/quality Reports renders unified AI 解锁 column and removes AI platform dropdown', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndCompletedReport(
        ['🇺🇸 US-LAX-01', '🇯🇵 JP-TYO-01', '🇸🇬 SG-SIN-01'],
        (name) => {
          if (name.includes('US-LAX-01')) return { ai: aiPresets.allGreen('US') }
          if (name.includes('JP-TYO-01')) {
            return {
              ai: {
                chatgptWeb: aiReading.green('JP', 'chatgptWeb'),
                chatgptApp: aiReading.restricted('region_restricted', 'HK'),
                gemini: aiReading.uncertain('challenge', null),
              },
            }
          }
          return { ai: aiPresets.allRestricted('HK') }
        },
      )
      subServer = ctx.subServer
      harness = ctx.harness

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openQualityPage(page, harness.baseUrl, 'reports')
      await openLatestReportIfNeeded(page)
      await waitForAiTableReady(page, '🇺🇸 US-LAX-01')

      await expectNoAiPlatformFilterDropdown(page)
      await expectNoLegacyAiPlatforms(page)

      const headers = await page.locator('table thead th').allTextContents()
      expect(headers.some(h => /AI\s*解锁/.test(h))).toBe(true)
      expect(headers.some(h => /ChatGPT\s*Web|ChatGPT\s*APP|Gemini\s*Web/i.test(h))).toBe(false)

      const usRow = findNodeRow(page, '🇺🇸 US-LAX-01')
      await expectAiUnlockCell(usRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])

      const jpRow = findNodeRow(page, '🇯🇵 JP-TYO-01')
      await expectAiUnlockCell(jpRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F8-02 #/nodes renders unified AI 解锁 column and removes AI platform dropdown', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndCompletedReport(
        ['🇺🇸 US-LAX-01', '🇯🇵 JP-TYO-01'],
        (name) => {
          if (name.includes('US-LAX-01')) return { ai: aiPresets.allGreen('US') }
          return {
            ai: {
              chatgptWeb: aiReading.green('JP', 'chatgptWeb'),
              chatgptApp: aiReading.restricted('region_restricted', 'HK'),
              gemini: aiReading.uncertain('challenge', null),
            },
          }
        },
      )
      subServer = ctx.subServer
      harness = ctx.harness

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openNodesPage(page, harness.baseUrl)
      await waitForAiTableReady(page, '🇺🇸 US-LAX-01')

      await expectNoAiPlatformFilterDropdown(page)
      await expectNoLegacyAiPlatforms(page)

      await expectAiUnlockCell(findNodeRow(page, '🇺🇸 US-LAX-01'), [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])
      await expectAiUnlockCell(findNodeRow(page, '🇯🇵 JP-TYO-01'), [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F8-03 Green region-code display (providerRegion and exitRegion fallback) on #/nodes and Reports', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndCompletedReport(
        ['US-Node', 'JP-Fallback-Node'],
        (name) => {
          if (name === 'US-Node') {
            return {
              exit: { ip: '198.51.100.1', region: 'US' },
              ai: aiPresets.allGreen('US'),
            }
          }
          return {
            exit: { ip: '198.51.100.2', region: 'JP' },
            ai: {
              chatgptWeb: aiReading.green(null, 'chatgptWeb'),
              chatgptApp: aiReading.green(null, 'chatgptApp'),
              gemini: aiReading.green(null, 'gemini'),
            },
          }
        },
      )
      subServer = ctx.subServer
      harness = ctx.harness

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      await openNodesPage(page, harness.baseUrl)
      await waitForAiTableReady(page, 'US-Node')
      await expectAiUnlockCell(findNodeRow(page, 'US-Node'), [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])
      await expectAiUnlockCell(findNodeRow(page, 'JP-Fallback-Node'), [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'JP' },
        { surface: 'Gemini Web', tone: 'success', label: 'JP' },
      ])

      await openQualityPage(page, harness.baseUrl, 'reports')
      await openLatestReportIfNeeded(page)
      await waitForAiTableReady(page, 'US-Node')
      await expectAiUnlockCell(findNodeRow(page, 'US-Node'), [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])
      await expectAiUnlockCell(findNodeRow(page, 'JP-Fallback-Node'), [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'JP' },
        { surface: 'Gemini Web', tone: 'success', label: 'JP' },
      ])

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F8-04 Red 受限 display rule for region_restricted, ip_blocked, and unavailable', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndCompletedReport(
        ['Restricted-Node'],
        () => ({
          ai: {
            chatgptWeb: aiReading.restricted('region_restricted', 'HK'),
            chatgptApp: aiReading.restricted('ip_blocked'),
            gemini: aiReading.restricted('unavailable'),
          },
        }),
      )
      subServer = ctx.subServer
      harness = ctx.harness

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      await openNodesPage(page, harness.baseUrl)
      await waitForAiTableReady(page, 'Restricted-Node')
      const nodesRow = findNodeRow(page, 'Restricted-Node')
      await expectAiUnlockCell(nodesRow, [
        { surface: 'ChatGPT Web', tone: 'danger', label: '受限' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'danger', label: '受限' },
      ])
      await expect(nodesRow).not.toContainText('HK')

      await openQualityPage(page, harness.baseUrl, 'reports')
      await openLatestReportIfNeeded(page)
      await waitForAiTableReady(page, 'Restricted-Node')
      const reportRow = findNodeRow(page, 'Restricted-Node')
      await expectAiUnlockCell(reportRow, [
        { surface: 'ChatGPT Web', tone: 'danger', label: '受限' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'danger', label: '受限' },
      ])

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F8-05 Yellow 未知 display rule across uncertain states and Node Detail 3-surface view', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndCompletedReport(
        ['Uncertain-A', 'Uncertain-B', 'Uncertain-C'],
        (name) => {
          if (name === 'Uncertain-A') {
            return {
              ai: {
                chatgptWeb: aiReading.uncertain('challenge', null),
                chatgptApp: aiReading.uncertain('degraded_challenge', null),
                gemini: aiReading.uncertain('unknown', null),
              },
            }
          }
          if (name === 'Uncertain-B') {
            return {
              ai: {
                chatgptWeb: aiReading.uncertain('authentication', null),
                chatgptApp: aiReading.uncertain('rate_limited', null),
                gemini: aiReading.uncertain('region_mismatch', null),
              },
            }
          }
          return {
            ai: {
              chatgptWeb: aiReading.uncertain('network_error', null),
              chatgptApp: aiReading.green('SG', 'chatgptApp'),
              gemini: aiReading.restricted('ip_blocked'),
            },
          }
        },
      )
      subServer = ctx.subServer
      harness = ctx.harness

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      await openNodesPage(page, harness.baseUrl)
      await waitForAiTableReady(page, 'Uncertain-A')
      await expectAiUnlockCell(findNodeRow(page, 'Uncertain-A'), [
        { surface: 'ChatGPT Web', tone: 'warning', label: '未知' },
        { surface: 'ChatGPT APP', tone: 'warning', label: '未知' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])
      await expectAiUnlockCell(findNodeRow(page, 'Uncertain-B'), [
        { surface: 'ChatGPT Web', tone: 'warning', label: '未知' },
        { surface: 'ChatGPT APP', tone: 'warning', label: '未知' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])
      await expectAiUnlockCell(findNodeRow(page, 'Uncertain-C'), [
        { surface: 'ChatGPT Web', tone: 'warning', label: '未知' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'SG' },
        { surface: 'Gemini Web', tone: 'danger', label: '受限' },
      ])

      await openQualityPage(page, harness.baseUrl, 'reports')
      await openLatestReportIfNeeded(page)
      await waitForAiTableReady(page, 'Uncertain-C')
      await expectAiUnlockCell(findNodeRow(page, 'Uncertain-C'), [
        { surface: 'ChatGPT Web', tone: 'warning', label: '未知' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'SG' },
        { surface: 'Gemini Web', tone: 'danger', label: '受限' },
      ])

      const detailBtn = page.getByRole('button', { name: /查看检测详情.*Uncertain-C/ }).first()
      await expect(detailBtn).toBeVisible()
      await detailBtn.click()

      await expectNoLegacyAiPlatforms(page)
      await expect(page.getByText('ChatGPT Web').first()).toBeVisible()
      await expect(page.getByText('ChatGPT APP').first()).toBeVisible()
      await expect(page.getByText('Gemini Web').first()).toBeVisible()

      const backBtn = page.getByRole('button', { name: /返回检测结果|返回报告/ }).first()
      await expect(backBtn).toBeVisible()
      await backBtn.click()
      await expect(findNodeRow(page, 'Uncertain-C')).toBeVisible()

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
