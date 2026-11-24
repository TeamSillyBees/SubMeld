import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  basicAndAiConfig,
  basicOnlyConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildQualitySchedule,
  buildSource,
  uniqueId,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  createMockProbe,
  defaultV4Capabilities,
  parseInviteLink,
  type AutoResponderHandle,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  closeModal,
  expectAiUnlockCell,
  expectAvailabilityBadgeOrText,
  expectNoAiPlatformFilterDropdown,
  expectNoHorizontalOverflow,
  expectNoLegacyAiPlatforms,
  expectNoReportBaselinePicker,
  findNodeRow,
  getRuleFilterSection,
  navigateViaSidebar,
  openAdvancedQualityModal,
  openQualityPage,
  runAxeAudit,
  toggleQuickQualityChip,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

test.describe('T4-S06 Mobile & Accessibility Full Audit', () => {
  test('audits 390x844 and 320x700 viewports across quality, nodes, groups modal, and publish with zero Axe violations', async ({ page }) => {
    test.setTimeout(150_000)
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        audit: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-01', { server: 'us-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-01', { server: 'jp-01.example.net', port: 10002 }),
            buildProxyNode('🇭🇰 HK-01', { server: 'hk-01.example.net', port: 10003 }),
          ],
        },
      })

      harness = await startAppHarness()

      // Pair v4 probe
      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(inviteRes.status).toBe(200)
      const parsed = parseInviteLink(inviteRes.data.pairing)
      const probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsed.profileId,
        name: 'Mobile-Audit-Probe',
        capabilities: defaultV4Capabilities(),
      })
      expect((await probe.enroll(parsed.ticket)).status).toBe(200)
      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      const device = devicesRes.data.find(d => d.name === 'Mobile-Audit-Probe')
      assert.ok(device)

      // Seed source, Mobile-Group, and schedule config
      const stateRes = await harness.apiGet<{ revision: number }>('/api/state')
      const source = buildSource({ id: uniqueId('src_'), name: 'Audit-Sub', url: subServer.urlFor('audit') })
      const group = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'Mobile-Group',
        qualityDeviceId: device.id,
        members: [
          buildPoolMember({
            sourceIds: [source.id],
            quality: buildQualityCondition({ aiAll: true }),
          }),
        ],
      })
      expect(
        (await harness.apiPost('/api/draft', {
          revision: stateRes.data.revision,
          draft: buildDraft({ sources: [source], groups: [group] }),
        })).status,
      ).toBe(200)
      expect((await harness.apiPost('/api/refresh', { id: source.id })).status).toBe(200)

      let nodeKeys: string[] = []
      const activeHarness = harness
      await expect
        .poll(async () => {
          const nodesRes = await activeHarness.apiGet<{ good: { nodes: Array<{ id: string }> } | null }>(
            `/api/source-nodes?id=${encodeURIComponent(source.id)}`,
          )
          nodeKeys = (nodesRes.data.good?.nodes ?? []).map(n => `${source.id}/${n.id}`)
          return nodeKeys.length
        })
        .toBe(3)

      const schedRes = await harness.apiPost(
        '/api/quality/schedule',
        buildQualitySchedule({
          targetDeviceId: device.id,
          basic: { enabled: true, intervalMinutes: 1440, rounds: 3, concurrency: 6, bandwidth: false, lastRunAt: null, lastJobId: null },
          ai: { enabled: true, intervalMinutes: 4320, concurrency: 6, lastRunAt: null, lastJobId: null },
        }),
      )
      expect(schedRes.status).toBe(200)

      // Run 1 basic-only (JP-01 fails -> 0/1) then 1 basic+ai (JP-01 passes -> 1/2 = 50% + mixed 3-state AI)
      expect(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: device.id,
          keys: nodeKeys,
          config: basicOnlyConfig(),
        })).status,
      ).toBe(200)
      const r1 = await probe.pollAndComplete(node => {
        if (node.name.includes('JP-01')) return { available: false, error: 'no_response' }
        return { latencyMs: 60, lossRate: 0 }
      })
      expect(r1.completeResponse?.status).toBe(200)

      expect(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: device.id,
          keys: nodeKeys,
          config: basicAndAiConfig(),
        })).status,
      ).toBe(200)
      const r2 = await probe.pollAndComplete(node => {
        if (node.name.includes('US-01')) {
          return { latencyMs: 50, lossRate: 0, exit: { ip: '198.51.100.1', region: 'US' }, ai: aiPresets.allGreen('US') }
        }
        if (node.name.includes('JP-01')) {
          return { latencyMs: 90, lossRate: 0, exit: { ip: '198.51.100.2', region: 'JP' }, ai: aiPresets.mixed('JP') }
        }
        return { latencyMs: 120, lossRate: 0, exit: { ip: '198.51.100.3', region: 'HK' }, ai: aiPresets.allRestricted('HK') }
      })
      expect(r2.completeResponse?.status).toBe(200)

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      const viewports = [
        { width: 390, height: 844 },
        { width: 320, height: 700 },
      ] as const

      for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })

        // 1. #/quality (schedules)
        await openQualityPage(page, harness.baseUrl, 'schedules')
        await expectNoHorizontalOverflow(page, viewport.width)
        await runAxeAudit(page, `quality-schedules-${viewport.width}`)

        // 2. #/quality (reports)
        await openQualityPage(page, harness.baseUrl, 'reports')
        await expectNoAiPlatformFilterDropdown(page)
        await expectNoLegacyAiPlatforms(page)
        await expectAiUnlockCell(findNodeRow(page, '🇯🇵 JP-01'), [
          { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
          { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
          { surface: 'Gemini Web', tone: 'warning', label: '未知' },
        ])
        await expectNoHorizontalOverflow(page, viewport.width)
        await runAxeAudit(page, `quality-reports-${viewport.width}`)

        // 3. #/quality (probes)
        await openQualityPage(page, harness.baseUrl, 'probes')
        await expectNoHorizontalOverflow(page, viewport.width)
        await runAxeAudit(page, `quality-probes-${viewport.width}`)

        // 4. #/nodes via sidebar
        await navigateViaSidebar(page, '节点管理')
        await expectNoReportBaselinePicker(page)
        await expectNoAiPlatformFilterDropdown(page)
        await expectNoLegacyAiPlatforms(page)
        const jpNodeRow = findNodeRow(page, '🇯🇵 JP-01')
        await expectAiUnlockCell(jpNodeRow, [
          { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
          { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
          { surface: 'Gemini Web', tone: 'warning', label: '未知' },
        ])
        await expectAvailabilityBadgeOrText(jpNodeRow, '50%')
        await expectNoHorizontalOverflow(page, viewport.width)
        await runAxeAudit(page, `nodes-${viewport.width}`)

        // 5. #/groups (GroupFilter + Advanced Quality Modal) via sidebar
        await navigateViaSidebar(page, '代理组')
        await expectNoReportBaselinePicker(page)
        await page.getByRole('link', { name: 'Mobile-Group', exact: true }).click()
        const rule = getRuleFilterSection(page)
        await toggleQuickQualityChip(rule, /低延迟/)
        await expectNoHorizontalOverflow(page, viewport.width)
        await runAxeAudit(page, `groups-filter-${viewport.width}`)

        const modal = await openAdvancedQualityModal(page, rule)
        await expectNoLegacyAiPlatforms(modal)
        await expectNoHorizontalOverflow(page, viewport.width)
        await runAxeAudit(page, `groups-advanced-modal-${viewport.width}`)
        await closeModal(modal)

        // Revert unsaved toggle so navigating to publish does not trigger unsaved guard
        const revertBtn = page.getByRole('button', { name: '撤销更改' }).first()
        if ((await revertBtn.count()) > 0 && (await revertBtn.isVisible())) {
          await revertBtn.click()
        }

        // 6. #/publish via sidebar
        await navigateViaSidebar(page, '配置发布')
        await expectNoReportBaselinePicker(page)
        await expectNoHorizontalOverflow(page, viewport.width)
        await runAxeAudit(page, `publish-${viewport.width}`)
      }

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
