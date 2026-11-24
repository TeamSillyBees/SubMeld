import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_E2E_PASSWORD, startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertNoLegacyAiStrings,
  assertYamlGroupContains,
  buildInfoProxy,
  buildProxyNode,
  parseMihomoYaml,
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
  confirmAlertDialog,
  expectAiUnlockCell,
  expectAvailabilityBadgeOrText,
  expectInheritedProbeInRule,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  expectNoReportBaselinePicker,
  expectQuickChipActive,
  findNodeRow,
  getRuleFilterSection,
  navigateViaSidebar,
  openGroupsPage,
  openNodesPage,
  openPublishPage,
  openQualityPage,
  openSourcesPage,
  toggleQuickQualityChip,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

async function selectGroupProbe(scope: Page | Locator, probeName: string): Promise<void> {
  const probeSelect = scope.getByRole('combobox', { name: /探针/ }).first()
  await expect(probeSelect).toBeVisible()
  const optionLabel = await probeSelect.locator('option').evaluateAll((options, name) => {
    return options.find(o => (o.textContent ?? '').includes(name))?.textContent?.trim() ?? ''
  }, probeName)
  expect(optionLabel, `Expected probe option containing "${probeName}"`).not.toBe('')
  await probeSelect.selectOption({ label: optionLabel })
}

test.describe('T4-S01 Daily Operations Onboarding to Publish', () => {
  test('onboards via UI setup, adds YAML+Base64 feeds, pairs v4 probe, filters & publishes YAML', async ({ page, context }) => {
    test.setTimeout(120_000)
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        'feed-a': {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
            buildInfoProxy('剩余流量：500 GB'),
          ],
        },
        'feed-b': {
          format: 'base64',
          nodes: [
            buildProxyNode('🇭🇰 HK-HKG-01', { server: 'hk-hkg-01.example.net', port: 10003 }),
            buildProxyNode('🇸🇬 SG-SIN-01', { server: 'sg-sin-01.example.net', port: 10004 }),
          ],
        },
      })

      harness = await startAppHarness({ password: null })
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: harness.baseUrl })

      // 1. Fresh UI password setup
      await unlockOrSetupAuth(page, harness.baseUrl, DEFAULT_E2E_PASSWORD, { mode: 'ui' })
      await expect(page.getByRole('heading', { name: '订阅工作台' })).toBeVisible()

      // 2. Add 2 upstream subscriptions via UI
      await openSourcesPage(page, harness.baseUrl)
      const feeds = [
        { url: subServer.urlFor('feed-a'), name: '机场 Alpha', prefix: '[A] ', expectedLink: '保留 3 / 3' },
        { url: subServer.urlFor('feed-b'), name: '机场 Beta', prefix: '[B] ', expectedLink: '保留 2 / 2' },
      ]
      for (const feed of feeds) {
        await page.getByRole('button', { name: '添加订阅源', exact: true }).click()
        const editor = page.getByRole('dialog', { name: '添加订阅源' })
        await editor.getByLabel(/^订阅地址/).fill(feed.url)
        await editor.getByLabel(/^订阅源名称/).fill(feed.name)
        await editor.getByLabel(/^节点名称前缀/).fill(feed.prefix)
        await editor.getByRole('button', { name: '测试并预览' }).click()
        await expect(editor.getByText('节点预览', { exact: true })).toBeVisible()
        await editor.getByRole('button', { name: '保存订阅源' }).click()
        await expect(page.getByRole('article', { name: feed.name }).getByRole('link', { name: feed.expectedLink })).toBeVisible()
      }

      // 3. Pair v4 PC probe on #/quality probes tab
      await openQualityPage(page, harness.baseUrl, 'probes')
      const inviteResponsePromise = page.waitForResponse(
        res => res.url().includes('/api/quality/invite') && res.request().method() === 'POST',
      )
      await page.getByRole('button', { name: '复制电脑配对链接', exact: true }).click()
      const inviteRes = await inviteResponsePromise
      expect(inviteRes.ok()).toBe(true)
      const inviteJson = (await inviteRes.json()) as { pairing: string }
      const parsedInvite = parseInviteLink(inviteJson.pairing)

      const probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsedInvite.profileId,
        name: 'Home-PC',
        capabilities: defaultV4Capabilities({ localRegion: 'JP' }),
      })
      const enrollRes = await probe.enroll(parsedInvite.ticket)
      expect(enrollRes.status).toBe(200)
      await expect(page.getByText('Home-PC')).toBeVisible({ timeout: 15_000 })

      // 4. Run initial basic+ai check from #/nodes quality dialog
      await openNodesPage(page, harness.baseUrl)
      await page.getByRole('button', { name: '质量检测', exact: true }).click()
      const qualityDialog = page.getByRole('dialog', { name: '节点质量检测' })
      await expect(qualityDialog).toBeVisible()

      const probeRadio = qualityDialog.getByRole('radio', { name: 'Home-PC' })
      await expect(probeRadio).toBeVisible({ timeout: 15_000 })
      if (!(await probeRadio.isChecked())) {
        await probeRadio.check()
      }
      const aiSwitch = qualityDialog.getByRole('switch', { name: /AI/ })
      if (!(await aiSwitch.isChecked())) {
        await aiSwitch.click()
      }

      const queuePromise = page.waitForResponse(
        res => res.url().includes('/api/quality/queue') && res.request().method() === 'POST',
      )
      await qualityDialog.getByRole('button', { name: '创建检测任务' }).click()
      const queueRes = await queuePromise
      expect(queueRes.ok()).toBe(true)

      const runResult = await probe.pollAndComplete(
        node => {
          if (node.name.includes('US-LAX-01')) {
            return {
              latencyMs: 45,
              lossRate: 0,
              exit: { ip: '198.51.100.1', region: 'US' },
              ai: aiPresets.allGreen('US'),
            }
          }
          if (node.name.includes('JP-TYO-01')) {
            return {
              latencyMs: 80,
              lossRate: 0,
              exit: { ip: '198.51.100.2', region: 'JP' },
              ai: aiPresets.mixed('JP'),
            }
          }
          if (node.name.includes('HK-HKG-01')) {
            return {
              latencyMs: 120,
              lossRate: 0,
              exit: { ip: '198.51.100.3', region: 'HK' },
              ai: aiPresets.allRestricted('HK'),
            }
          }
          return {
            latencyMs: 180,
            lossRate: 0,
            exit: { ip: '198.51.100.4', region: 'SG' },
            ai: aiPresets.allGreen('SG'),
          }
        },
        { emitProgress: true },
      )
      expect(runResult.completeResponse?.status).toBe(200)
      await qualityDialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(qualityDialog).toBeHidden()

      // 5. Inspect #/nodes unified 3-surface AI unlock column & sort by availability
      await page.reload()
      await expect(page.locator('#main-content')).toBeVisible()
      await expectNoReportBaselinePicker(page)
      await expectNoAiPlatformFilterDropdown(page)
      await expectNoLegacyAiPlatforms(page)

      const usRow = findNodeRow(page, '[A] 🇺🇸 US-LAX-01')
      await expectAiUnlockCell(usRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])
      await expectAvailabilityBadgeOrText(usRow, '100%')

      const jpRow = findNodeRow(page, '[A] 🇯🇵 JP-TYO-01')
      await expectAiUnlockCell(jpRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      const hkRow = findNodeRow(page, '[B] 🇭🇰 HK-HKG-01')
      await expectAiUnlockCell(hkRow, [
        { surface: 'ChatGPT Web', tone: 'danger', label: '受限' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'danger', label: '受限' },
      ])

      const availSortBtn = page.getByRole('button', { name: /^可用率/ }).first()
      await expect(availSortBtn).toBeVisible()
      await availSortBtn.click()
      await expect(availSortBtn).toHaveAttribute('aria-pressed', 'true')

      // 6. Configure 2 proxy groups with inline quick-filter chips & single-probe inheritance
      await openGroupsPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)

      // Group 1: AI 专线 (2 pool rules inheriting Home-PC: US + SG)
      await page.getByRole('button', { name: '新建代理组', exact: true }).first().click()
      const grp1Dialog = page.getByRole('dialog', { name: '新建代理组' })
      await grp1Dialog.getByLabel('代理组名称').fill('AI 专线')
      await selectGroupProbe(grp1Dialog, 'Home-PC')
      const rule1 = getRuleFilterSection(page)
      await rule1.getByRole('button', { name: /US.*美国/ }).click()
      await toggleQuickQualityChip(rule1, /全\s*AI\s*解锁/)
      await expectQuickChipActive(rule1, /全\s*AI\s*解锁/, true)
      await toggleQuickQualityChip(rule1, /低延迟/)
      await expectQuickChipActive(rule1, /低延迟/, true)

      await grp1Dialog.getByRole('button', { name: '另加一条筛选' }).click()
      await expectInheritedProbeInRule(rule1, 'Home-PC')
      await rule1.getByRole('button', { name: /SG.*新加坡/ }).click()
      await toggleQuickQualityChip(rule1, /全\s*AI\s*解锁/)
      await expectQuickChipActive(rule1, /全\s*AI\s*解锁/, true)
      await grp1Dialog.getByRole('button', { name: '保存代理组' }).click()
      await expect(page.getByRole('link', { name: 'AI 专线', exact: true })).toBeVisible()

      // Group 2: 低丢包高速
      await page.getByRole('button', { name: '新建代理组', exact: true }).first().click()
      const grp2Dialog = page.getByRole('dialog', { name: '新建代理组' })
      await grp2Dialog.getByLabel('代理组名称').fill('低丢包高速')
      await selectGroupProbe(grp2Dialog, 'Home-PC')
      const rule2 = getRuleFilterSection(page)
      await toggleQuickQualityChip(rule2, /高可用率/)
      await expectQuickChipActive(rule2, /高可用率/, true)
      await toggleQuickQualityChip(rule2, /低丢包率/)
      await expectQuickChipActive(rule2, /低丢包率/, true)
      await grp2Dialog.getByRole('button', { name: '保存代理组' }).click()
      await expect(page.getByRole('link', { name: '低丢包高速', exact: true })).toBeVisible()

      // 7. Publish v1
      await openPublishPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)
      await page.getByRole('button', { name: '运行检查' }).click()
      await expect(page.getByText('已完成 Mihomo 校验。')).toBeVisible()
      await page.getByRole('button', { name: '发布配置' }).click()
      await confirmAlertDialog(page, '确认发布')
      await expect(page.getByRole('heading', { name: '当前成品 v1' })).toBeVisible()

      // 8. Reveal auto-minted private subscription link & verify compiled Mihomo YAML
      await navigateViaSidebar(page, '安全与备份')
      const linkRegion = page.getByRole('region', { name: '私有订阅链接' })
      await expect(linkRegion.getByText('有效链接', { exact: true })).toBeVisible()
      await expect(linkRegion.getByRole('button', { name: '更换链接', exact: true })).toBeVisible()
      await linkRegion.getByRole('button', { name: '显示私有链接' }).click()
      const privateLinkInput = linkRegion.getByRole('textbox', { name: '私有订阅链接', exact: true })
      await expect(privateLinkInput).toHaveValue(/\/sub\//)
      const subUrl = await privateLinkInput.inputValue()

      const subRes = await harness.subGet(subUrl)
      expect(subRes.status).toBe(200)
      const parsedYaml = parseMihomoYaml(subRes.text)
      assertNoLegacyAiStrings(parsedYaml)
      assertYamlGroupContains(parsedYaml, 'AI 专线', ['[A] 🇺🇸 US-LAX-01', '[B] 🇸🇬 SG-SIN-01'])
      assertYamlGroupContains(parsedYaml, '低丢包高速', [
        '[A] 🇺🇸 US-LAX-01',
        '[A] 🇯🇵 JP-TYO-01',
        '[B] 🇭🇰 HK-HKG-01',
        '[B] 🇸🇬 SG-SIN-01',
      ])

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
