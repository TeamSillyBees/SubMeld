import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { aiPresets, createMockProbe, parseInviteLink, type QualityNode } from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  assertNoLegacyAiStrings,
  assertYamlGroupExactOrder,
  basicOnlyConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildSource,
  getYamlGroupProxies,
  parseMihomoYaml,
  uniqueId,
  type QualityScheduleConfig,
} from '../helpers/fixtures.ts'
import {
  attachErrorCollectors,
  closeModal,
  configureQualitySchedule,
  expectNoLegacyAiPlatforms,
  expectQuickChipActive,
  getRuleFilterSection,
  openAdvancedQualityModal,
  openGroupsPage,
  openQualityPage,
  toggleQuickQualityChip,
  triggerScheduleRunButton,
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

interface VersionSummary {
  seq: number
  kind: 'publish' | 'auto' | 'rollback'
  parent: number | null
}

interface LinkResponse {
  url: string | null
  active: boolean
  revoked: boolean
}

test.describe('T3-P05 R1 3-Surface AI, Quality Scheduler & Inline Dynamic Filters (F1, F7, F9)', () => {
  test('T3-P05-01 (F1,F7,F9): configures schedules in #/quality, sets inline quick chips without Grok/Claude in #/groups, and scheduled AI run auto-publishes updated Mihomo YAML', async ({
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
            buildProxyNode('🇺🇸 US-Unlock-01', { server: 'us-unlock.example.net', port: 10001 }),
            buildProxyNode('🇭🇰 HK-Locked-02', { server: 'hk-locked.example.net', port: 10002 }),
          ],
        },
      })
      harness = await startAppHarness()

      const sourceId = uniqueId('src_')
      const source = buildSource({ id: sourceId, name: 'P05 订阅', url: subServer.urlFor('main') })
      const initState = await harness.apiGet<StateResponse>('/api/state')
      expect(initState.ok).toBe(true)
      expect((await harness.apiPost('/api/probe', { kind: 'source', id: sourceId, url: source.url })).ok).toBe(true)

      // Pair v4 probe
      const invite = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(invite.status).toBe(200)
      const parsed = parseInviteLink(invite.data.pairing)
      const probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsed.profileId,
        name: 'P05-V4-Probe',
      })
      expect((await probe.enroll(parsed.ticket)).status).toBe(200)

      const devicesRes = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices')
      const device = devicesRes.data.find(d => d.name === 'P05-V4-Probe')
      assert.ok(device)

      // Create group bound to v4 probe (initially without quality quick chips; UI will toggle them)
      const groupId = uniqueId('grp_')
      const group = buildProxyGroup({
        id: groupId,
        name: 'AI-Scheduled-Group',
        qualityDeviceId: device.id,
        members: [
          buildPoolMember({
            sourceIds: [sourceId],
          }),
          { kind: 'builtin', id: 'DIRECT' },
        ],
      })

      const savedDraftRes = await harness.apiPost<StateResponse>('/api/draft', {
        revision: initState.data.revision,
        draft: buildDraft({
          ...initState.data.draft,
          sources: [source],
          groups: [group],
        }),
      })
      expect(savedDraftRes.status).toBe(200)

      const nodesRes = await harness.apiGet<SourceNodesResponse>(`/api/source-nodes?id=${encodeURIComponent(sourceId)}`)
      const keys = (nodesRes.data.good?.nodes ?? []).map(n => `${sourceId}/${n.id}`)
      expect(keys).toHaveLength(2)

      // Seed initial basic-only check (both nodes pass 100%, AI untested)
      const basicQueue = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: device.id,
        keys,
        config: basicOnlyConfig({ rounds: 2 }),
      })
      expect(basicQueue.status).toBe(200)
      const basicRun = await probe.pollAndComplete(() => ({ latencyMs: 60 }))
      expect(basicRun.completeResponse?.status).toBe(200)

      // (F1,F7): Open #/quality 定时任务 tab and configure basic + AI schedule with autoRefreshGroups
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openQualityPage(page, harness.baseUrl, 'schedules')
      await expectNoLegacyAiPlatforms(page)

      await configureQualitySchedule(page, {
        probeName: /P05-V4-Probe/,
        scope: 'kept',
        autoRefreshGroups: true,
        basic: { enabled: true, intervalMinutes: 1440, bandwidth: false },
        ai: { enabled: true, intervalMinutes: 4320 },
      })

      const scheduleRes = await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')
      expect(scheduleRes.status).toBe(200)
      expect(scheduleRes.data.targetDeviceId).toBe(device.id)
      expect(scheduleRes.data.autoRefreshGroups).toBe(true)
      expect(scheduleRes.data.basic.enabled).toBe(true)
      expect(scheduleRes.data.ai.enabled).toBe(true)

      // (F1,F9): Open #/groups/<id> and configure inline AND quick-filter chips (全 AI 解锁 + 高可用率)
      await openGroupsPage(page, harness.baseUrl, groupId)
      const ruleSection = getRuleFilterSection(page)
      await expect(ruleSection).toBeVisible()
      await expectNoLegacyAiPlatforms(ruleSection)

      await toggleQuickQualityChip(ruleSection, /全\s*AI\s*解锁/)
      await expectQuickChipActive(ruleSection, /全\s*AI\s*解锁/, true)
      await toggleQuickQualityChip(ruleSection, /高可用率/)
      await expectQuickChipActive(ruleSection, /高可用率/, true)

      // Inspect "高级质量筛选" modal and verify zero Grok/Claude platform options
      const modal = await openAdvancedQualityModal(page, ruleSection)
      await expectNoLegacyAiPlatforms(modal)
      await closeModal(modal)

      const saveBtn = page.getByRole('button', { name: '保存代理组' })
      await expect(saveBtn).toBeVisible()
      const saveDraftPromise = page.waitForResponse(
        res => res.url().includes('/api/draft') && res.request().method() === 'POST',
      )
      await saveBtn.click()
      const saveDraftHttp = await saveDraftPromise
      expect(saveDraftHttp.ok()).toBe(true)

      // Publish v1 before AI unlock data exists -> AI-Scheduled-Group has no qualified nodes yet
      const stateBeforePub = await harness.apiGet<StateResponse>('/api/state')
      const pubRes = await harness.apiPost<StateResponse>('/api/publish', {
        revision: stateBeforePub.data.revision,
      })
      expect(pubRes.status).toBe(200)

      const linkRes = await harness.apiPost<LinkResponse>('/api/link', { action: 'rotate' })
      expect(linkRes.status).toBe(200)
      assert.ok(linkRes.data.url)

      const v1Sub = await harness.subGet(linkRes.data.url)
      expect(v1Sub.status).toBe(200)
      const v1Yaml = parseMihomoYaml(v1Sub.text)
      const v1Proxies = getYamlGroupProxies(v1Yaml, 'AI-Scheduled-Group')
      expect(v1Proxies).toEqual(['DIRECT'])
      expect(v1Proxies).not.toContain('🇺🇸 US-Unlock-01')
      expect(v1Proxies).not.toContain('🇭🇰 HK-Locked-02')

      // (F7,F9): Trigger scheduled AI run from #/quality UI and complete with 3-surface AI results
      await openQualityPage(page, harness.baseUrl, 'schedules')
      await triggerScheduleRunButton(page, 'ai')

      const aiRun = await probe.pollAndComplete((node: QualityNode) => {
        if (node.name.includes('US-Unlock-01')) {
          return { exit: { ip: '198.51.100.41', region: 'US' }, ai: aiPresets.allGreen('US') }
        }
        return { exit: null, ai: aiPresets.allRestricted('HK') }
      })
      expect(aiRun.assignment?.config.basic).toBe(false)
      expect(aiRun.assignment?.config.ai).toBe(true)
      expect(aiRun.completeResponse?.status).toBe(200)

      // Complete synchronously awaits refreshQuality(), so 'auto' v2 is already published
      const historyRes = await harness.apiGet<VersionSummary[]>('/api/history')
      expect(historyRes.status).toBe(200)
      expect(historyRes.data[0]?.seq).toBe(2)
      expect(historyRes.data[0]?.kind).toBe('auto')
      expect(historyRes.data[0]?.parent).toBe(1)

      const v2Sub = await harness.subGet(linkRes.data.url)
      expect(v2Sub.status).toBe(200)
      const v2Yaml = parseMihomoYaml(v2Sub.text)
      assertNoLegacyAiStrings(v2Yaml)
      assertYamlGroupExactOrder(v2Yaml, 'AI-Scheduled-Group', ['🇺🇸 US-Unlock-01', 'DIRECT'])
      expect(getYamlGroupProxies(v2Yaml, 'AI-Scheduled-Group')).not.toContain('🇭🇰 HK-Locked-02')

      errors.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
