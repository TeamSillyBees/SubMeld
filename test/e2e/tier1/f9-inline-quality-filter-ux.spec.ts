import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  aiPresets,
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
  type RowSpecOverride,
} from '../helpers/mock-probe.ts'
import {
  aiOnlyConfig,
  assertYamlGroupExactOrder,
  basicAndAiConfig,
  basicAndBandwidthConfig,
  basicOnlyConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildSource,
  parseMihomoYaml,
  uniqueId,
} from '../helpers/fixtures.ts'
import {
  attachErrorCollectors,
  closeModal,
  confirmAlertDialog,
  expectInheritedProbeInRule,
  expectNoHorizontalOverflow,
  expectNoLegacyAiPlatforms,
  expectNoReportBaselinePicker,
  expectQuickChipActive,
  getRuleFilterSection,
  openAdvancedQualityModal,
  openGroupsPage,
  openPublishPage,
  runAxeAudit,
  toggleQuickQualityChip,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface DraftStateResponse {
  id: string
  revision: number
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
  draft: {
    groups: Array<{
      id: string
      qualityDeviceId?: string | null
      members: Array<{
        kind: string
        quality?: {
          aiAll?: boolean
          minAvailability?: number
          maxLatencyMs?: number
          maxLossRate?: number
        }
      }>
    }>
  }
}

async function enrollProbe(
  harness: AppHarness,
  name: string,
): Promise<{ probe: MockProbeAgent; deviceId: string }> {
  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin: harness.baseUrl, profileId, name })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
  const device = devicesRes.data.find(d => d.name === name)
  assert.ok(device)
  return { probe, deviceId: device.id }
}

async function setupGroupFilterContext(nodeNames: string[]) {
  const nodes = nodeNames.map((name, idx) =>
    buildProxyNode(name, { server: `gf-${idx}.example.net`, port: 10800 + idx }),
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

  const nodeMap = new Map<string, string>()
  for (const n of draftRes.data.sources[source.id]?.good?.nodes ?? []) {
    nodeMap.set(n.name, `${source.id}/${n.id}`)
  }

  return {
    subServer,
    harness,
    revision: draftRes.data.revision,
    source,
    nodeMap,
  }
}

test.describe('Tier 1 — F9: Proxy Group Inline Quality Filters, Advanced Modal & Probe Inheritance', () => {
  test('T1-F9-01 Inline quick-filter chips & 高级质量筛选 co-locate inside pool rule with zero external baseline picker', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupGroupFilterContext(['🇺🇸 US-LAX-01', '🇯🇵 JP-TYO-01', '🇸🇬 SG-SIN-01'])
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe, deviceId } = await enrollProbe(harness, 'Probe-Rule-A')
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [...ctx.nodeMap.values()],
        config: basicAndAiConfig(),
      })
      await probe.pollAndComplete(() => ({ latencyMs: 60, ai: aiPresets.allGreen('US') }))

      const group = buildProxyGroup({
        name: 'Rule-Layout-Group',
        qualityDeviceId: deviceId,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition() })],
      })
      const saveRes = await harness.apiPost('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      await expectNoReportBaselinePicker(page)
      await expectNoLegacyAiPlatforms(page)

      const ruleScope = getRuleFilterSection(page)
      await expect(ruleScope).toBeVisible()
      await expect(ruleScope.getByText(/订阅源/).first()).toBeVisible()
      await expect(ruleScope.getByText(/地区/).first()).toBeVisible()
      await expect(ruleScope.getByLabel(/包含正则/).first()).toBeVisible()
      await expect(ruleScope.getByLabel(/排除正则/).first()).toBeVisible()

      await expect(ruleScope.getByRole('button', { name: /全\s*AI\s*解锁/ }).or(ruleScope.getByRole('checkbox', { name: /全\s*AI\s*解锁/ })).first()).toBeVisible()
      await expect(ruleScope.getByRole('button', { name: /高可用率/ }).or(ruleScope.getByRole('checkbox', { name: /高可用率/ })).first()).toBeVisible()
      await expect(ruleScope.getByRole('button', { name: /低延迟/ }).or(ruleScope.getByRole('checkbox', { name: /低延迟/ })).first()).toBeVisible()
      await expect(ruleScope.getByRole('button', { name: /低丢包率/ }).or(ruleScope.getByRole('checkbox', { name: /低丢包率/ })).first()).toBeVisible()
      await expect(ruleScope.getByRole('button', { name: /高级质量筛选/ }).first()).toBeVisible()

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F9-02 Multi-select AND quick quality chips narrow matched nodes and persist across reload', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const names = ['N1-Perfect', 'N2-NoAI', 'N3-LowAvail', 'N4-Slow', 'N5-Lossy']
      const ctx = await setupGroupFilterContext(names)
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe, deviceId } = await enrollProbe(harness, 'Probe-Chips')
      const allKeys = names.map(n => ctx.nodeMap.get(n)!)

      // Run 1: N3-LowAvail fails so after 2 runs N3 has 50% availability (< 80%), while others pass
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: allKeys,
        config: basicOnlyConfig({ rounds: 2 }),
      })
      await probe.pollAndComplete((node) =>
        node.name === 'N3-LowAvail'
          ? { available: false, error: 'no_response' }
          : { latencyMs: 60 },
      )

      // Run 2: basic + AI sets final metrics and gives N3-LowAvail 1/2 = 50% availability
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: allKeys,
        config: basicAndAiConfig({ rounds: 2 }),
      })
      await probe.pollAndComplete((node): RowSpecOverride => {
        if (node.name === 'N2-NoAI') return { latencyMs: 60, lossRate: 0, ai: aiPresets.allRestricted('HK') }
        if (node.name === 'N3-LowAvail') return { latencyMs: 60, lossRate: 0, ai: aiPresets.allGreen('US') }
        if (node.name === 'N4-Slow') return { latencyMs: 600, lossRate: 0, ai: aiPresets.allGreen('US') }
        if (node.name === 'N5-Lossy') return { latencyMs: 60, lossRate: 0.3, ai: aiPresets.allGreen('US') }
        return { latencyMs: 60, lossRate: 0, ai: aiPresets.allGreen('US') }
      })

      const group = buildProxyGroup({
        name: 'Quick-Chips-Group',
        qualityDeviceId: deviceId,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition() })],
      })
      const saveRes = await harness.apiPost('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      const rule = getRuleFilterSection(page)

      await toggleQuickQualityChip(rule, /全\s*AI\s*解锁/)
      await expectQuickChipActive(rule, /全\s*AI\s*解锁/, true)
      await expect(rule).toContainText(/匹配\s*4\s*个/)

      await toggleQuickQualityChip(rule, /高可用率/)
      await expectQuickChipActive(rule, /高可用率/, true)
      await expect(rule).toContainText(/匹配\s*3\s*个/)

      await toggleQuickQualityChip(rule, /低延迟/)
      await expectQuickChipActive(rule, /低延迟/, true)
      await expect(rule).toContainText(/匹配\s*2\s*个/)

      await toggleQuickQualityChip(rule, /低丢包率/)
      await expectQuickChipActive(rule, /低丢包率/, true)
      await expect(rule).toContainText(/匹配\s*1\s*个/)

      await Promise.all([
        page.waitForResponse(
          res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/draft') && res.ok(),
        ),
        page.getByRole('button', { name: /保存代理组/ }).click(),
      ])

      await page.reload()
      await openGroupsPage(page, harness.baseUrl, group.id)
      const reloadedRule = getRuleFilterSection(page)
      await expectQuickChipActive(reloadedRule, /全\s*AI\s*解锁/, true)
      await expectQuickChipActive(reloadedRule, /高可用率/, true)
      await expectQuickChipActive(reloadedRule, /低延迟/, true)
      await expectQuickChipActive(reloadedRule, /低丢包率/, true)

      const stateAfter = await harness.apiGet<DraftStateResponse>('/api/state')
      const savedQuality = stateAfter.data.draft.groups[0]?.members[0]?.quality
      assert.equal(savedQuality?.aiAll, true)
      assert.ok((savedQuality?.minAvailability ?? 0) > 0)
      assert.ok((savedQuality?.maxLatencyMs ?? 0) > 0)
      assert.ok((savedQuality?.maxLossRate ?? 0) > 0)

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F9-03 高级质量筛选 modal configures thresholds/sort/topN and compiles expected YAML', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      // Put N-Mid (120 ms) BEFORE N-Fast (50 ms) so topN: 1 + sortBy: 'https' genuinely selects N-Fast
      const names = ['N-Mid', 'N-Fast', 'N-Slow', 'N-Restricted']
      const ctx = await setupGroupFilterContext(names)
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe, deviceId } = await enrollProbe(harness, 'Probe-Modal')
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: names.map(n => ctx.nodeMap.get(n)!),
        config: basicAndBandwidthConfig(),
      })
      await probe.pollAndComplete((node): RowSpecOverride => {
        if (node.name === 'N-Fast') return { latencyMs: 50, speedMbps: 100 }
        if (node.name === 'N-Mid') return { latencyMs: 120, speedMbps: 50 }
        if (node.name === 'N-Slow') return { latencyMs: 400, speedMbps: 10 }
        return { latencyMs: 40, speedMbps: 100 }
      })
      // Restrict N-Restricted on AI separately so bandwidth & basic are preserved
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: names.map(n => ctx.nodeMap.get(n)!),
        config: aiOnlyConfig(),
      })
      await probe.pollAndComplete((node) =>
        node.name === 'N-Restricted'
          ? { exit: null, ai: aiPresets.allRestricted('HK') }
          : { exit: null, ai: aiPresets.allGreen('US') },
      )

      const group = buildProxyGroup({
        name: 'Modal-Config-Group',
        qualityDeviceId: deviceId,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition({ aiAll: true }) })],
      })
      const saveRes = await harness.apiPost('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      const dialog = await openAdvancedQualityModal(page, getRuleFilterSection(page))
      await dialog.getByLabel(/最大\s*HTTPS\s*延迟|最大延迟/).first().fill('200')
      await dialog.getByLabel(/最低带宽|最低速度/).first().fill('30')

      const sortSelect = dialog.getByLabel(/排序方式|质量排序/).first()
      await expect(sortSelect).toBeVisible()
      await sortSelect.selectOption('https')
      await dialog.getByLabel(/最多保留节点数|Top\s*N/i).first().fill('1')

      const applyBtn = dialog.getByRole('button', { name: /应用|确定|保存/ }).first()
      if ((await applyBtn.count()) > 0 && (await applyBtn.isVisible())) {
        await applyBtn.click()
        await expect(dialog).toBeHidden()
      } else {
        await closeModal(dialog)
      }

      await Promise.all([
        page.waitForResponse(
          res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/draft') && res.ok(),
        ),
        page.getByRole('button', { name: /保存代理组/ }).click(),
      ])

      await openPublishPage(page, harness.baseUrl)
      await page.getByRole('button', { name: /发布配置/ }).first().click()
      const publishRespPromise = page.waitForResponse(
        res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/publish') && res.ok(),
      )
      await confirmAlertDialog(page, /确认发布/)
      await publishRespPromise

      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.ok(linkRes.data.url)
      const subRes = await harness.subGet(linkRes.data.url)
      assert.equal(subRes.status, 200)
      const yamlObj = parseMihomoYaml(subRes.text)
      assertYamlGroupExactOrder(yamlObj, group.name, ['N-Fast'])

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F9-04 Single-probe inheritance across multiple pool rules in the same group', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupGroupFilterContext(['🇺🇸 US-LAX-01', '🇯🇵 JP-TYO-01'])
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe: probeAlpha, deviceId: alphaId } = await enrollProbe(harness, 'Probe-Alpha')
      const { probe: probeBeta, deviceId: betaId } = await enrollProbe(harness, 'Probe-Beta')

      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: alphaId,
        keys: [...ctx.nodeMap.values()],
        config: basicOnlyConfig(),
      })
      await probeAlpha.pollAndComplete(() => ({ latencyMs: 40 }))

      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: betaId,
        keys: [...ctx.nodeMap.values()],
        config: basicOnlyConfig(),
      })
      await probeBeta.pollAndComplete(() => ({ available: false, error: 'no_response' }))

      const group = buildProxyGroup({
        name: 'Inherit-Probe-Group',
        qualityDeviceId: null,
        members: [
          buildPoolMember({
            sourceIds: [ctx.source.id],
            regions: ['US'],
            quality: buildQualityCondition({ maxLatencyMs: 200 }),
          }),
        ],
      })
      const saveRes = await harness.apiPost('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      const probeSelect = getRuleFilterSection(page).getByRole('combobox', { name: /探针/ }).first()
      await expect(probeSelect).toBeVisible()
      await probeSelect.selectOption({ value: alphaId })
      await expect(probeSelect).toHaveValue(alphaId)

      const addRuleBtn = page.getByRole('button', { name: /另加一条筛选|添加筛选规则/ }).first()
      await expect(addRuleBtn).toBeVisible()
      await addRuleBtn.click()

      const ruleSections = page.locator('.group-filter')
      await expect(
        ruleSections.nth(1).or(page.getByRole('heading', { name: /新建动态筛选/ })).first(),
      ).toBeVisible()
      const ruleCount = await ruleSections.count()
      const targetRuleScope = ruleCount >= 2 ? ruleSections.nth(1) : ruleSections.first()

      const jpBtn = targetRuleScope
        .locator('.pool-region-list button', { hasText: 'JP' })
        .or(targetRuleScope.getByRole('button', { name: /JP|日本/ }))
        .first()
      await expect(jpBtn).toBeVisible()
      await jpBtn.click()
      await toggleQuickQualityChip(targetRuleScope, /低延迟/)

      const commitNewBtn = targetRuleScope.getByRole('button', { name: /加入全部保留节点/ }).first()
      if ((await commitNewBtn.count()) > 0 && (await commitNewBtn.isVisible())) {
        await commitNewBtn.click()
      }

      await expect(page.locator('.member-order > li')).toHaveCount(2)
      await expect(targetRuleScope).toContainText(/匹配\s*1\s*个/)

      const ruleProbeSelect = targetRuleScope.getByRole('combobox', { name: /探针/ }).first()
      const ruleProbeText = targetRuleScope.getByText('Probe-Alpha').first()
      if ((await ruleProbeSelect.count()) > 0 || (await ruleProbeText.count()) > 0) {
        await expectInheritedProbeInRule(targetRuleScope, 'Probe-Alpha')
      } else {
        const secondRuleRow = page.locator('.member-order > li').nth(1)
        if ((await secondRuleRow.getByText('Probe-Alpha').count()) > 0) {
          await expectInheritedProbeInRule(secondRuleRow, 'Probe-Alpha')
        }
      }
      await expect(probeSelect).toHaveValue(alphaId)

      const previewToggle = page.getByRole('button', { name: /预览代理列表/ }).first()
      await expect(previewToggle).toBeVisible()
      if ((await previewToggle.getAttribute('aria-expanded')) === 'false') {
        await previewToggle.click()
      }
      const previewList = page.locator('.preview-members')
      await expect(previewList).toContainText('🇺🇸 US-LAX-01')
      await expect(previewList).toContainText('🇯🇵 JP-TYO-01')

      await Promise.all([
        page.waitForResponse(
          res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/draft') && res.ok(),
        ),
        page.getByRole('button', { name: /保存代理组/ }).click(),
      ])
      const stateAfter = await harness.apiGet<DraftStateResponse>('/api/state')
      assert.equal(stateAfter.data.draft.groups[0]?.qualityDeviceId, alphaId)
      assert.equal(stateAfter.data.draft.groups[0]?.members.filter(m => m.kind === 'pool').length, 2)

      const checkRes = await harness.apiPost<{ groups: Array<{ id: string; members: Array<{ name: string }> }> }>('/api/check', {})
      assert.equal(checkRes.status, 200)
      assert.deepEqual(
        checkRes.data.groups[0]?.members.map(m => m.name),
        ['🇺🇸 US-LAX-01', '🇯🇵 JP-TYO-01'],
      )

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F9-05 Desktop & Mobile WCAG 2.1 AA Axe audit and zero overflow for inline filter and modal', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupGroupFilterContext(['🇺🇸 US-LAX-01', '🇯🇵 JP-TYO-01'])
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe, deviceId } = await enrollProbe(harness, 'Probe-Axe')
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [...ctx.nodeMap.values()],
        config: basicAndAiConfig(),
      })
      await probe.pollAndComplete(() => ({ latencyMs: 50, ai: aiPresets.allGreen('US') }))

      const group = buildProxyGroup({
        name: 'Axe-Filter-Group',
        qualityDeviceId: deviceId,
        members: [
          buildPoolMember({
            sourceIds: [ctx.source.id],
            quality: buildQualityCondition({ aiAll: true, maxLatencyMs: 250 }),
          }),
        ],
      })
      const saveRes = await harness.apiPost('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      await page.setViewportSize({ width: 1440, height: 940 })
      await openGroupsPage(page, harness.baseUrl, group.id)
      await expectNoHorizontalOverflow(page, 1440)
      await runAxeAudit(page, 'Groups inline filter desktop 1440')

      let dialog = await openAdvancedQualityModal(page, getRuleFilterSection(page))
      await runAxeAudit(page, 'Advanced quality modal desktop 1440', { include: '[role="dialog"]' })
      await closeModal(dialog)

      await page.setViewportSize({ width: 390, height: 844 })
      await expectNoHorizontalOverflow(page, 390)
      await runAxeAudit(page, 'Groups inline filter mobile 390')

      dialog = await openAdvancedQualityModal(page, getRuleFilterSection(page))
      await runAxeAudit(page, 'Advanced quality modal mobile 390', { include: '[role="dialog"]' })
      await closeModal(dialog)

      await page.setViewportSize({ width: 320, height: 700 })
      await expectNoHorizontalOverflow(page, 320)

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
