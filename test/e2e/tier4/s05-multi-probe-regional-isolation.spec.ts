import assert from 'node:assert/strict'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertYamlGroupExactOrder,
  basicAndAiConfig,
  buildDraft,
  buildProxyNode,
  buildSource,
  parseMihomoYaml,
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
  confirmAlertDialog,
  expectInheritedProbeInRule,
  expectQuickChipActive,
  getRuleFilterSection,
  openAdvancedQualityModal,
  openGroupsPage,
  openPublishPage,
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

async function applyAndCloseAdvancedModal(modal: Locator): Promise<void> {
  const applyBtn = modal.getByRole('button', { name: /^(?:确定|应用|完成|保存)$/ }).first()
  if ((await applyBtn.count()) > 0 && (await applyBtn.isVisible())) {
    await applyBtn.click()
    await expect(modal).toBeHidden()
    return
  }
  await closeModal(modal)
}

test.describe('T4-S05 Multi-Probe Regional Isolation', () => {
  test('isolates Home-JP and Office-HK probe results across groups with inheritance & advanced modal options', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        multi: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇯🇵 JP-Fast-01', { server: 'jp-fast-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-Slow-02', { server: 'jp-slow-02.example.net', port: 10002 }),
            buildProxyNode('🇭🇰 HK-Edge-01', { server: 'hk-edge-01.example.net', port: 10003 }),
          ],
        },
      })

      harness = await startAppHarness()

      // Seed subscription source
      const stateRes = await harness.apiGet<{ revision: number }>('/api/state')
      const source = buildSource({ id: uniqueId('src_'), name: 'Multi-Sub', url: subServer.urlFor('multi') })
      expect(
        (await harness.apiPost('/api/draft', {
          revision: stateRes.data.revision,
          draft: buildDraft({ sources: [source] }),
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

      // Pair 2 v4 probes: Home-JP and Office-HK
      const inv1 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const p1 = parseInviteLink(inv1.data.pairing)
      const homeJpProbe = createMockProbe({
        origin: harness.baseUrl,
        profileId: p1.profileId,
        name: 'Home-JP',
        capabilities: defaultV4Capabilities({ localRegion: 'JP' }),
      })
      expect((await homeJpProbe.enroll(p1.ticket)).status).toBe(200)

      const inv2 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const p2 = parseInviteLink(inv2.data.pairing)
      const officeHkProbe = createMockProbe({
        origin: harness.baseUrl,
        profileId: p2.profileId,
        name: 'Office-HK',
        capabilities: defaultV4Capabilities({ localRegion: 'HK' }),
      })
      expect((await officeHkProbe.enroll(p2.ticket)).status).toBe(200)

      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      const homeJpDevice = devicesRes.data.find(d => d.name === 'Home-JP')
      const officeHkDevice = devicesRes.data.find(d => d.name === 'Office-HK')
      assert.ok(homeJpDevice && officeHkDevice, 'Expected both Home-JP and Office-HK devices')

      // Measure all nodes on Home-JP: JP nodes fast + AI green, HK node slow + AI restricted
      expect(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: homeJpDevice.id,
          keys: nodeKeys,
          config: basicAndAiConfig(),
        })).status,
      ).toBe(200)
      const jpRun = await homeJpProbe.pollAndComplete(node => {
        if (node.name.includes('JP-Fast-01')) {
          return { latencyMs: 35, lossRate: 0, exit: { ip: '198.51.100.31', region: 'JP' }, ai: aiPresets.allGreen('JP') }
        }
        if (node.name.includes('JP-Slow-02')) {
          return { latencyMs: 120, lossRate: 0, exit: { ip: '198.51.100.32', region: 'JP' }, ai: aiPresets.allGreen('JP') }
        }
        return { latencyMs: 380, lossRate: 0.2, exit: { ip: '198.51.100.33', region: 'HK' }, ai: aiPresets.allRestricted('HK') }
      })
      expect(jpRun.completeResponse?.status).toBe(200)

      // Measure all nodes on Office-HK: HK node fast + AI green, JP nodes slow + AI restricted
      expect(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: officeHkDevice.id,
          keys: nodeKeys,
          config: basicAndAiConfig(),
        })).status,
      ).toBe(200)
      const hkRun = await officeHkProbe.pollAndComplete(node => {
        if (node.name.includes('HK-Edge-01')) {
          return { latencyMs: 25, lossRate: 0, exit: { ip: '198.51.100.43', region: 'HK' }, ai: aiPresets.allGreen('HK') }
        }
        if (node.name.includes('JP-Slow-02')) {
          return { latencyMs: 310, lossRate: 0, exit: { ip: '198.51.100.42', region: 'JP' }, ai: aiPresets.allRestricted('JP') }
        }
        return { latencyMs: 420, lossRate: 0.1, exit: { ip: '198.51.100.41', region: 'JP' }, ai: aiPresets.allRestricted('JP') }
      })
      expect(hkRun.completeResponse?.status).toBe(200)

      // Configure groups via UI
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl)

      // Group-A bound to Home-JP with 2 pool rules inheriting Home-JP
      await page.getByRole('button', { name: '新建代理组', exact: true }).first().click()
      const grpADialog = page.getByRole('dialog', { name: '新建代理组' })
      await grpADialog.getByLabel('代理组名称').fill('Group-A')
      await selectGroupProbe(grpADialog, 'Home-JP')

      const ruleA = getRuleFilterSection(page)
      await ruleA.getByRole('button', { name: /JP.*日本/ }).click()
      await toggleQuickQualityChip(ruleA, /全\s*AI\s*解锁/)
      await expectQuickChipActive(ruleA, /全\s*AI\s*解锁/, true)
      const modalA = await openAdvancedQualityModal(page, ruleA)
      await modalA.getByLabel('组内排序').selectOption('https')
      await modalA.getByLabel('最多保留节点数').fill('1')
      await applyAndCloseAdvancedModal(modalA)

      // Rule 2 inherits Home-JP automatically; filtering HK + all-AI yields 0 (zero Office-HK contamination)
      await grpADialog.getByRole('button', { name: '另加一条筛选' }).click()
      await expectInheritedProbeInRule(ruleA, 'Home-JP')
      await ruleA.getByRole('button', { name: /HK.*香港/ }).click()
      await toggleQuickQualityChip(ruleA, /全\s*AI\s*解锁/)
      await expectQuickChipActive(ruleA, /全\s*AI\s*解锁/, true)

      await expect(grpADialog.getByRole('button', { name: /^预览代理列表/ })).toContainText('1 个节点')
      await grpADialog.getByRole('button', { name: '保存代理组' }).click()
      await expect(page.getByRole('link', { name: 'Group-A', exact: true })).toBeVisible()

      // Group-B bound to Office-HK: sortBy https, topN 1, fallbackWhenEmpty false -> HK-Edge-01
      await page.getByRole('button', { name: '新建代理组', exact: true }).first().click()
      const grpBDialog = page.getByRole('dialog', { name: '新建代理组' })
      await grpBDialog.getByLabel('代理组名称').fill('Group-B')
      await selectGroupProbe(grpBDialog, 'Office-HK')
      const ruleB = getRuleFilterSection(page)
      await toggleQuickQualityChip(ruleB, /全\s*AI\s*解锁/)
      const modalB = await openAdvancedQualityModal(page, ruleB)
      await modalB.getByLabel('组内排序').selectOption('https')
      await modalB.getByLabel('最多保留节点数').fill('1')
      await applyAndCloseAdvancedModal(modalB)
      await expect(grpBDialog.getByRole('button', { name: /^预览代理列表/ })).toContainText('1 个节点')
      await grpBDialog.getByRole('button', { name: '保存代理组' }).click()
      await expect(page.getByRole('link', { name: 'Group-B', exact: true })).toBeVisible()

      // Group-Fallback bound to Office-HK with impossible latency + fallbackWhenEmpty: true
      await page.getByRole('button', { name: '新建代理组', exact: true }).first().click()
      const grpCDialog = page.getByRole('dialog', { name: '新建代理组' })
      await grpCDialog.getByLabel('代理组名称').fill('Group-Fallback')
      await selectGroupProbe(grpCDialog, 'Office-HK')
      const ruleC = getRuleFilterSection(page)
      await ruleC.getByLabel(/^包含正则/).fill('HK-Edge')
      const modalC = await openAdvancedQualityModal(page, ruleC)
      await modalC.getByLabel('最大 HTTPS 延迟（ms）', { exact: true }).fill('5')
      const fallbackSwitch = modalC.getByRole('switch', { name: '筛空时恢复基础候选' })
      if (!(await fallbackSwitch.isChecked())) {
        await fallbackSwitch.click()
      }
      await applyAndCloseAdvancedModal(modalC)
      await expect(grpCDialog.getByRole('button', { name: /^预览代理列表/ })).toContainText('1 个节点')
      await grpCDialog.getByRole('button', { name: '保存代理组' }).click()
      await expect(page.getByRole('link', { name: 'Group-Fallback', exact: true })).toBeVisible()

      // Publish & verify exact YAML group isolation
      await openPublishPage(page, harness.baseUrl)
      await page.getByRole('button', { name: '运行检查' }).click()
      await expect(page.getByText('已完成 Mihomo 校验。')).toBeVisible()
      await page.getByRole('button', { name: '发布配置' }).click()
      await confirmAlertDialog(page, '确认发布')
      await expect(page.getByRole('heading', { name: '当前成品 v1' })).toBeVisible()

      const linkRes = await harness.apiPost<{ url: string }>('/api/link', { action: 'rotate' })
      expect(linkRes.status).toBe(200)
      const subRes = await harness.subGet(linkRes.data.url)
      expect(subRes.status).toBe(200)
      const yaml = parseMihomoYaml(subRes.text)

      assertYamlGroupExactOrder(yaml, 'Group-A', ['🇯🇵 JP-Fast-01'])
      assertYamlGroupExactOrder(yaml, 'Group-B', ['🇭🇰 HK-Edge-01'])
      assertYamlGroupExactOrder(yaml, 'Group-Fallback', ['🇭🇰 HK-Edge-01'])

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
