import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  assertYamlGroupExactOrder,
  buildLegacyPreR1Documents,
  buildProxyNode,
  parseMihomoYaml,
  uniqueId,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  createMockProbe,
  defaultV4Capabilities,
  legacyV2Capabilities,
  parseInviteLink,
  type AutoResponderHandle,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  confirmAlertDialog,
  expectAiUnlockCell,
  expectAvailabilityBadgeOrText,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  expectNoReportBaselinePicker,
  expectQuickChipActive,
  findNodeRow,
  getRuleFilterSection,
  openGroupsPage,
  openNodesPage,
  openPublishPage,
  openQualityPage,
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

test.describe('T4-S02 Legacy Upgrade & Migration', () => {
  test('cleans pre-R1 SQLite data, rejects legacy 1.3.0 probes, upgrades to v4 probe & unified UI', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        legacy: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-Node-01', { server: 'us-node-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-Node-02', { server: 'jp-node-02.example.net', port: 10002 }),
          ],
        },
      })

      const profileId = uniqueId('prof_')
      const sourceId = uniqueId('src_')
      const groupId = uniqueId('grp_')
      const legacyReportId = randomUUID()
      const legacyDeviceId = randomUUID()

      harness = await startAppHarness({
        seedLegacy: seeder => {
          seeder.seedEntries(
            buildLegacyPreR1Documents(profileId, {
              sourceId,
              groupId,
              reportId: legacyReportId,
              deviceId: legacyDeviceId,
            }),
          )
        },
      })

      // 1. Verify startup cleanup purged Grok/Claude & obsolete pinning/registration artifacts
      const cleanedProfile = harness.readDbDoc<Record<string, unknown>>('profiles', profileId)
      assert.ok(cleanedProfile, 'Expected profile document in SQLite')
      assert.equal('fixedQualitySnapshot' in cleanedProfile, false)
      assertNoLegacyAiStrings(cleanedProfile)

      const cleanedVersion = harness.readDbDoc<Record<string, unknown>>(`versions/${profileId}`, '000000000001')
      assert.ok(cleanedVersion, 'Expected legacy version document')
      assert.equal('qualitySnapshot' in cleanedVersion, false)
      assert.equal('qualityReportId' in cleanedVersion, false)
      assertNoLegacyAiStrings(cleanedVersion)

      const legacyDeviceKeys = harness.listDbSpace(`quality-device/${profileId}`).map(d => d.key)
      assert.equal(legacyDeviceKeys.includes('registration'), false)
      assert.equal(legacyDeviceKeys.includes('next'), false)

      const cleanedLibrary = harness.readDbDoc('system', 'library')
      assertNoLegacyAiStrings(cleanedLibrary)

      const reportRes = await harness.apiGet<{ results: Array<{ ai: unknown }> }>(
        `/api/quality/report?id=${encodeURIComponent(legacyReportId)}`,
      )
      expect(reportRes.status).toBe(200)
      assertNoLegacyAiStrings(reportRes.data)
      assertThreeSurfaceAi(reportRes.data.results[0]?.ai)

      // 2. Verify legacy 1.3.0 (protocol v2) and pre-seeded 1.3.1 (protocol v3) probe rejection
      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(inviteRes.status).toBe(200)
      const legacyParsed = parseInviteLink(inviteRes.data.pairing)

      const legacyProbe = createMockProbe({
        origin: harness.baseUrl,
        profileId: legacyParsed.profileId,
        name: 'Legacy-1.3.0',
        capabilities: legacyV2Capabilities(),
      })
      const legacyEnroll = await legacyProbe.enroll(legacyParsed.ticket)
      expect(legacyEnroll.status).toBe(200)

      // Point source to mock sub server and refresh so valid node keys exist for queue checks
      const stateRes = await harness.apiGet<{
        revision: number
        draft: { sources: Array<{ id: string; url: string }>; [k: string]: unknown }
      }>('/api/state')
      expect(stateRes.status).toBe(200)
      const updatedDraft = {
        ...stateRes.data.draft,
        sources: stateRes.data.draft.sources.map(s =>
          s.id === sourceId ? { ...s, url: subServer!.urlFor('legacy') } : s,
        ),
      }
      const draftSaveRes = await harness.apiPost('/api/draft', {
        revision: stateRes.data.revision,
        draft: updatedDraft,
      })
      expect(draftSaveRes.status).toBe(200)
      const refreshRes = await harness.apiPost('/api/refresh', { id: sourceId })
      expect(refreshRes.status).toBe(200)

      let refreshedKeys: string[] = []
      const activeHarness = harness
      await expect
        .poll(async () => {
          const nodesRes = await activeHarness.apiGet<{ good: { nodes: Array<{ id: string }> } | null }>(
            `/api/source-nodes?id=${encodeURIComponent(sourceId)}`,
          )
          refreshedKeys = (nodesRes.data.good?.nodes ?? []).map(n => `${sourceId}/${n.id}`)
          return refreshedKeys.length
        })
        .toBe(2)

      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      expect(devicesRes.status).toBe(200)
      const enrolledLegacy = devicesRes.data.find(d => d.name === 'Legacy-1.3.0')
      assert.ok(enrolledLegacy, 'Expected Legacy-1.3.0 in devices list')

      // Legacy 1.3.0 rejected on queue (409), schedule/run (409), and poll returns null
      const legacyQueueRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: enrolledLegacy.id,
        keys: refreshedKeys,
        config: { basic: true, rounds: 3, concurrency: 4, bandwidth: false, speedConcurrency: 1, seconds: 5, mebibytes: 4, ai: true },
      })
      expect(legacyQueueRes.status).toBe(409)

      const v3QueueRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: legacyDeviceId,
        keys: refreshedKeys,
        config: { basic: true, rounds: 3, concurrency: 4, bandwidth: false, speedConcurrency: 1, seconds: 5, mebibytes: 4, ai: true },
      })
      expect(v3QueueRes.status).toBe(409)

      const legacySchedSave = await harness.apiPost('/api/quality/schedule', {
        targetDeviceId: enrolledLegacy.id,
        scope: 'kept',
        autoRefreshGroups: true,
        basic: { enabled: true, intervalMinutes: 1440, rounds: 3, concurrency: 4, bandwidth: false },
        ai: { enabled: false, intervalMinutes: 4320, concurrency: 4 },
      })
      expect(legacySchedSave.status).toBe(200)
      const legacySchedRun = await harness.apiPost('/api/quality/schedule/run', { kind: 'basic' })
      expect(legacySchedRun.status).toBe(409)

      const legacyPoll = await legacyProbe.poll({ wait: false })
      expect(legacyPoll.status).toBe(200)
      expect(legacyPoll.body).toBeNull()

      // 3. UI verification: #/quality probes & reports tabs, pair 2.0.0 v4 probe
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openQualityPage(page, harness.baseUrl, 'probes')
      await expect(page.getByText('Legacy-1.3.0')).toBeVisible()

      const uiInvitePromise = page.waitForResponse(
        res => res.url().includes('/api/quality/invite') && res.request().method() === 'POST',
      )
      await page.getByRole('button', { name: '复制电脑配对链接', exact: true }).click()
      const uiInviteJson = (await (await uiInvitePromise).json()) as { pairing: string }
      const v4Parsed = parseInviteLink(uiInviteJson.pairing)

      const v4Probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: v4Parsed.profileId,
        name: 'Modern-v4',
        capabilities: defaultV4Capabilities(),
      })
      expect((await v4Probe.enroll(v4Parsed.ticket)).status).toBe(200)
      await expect(page.getByText('Modern-v4')).toBeVisible({ timeout: 15_000 })

      await openQualityPage(page, harness.baseUrl, 'reports')
      await expectNoLegacyAiPlatforms(page)
      await expectNoAiPlatformFilterDropdown(page)

      // 4. Execute v4 basic+ai run and verify unified #/nodes UI + version compatibility
      const devicesAfter = await harness.apiGet<Array<{ id: string; name: string; agentVersion?: string }>>('/api/quality/devices')
      const modernDevice = devicesAfter.data.find(d => d.name === 'Modern-v4')
      const legacyDeviceAfter = devicesAfter.data.find(d => d.name === 'Legacy-1.3.0')
      assert.ok(modernDevice, 'Expected Modern-v4 device')
      assert.equal(modernDevice.agentVersion, '2.0.0')
      assert.equal(legacyDeviceAfter?.agentVersion, '1.3.0')

      const v4QueueRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: modernDevice.id,
        keys: refreshedKeys,
        config: { basic: true, rounds: 3, concurrency: 4, bandwidth: false, speedConcurrency: 1, seconds: 5, mebibytes: 4, ai: true },
      })
      expect(v4QueueRes.status).toBe(200)

      const v4Run = await v4Probe.pollAndComplete(node => {
        if (node.name.includes('US-Node-01')) {
          return { latencyMs: 50, lossRate: 0, exit: { ip: '198.51.100.21', region: 'US' }, ai: aiPresets.allGreen('US') }
        }
        return { latencyMs: 95, lossRate: 0, exit: { ip: '198.51.100.22', region: 'JP' }, ai: aiPresets.mixed('JP') }
      })
      expect(v4Run.completeResponse?.status).toBe(200)

      await openNodesPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)
      await expectNoAiPlatformFilterDropdown(page)
      await expectNoLegacyAiPlatforms(page)

      // Verify QualityDialog shows minimum version requirement and disables legacy probes
      await page.getByRole('button', { name: '质量检测', exact: true }).click()
      const qualityDialog = page.getByRole('dialog', { name: '节点质量检测' })
      await expect(qualityDialog).toBeVisible()
      await expect(qualityDialog.getByText('正在读取检测记录…')).toBeHidden()
      const newCheckBtn = qualityDialog.getByRole('button', { name: '新建检测', exact: true })
      if (await newCheckBtn.isVisible()) {
        await newCheckBtn.click()
      }
      await expect(qualityDialog.getByText('需更新至 2.0.0').first()).toBeVisible()
      await expect(qualityDialog.getByRole('radio', { name: 'Legacy-1.3.0' })).toBeDisabled()
      await qualityDialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(qualityDialog).toBeHidden()

      const usRow = findNodeRow(page, '🇺🇸 US-Node-01')
      await expectAiUnlockCell(usRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])
      await expectAvailabilityBadgeOrText(usRow, '100%')

      const jpRow = findNodeRow(page, '🇯🇵 JP-Node-02')
      await expectAiUnlockCell(jpRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      // 5. Inspect migrated group on #/groups, bind v4 probe, apply quick chip, save & publish
      await openGroupsPage(page, harness.baseUrl, groupId)
      await expectNoReportBaselinePicker(page)
      await expectNoLegacyAiPlatforms(page)
      await selectGroupProbe(page, 'Modern-v4')
      const rule = getRuleFilterSection(page)
      await toggleQuickQualityChip(rule, /全\s*AI\s*解锁/)
      await expectQuickChipActive(rule, /全\s*AI\s*解锁/, true)
      const saveDraftPromise = page.waitForResponse(
        res => res.url().includes('/api/draft') && res.request().method() === 'POST',
      )
      await page.getByRole('button', { name: '保存代理组' }).click()
      const saveDraftHttp = await saveDraftPromise
      expect(saveDraftHttp.ok()).toBe(true)

      await openPublishPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)
      await page.getByRole('button', { name: '运行检查' }).click()
      await expect(page.getByText('已完成 Mihomo 校验。')).toBeVisible()
      await page.getByRole('button', { name: '发布配置' }).click()
      await confirmAlertDialog(page, '确认发布')
      await expect(page.getByRole('heading', { name: /当前成品 v\d+/ })).toBeVisible()

      const linkRes = await harness.apiPost<{ url: string }>('/api/link', { action: 'rotate' })
      expect(linkRes.status).toBe(200)
      const subRes = await harness.subGet(linkRes.data.url)
      expect(subRes.status).toBe(200)
      const yaml = parseMihomoYaml(subRes.text)
      assertNoLegacyAiStrings(yaml)
      assertYamlGroupExactOrder(yaml, 'Legacy AI Group', ['🇺🇸 US-Node-01'])

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
