import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  basicAndAiConfig,
  buildLegacyPreR1Documents,
  buildProxyNode,
  buildSource,
  uniqueId,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  aiReading,
  createMockProbe,
  parseInviteLink,
  type AutoResponderHandle,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  closeModal,
  expectAiUnlockCell,
  expectInheritedProbeInRule,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  expectNoReportBaselinePicker,
  expectQuickChipActive,
  findNodeRow,
  getRuleFilterSection,
  openAdvancedQualityModal,
  openGroupsPage,
  openNodesPage,
  openPublishPage,
  openQualityPage,
  toggleQuickQualityChip,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface SourceNodesPayload {
  good: {
    nodes: Array<{ id: string; name: string }>
  } | null
}

interface WorkspaceStatePayload {
  id: string
  revision: number
  draft: {
    sources: Array<Record<string, unknown>>
    groups: Array<Record<string, unknown>>
    services: unknown[]
    rules: unknown[]
    base: Record<string, unknown>
  }
}

test.describe('T3-P07 Cleanup x Single-Probe x Unified AI UI x Inline Filter (F2, F6, F8, F9)', () => {
  test('T3-P07-01 (F2,F8) (F6,F8): cleaned legacy SQLite and single-probe v4 run render unified 3-surface AI column without dropdowns or baseline picker', async ({ page }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      const profileId = randomUUID()
      const legacySourceId = uniqueId('src_')
      const legacyNodeId = uniqueId('nod_')
      const legacyGroupId = uniqueId('grp_')
      const legacyReportId = randomUUID()
      const legacyDeviceId = randomUUID()

      subServer = await startMockSubServer({
        live: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
          ],
        },
      })

      harness = await startAppHarness({
        seedLegacy: seeder => {
          seeder.seedEntries(
            buildLegacyPreR1Documents(profileId, {
              sourceId: legacySourceId,
              nodeId: legacyNodeId,
              nodeKey: `${legacySourceId}/${legacyNodeId}`,
              groupId: legacyGroupId,
              reportId: legacyReportId,
              deviceId: legacyDeviceId,
            }),
          )
        },
      })

      // Verify startup cleanup purged legacy Grok/Claude fields and report-pinning artifacts (F2, F6)
      const cleanedReport = harness.readDbDoc<Record<string, unknown>>(`quality-reports/${profileId}`, legacyReportId)
      assert.ok(cleanedReport, 'Expected cleaned legacy report to remain readable')
      assertNoLegacyAiStrings(cleanedReport, 'cleanedReport')
      const cleanedResults = cleanedReport.results as Array<{ ai: unknown }>
      assertThreeSurfaceAi(cleanedResults[0].ai)

      const cleanedProfile = harness.readDbDoc<Record<string, unknown>>('profiles', profileId)
      assert.ok(cleanedProfile)
      assert.equal('fixedQualitySnapshot' in cleanedProfile, false)
      assert.equal('qualityBaselinePolicy' in (cleanedProfile.draft as Record<string, unknown>), false)
      assertNoLegacyAiStrings(cleanedProfile, 'cleanedProfile')

      const cleanedVersion = harness.readDbDoc<Record<string, unknown>>(`versions/${profileId}`, '000000000001')
      assert.ok(cleanedVersion)
      assert.equal('qualityReportId' in cleanedVersion, false)
      assert.equal('qualitySnapshot' in cleanedVersion, false)
      assert.equal(harness.readDbDoc(`quality-device/${profileId}`, 'registration'), undefined)
      assert.equal(harness.readDbDoc(`quality-device/${profileId}`, 'next'), undefined)

      // Add live subscription feed and enroll v4 (2.0.0) probe
      const stateRes = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      assert.equal(stateRes.status, 200)
      const liveSource = buildSource({ name: 'Live Sub', url: subServer.urlFor('live') })
      const probeRes = await harness.apiPost('/api/probe', { kind: 'source', id: liveSource.id, url: liveSource.url })
      assert.equal(probeRes.status, 200)

      const draftRes = await harness.apiPost<WorkspaceStatePayload>('/api/draft', {
        revision: stateRes.data.revision,
        draft: {
          ...stateRes.data.draft,
          sources: [...stateRes.data.draft.sources, liveSource],
        },
      })
      assert.equal(draftRes.status, 200)

      const sourceNodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(liveSource.id)}`)
      assert.equal(sourceNodesRes.status, 200)
      const liveNodes = sourceNodesRes.data.good?.nodes ?? []
      assert.equal(liveNodes.length, 2)
      const usNode = liveNodes.find(n => n.name.includes('US-LAX-01'))!
      const jpNode = liveNodes.find(n => n.name.includes('JP-TYO-01'))!
      const usKey = `${liveSource.id}/${usNode.id}`
      const jpKey = `${liveSource.id}/${jpNode.id}`

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      assert.equal(inviteRes.status, 200)
      const invite = parseInviteLink(inviteRes.data.pairing)
      const probe = createMockProbe({ origin: harness.baseUrl, profileId: invite.profileId, name: 'Clean-V4-Probe' })
      assert.equal((await probe.enroll(invite.ticket)).status, 200)

      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      const v4Device = devicesRes.data.find(d => d.name === 'Clean-V4-Probe')
      assert.ok(v4Device)

      const queueRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: v4Device.id,
        keys: [usKey, jpKey],
        config: basicAndAiConfig(),
      })
      assert.equal(queueRes.status, 200)

      const completed = await probe.pollAndComplete(node => {
        if (node.key === usKey) {
          return {
            latencyMs: 65,
            exit: { ip: '198.51.100.10', region: 'US' },
            ai: {
              chatgptWeb: aiReading.green('US', 'chatgptWeb'),
              chatgptApp: aiReading.restricted('region_restricted', 'HK'),
              gemini: aiReading.uncertain('challenge'),
            },
          }
        }
        return {
          latencyMs: 55,
          exit: { ip: '198.51.100.20', region: 'JP' },
          ai: aiPresets.allGreen('JP'),
        }
      })
      assert.equal(completed.completeResponse?.status, 200)

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      // (F2, F8) Verify #/quality Reports tab: no legacy AI platforms, no AI dropdown, unified 3-surface column
      await openQualityPage(page, harness.baseUrl, 'reports')
      await expectNoLegacyAiPlatforms(page)
      await expectNoAiPlatformFilterDropdown(page)
      await expectNoReportBaselinePicker(page)

      const usReportRow = findNodeRow(page, '🇺🇸 US-LAX-01')
      await expectAiUnlockCell(usReportRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      const jpReportRow = findNodeRow(page, '🇯🇵 JP-TYO-01')
      await expectAiUnlockCell(jpReportRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'JP' },
        { surface: 'Gemini Web', tone: 'success', label: 'JP' },
      ])

      // (F6, F8) Verify #/nodes: no QualityBaselinePicker, no AI dropdown, no legacy AI, unified 3-surface column
      await openNodesPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)
      await expectNoLegacyAiPlatforms(page)
      await expectNoAiPlatformFilterDropdown(page)

      const usNodesRow = findNodeRow(page, '🇺🇸 US-LAX-01')
      await expectAiUnlockCell(usNodesRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      // (F6) Verify #/publish: QualityBaselinePicker removed
      await openPublishPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T3-P07-02 (F2,F9) (F8,F9): cleaned legacy group filter strips Grok/Claude and inline quick-filter chips + modal match 3-surface AI unlock status', async ({ page }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      const profileId = randomUUID()
      const legacySourceId = uniqueId('src_')
      const legacyGroupId = uniqueId('grp_')

      subServer = await startMockSubServer({
        nodes: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
            buildProxyNode('🇭🇰 HK-HKG-01', { server: 'hk-hkg-01.example.net', port: 10003 }),
          ],
        },
      })

      harness = await startAppHarness({
        seedLegacy: seeder => {
          seeder.seedEntries(
            buildLegacyPreR1Documents(profileId, {
              sourceId: legacySourceId,
              groupId: legacyGroupId,
            }),
          )
        },
      })

      // Verify system/library and legacy group were cleaned of Claude/Grok (F2)
      const cleanedLibrary = harness.readDbDoc<Record<string, unknown>>('system', 'library')
      assertNoLegacyAiStrings(cleanedLibrary, 'cleanedLibrary')
      const cleanedProfile = harness.readDbDoc<Record<string, unknown>>('profiles', profileId)
      assertNoLegacyAiStrings(cleanedProfile, 'cleanedProfile')

      // Add live source & pair v4 probe with 3-state AI outcomes
      const stateRes = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const liveSource = buildSource({ name: 'Filter Feed', url: subServer.urlFor('nodes') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: liveSource.id, url: liveSource.url })).status, 200)

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const invite = parseInviteLink(inviteRes.data.pairing)
      const probe = createMockProbe({ origin: harness.baseUrl, profileId: invite.profileId, name: 'Filter-V4-Probe' })
      assert.equal((await probe.enroll(invite.ticket)).status, 200)
      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      const v4Device = devicesRes.data.find(d => d.name === 'Filter-V4-Probe')!

      // Update legacyGroup to use the live source and bind single probe qualityDeviceId
      const updatedGroups = stateRes.data.draft.groups.map(group => {
        if (group.id !== legacyGroupId) return group
        return {
          ...group,
          qualityDeviceId: v4Device.id,
          members: [
            {
              kind: 'pool',
              sourceIds: [liveSource.id],
              regions: [],
              includeRegex: '',
              excludeRegex: '',
            },
          ],
        }
      })

      const draftRes = await harness.apiPost<WorkspaceStatePayload>('/api/draft', {
        revision: stateRes.data.revision,
        draft: {
          ...stateRes.data.draft,
          sources: [...stateRes.data.draft.sources, liveSource],
          groups: updatedGroups,
        },
      })
      assert.equal(draftRes.status, 200)

      const sourceNodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(liveSource.id)}`)
      const nodes = sourceNodesRes.data.good?.nodes ?? []
      const usNode = nodes.find(n => n.name.includes('US-LAX-01'))!
      const jpNode = nodes.find(n => n.name.includes('JP-TYO-01'))!
      const hkNode = nodes.find(n => n.name.includes('HK-HKG-01'))!

      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: v4Device.id,
          keys: nodes.map(n => `${liveSource.id}/${n.id}`),
          config: basicAndAiConfig(),
        })).status,
        200,
      )

      const completed = await probe.pollAndComplete(node => {
        if (node.key === `${liveSource.id}/${usNode.id}`) {
          return { latencyMs: 50, exit: { ip: '198.51.100.11', region: 'US' }, ai: aiPresets.allGreen('US') }
        }
        if (node.key === `${liveSource.id}/${jpNode.id}`) {
          return {
            latencyMs: 55,
            exit: { ip: '198.51.100.12', region: 'JP' },
            ai: {
              chatgptWeb: aiReading.green('JP', 'chatgptWeb'),
              chatgptApp: aiReading.restricted('region_restricted', 'HK'),
              gemini: aiReading.uncertain('challenge'),
            },
          }
        }
        assert.equal(node.key, `${liveSource.id}/${hkNode.id}`)
        return {
          latencyMs: 40,
          exit: { ip: '198.51.100.13', region: 'HK' },
          ai: aiPresets.allRestricted('HK'),
        }
      })
      assert.equal(completed.completeResponse?.status, 200)

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, legacyGroupId)

      // (F2, F9) No baseline picker and no legacy Grok/Claude options in cleaned GroupFilter
      await expectNoReportBaselinePicker(page)
      const rule = getRuleFilterSection(page)
      await expectNoLegacyAiPlatforms(rule)
      await expectInheritedProbeInRule(rule, 'Filter-V4-Probe')

      // (F8, F9) Toggling inline quick-filter chip "全 AI 解锁" keeps only node with all 3 green surfaces
      await toggleQuickQualityChip(rule, /全\s*AI\s*解锁/)
      await expectQuickChipActive(rule, /全\s*AI\s*解锁/, true)

      await expect(rule.getByRole('status')).toContainText('匹配 1 个保留节点')
      await expect(rule.locator('.pool-sample')).toContainText('US-LAX-01')
      await expect(rule.locator('.pool-sample')).not.toContainText('JP-TYO-01')
      await expect(rule.locator('.pool-sample')).not.toContainText('HK-HKG-01')

      // (F2, F9) Open "高级质量筛选" modal and confirm zero Grok/Claude surfaces
      const modal = await openAdvancedQualityModal(page, rule)
      await expectNoLegacyAiPlatforms(modal)
      await expect(modal.getByText(/ChatGPT\s*Web/i).first()).toBeVisible()
      await expect(modal.getByText(/ChatGPT\s*APP/i).first()).toBeVisible()
      await expect(modal.getByText(/Gemini\s*Web/i).first()).toBeVisible()
      await closeModal(modal)

      await page.getByRole('button', { name: '保存代理组' }).click()
      await expect.poll(async () => {
        const res = await harness!.apiGet<WorkspaceStatePayload>('/api/state')
        const grp = res.data.draft.groups.find(g => g.id === legacyGroupId) as {
          members?: Array<{ quality?: { aiAll?: boolean } }>
        } | undefined
        return grp?.members?.[0]?.quality?.aiAll === true
      }).toBe(true)

      const finalState = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      assertNoLegacyAiStrings(finalState.data, 'finalStateAfterSave')

      // (F8, F9) Verify #/nodes unified 3-surface AI unlock column + absence of AI dropdown alongside GroupFilter
      await openNodesPage(page, harness.baseUrl)
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

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
