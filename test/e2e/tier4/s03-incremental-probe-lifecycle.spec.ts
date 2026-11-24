import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  aiOnlyConfig,
  assertAvailabilityStats,
  assertThreeSurfaceAi,
  assertYamlGroupExactOrder,
  basicOnlyConfig,
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
  findNodeRow,
  openGroupsPage,
  openNodesPage,
  openPublishPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

test.describe('T4-S03 Incremental Probe Lifecycle', () => {
  test('builds rolling basic availability, preserves it during ai-only run, and admits unlocked nodes', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        pool: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇯🇵 JP-01', { server: 'jp-01.example.net', port: 10001 }),
            buildProxyNode('🇺🇸 US-01', { server: 'us-01.example.net', port: 10002 }),
            buildProxyNode('🇸🇬 SG-01', { server: 'sg-01.example.net', port: 10003 }),
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
        name: 'Inc-Probe',
        capabilities: defaultV4Capabilities(),
      })
      expect((await probe.enroll(parsed.ticket)).status).toBe(200)
      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      const device = devicesRes.data.find(d => d.name === 'Inc-Probe')
      assert.ok(device)

      // Seed source + AI-Pool group bound to Inc-Probe
      const stateRes = await harness.apiGet<{ revision: number }>('/api/state')
      const source = buildSource({ id: uniqueId('src_'), name: 'Pool-Sub', url: subServer.urlFor('pool') })
      const group = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'AI-Pool',
        qualityDeviceId: device.id,
        members: [
          buildPoolMember({
            sourceIds: [source.id],
            quality: buildQualityCondition({ aiAll: true, minAvailability: 0.8 }),
          }),
          { kind: 'builtin', id: 'DIRECT' },
        ],
      })
      const saveRes = await harness.apiPost<{ revision: number }>('/api/draft', {
        revision: stateRes.data.revision,
        draft: buildDraft({ sources: [source], groups: [group] }),
      })
      expect(saveRes.status).toBe(200)
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

      // Publish v1 before any probe checks (0 matching proxy nodes -> falls back to DIRECT)
      const checkState = await harness.apiGet<{ revision: number }>('/api/state')
      expect((await harness.apiPost('/api/publish', { revision: checkState.data.revision })).status).toBe(200)
      const linkRes = await harness.apiPost<{ url: string }>('/api/link', { action: 'rotate' })
      expect(linkRes.status).toBe(200)
      const subUrl = linkRes.data.url
      const v1Sub = await harness.subGet(subUrl)
      expect(v1Sub.status).toBe(200)
      assertYamlGroupExactOrder(parseMihomoYaml(v1Sub.text), 'AI-Pool', ['DIRECT'])

      // 1. Run 4 sequential basic-only checks with mixed pass/fail outcomes
      for (let round = 0; round < 4; round++) {
        const qRes = await harness.apiPost('/api/quality/queue', {
          targetDeviceId: device.id,
          keys: nodeKeys,
          config: basicOnlyConfig(),
        })
        expect(qRes.status).toBe(200)

        const res = await probe.pollAndComplete(node => {
          if (node.name.includes('JP-01')) {
            return { latencyMs: 55, lossRate: 0, exit: { ip: '198.51.100.11', region: 'JP' } }
          }
          if (node.name.includes('US-01')) {
            if (round === 3) return { available: false, error: 'no_response' }
            return { latencyMs: 88, lossRate: 0, exit: { ip: '198.51.100.12', region: 'US' } }
          }
          if (round === 0) {
            return { latencyMs: 110, lossRate: 0, exit: { ip: '198.51.100.13', region: 'SG' } }
          }
          return { available: false, error: 'no_response' }
        })
        expect(res.completeResponse?.status).toBe(200)
      }

      const afterBasicLatestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(device.id)}`)
      expect(afterBasicLatestRes.status).toBe(200)
      const afterBasicLatest = unwrapLatestForDevice(afterBasicLatestRes.data, device.id)
      const jpRecord = Object.values(afterBasicLatest).find(r => r.basic?.exit?.region === 'JP')
      const usRecord = Object.values(afterBasicLatest).find(
        r => r.availability?.success === 3 && r.availability?.total === 4,
      )
      const sgRecord = Object.values(afterBasicLatest).find(r => r.availability?.success === 1)
      assert.ok(jpRecord && usRecord && sgRecord, 'Expected all 3 node latest records after basic runs')
      assert.equal(usRecord.basic?.httpsMs, null)
      assert.equal(usRecord.basic?.available, false)
      assertAvailabilityStats(jpRecord.availability, 4, 4)
      assertAvailabilityStats(usRecord.availability, 3, 4)
      assertAvailabilityStats(sgRecord.availability, 1, 4)
      assert.equal(jpRecord.ai, null)
      assert.equal(usRecord.ai, null)

      // Verify #/nodes renders multi-check availability percentages (100%, 75%, 25%)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openNodesPage(page, harness.baseUrl)
      await expectAvailabilityBadgeOrText(findNodeRow(page, '🇯🇵 JP-01'), '100%')
      await expectAvailabilityBadgeOrText(findNodeRow(page, '🇺🇸 US-01'), '75%')
      await expectAvailabilityBadgeOrText(findNodeRow(page, '🇸🇬 SG-01'), '25%')

      // 2. Run standalone ai-only job (basic: false, ai: true)
      const aiQueueRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: device.id,
        keys: nodeKeys,
        config: aiOnlyConfig(),
      })
      expect(aiQueueRes.status).toBe(200)

      const aiRun = await probe.pollAndComplete(node => {
        if (node.name.includes('JP-01')) {
          return {
            exit: { ip: '198.51.100.11', region: 'JP' },
            ai: aiPresets.allGreen('JP'),
          }
        }
        if (node.name.includes('US-01')) {
          // Omit available: false per aiOnlyConfig invariant when exit is null & mixed AI
          return {
            exit: null,
            ai: aiPresets.mixed('US'),
          }
        }
        return {
          exit: null,
          ai: aiPresets.allRestricted('HK'),
        }
      })
      expect(aiRun.assignment?.config.basic).toBe(false)
      expect(aiRun.assignment?.config.ai).toBe(true)
      expect(aiRun.report?.results.every(r => r.samples.length === 0)).toBe(true)
      expect(aiRun.completeResponse?.status).toBe(200)

      // 3. Verify quality-latest preserved basic & availability while updating 3-surface AI
      const afterAiLatestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(device.id)}`)
      expect(afterAiLatestRes.status).toBe(200)
      const afterAiLatest = unwrapLatestForDevice(afterAiLatestRes.data, device.id)
      const jpMerged = afterAiLatest[jpRecord.nodeKey]
      const usMerged = afterAiLatest[usRecord.nodeKey]
      const sgMerged = afterAiLatest[sgRecord.nodeKey]
      assertAvailabilityStats(jpMerged.availability, 4, 4)
      assertAvailabilityStats(usMerged.availability, 3, 4)
      assertAvailabilityStats(sgMerged.availability, 1, 4)
      expect(jpMerged.basic?.httpsMs).toBe(jpRecord.basic?.httpsMs)
      expect(usMerged.basic?.available).toBe(false)
      assertThreeSurfaceAi(jpMerged.ai?.results)
      assertThreeSurfaceAi(usMerged.ai?.results)
      assertThreeSurfaceAi(sgMerged.ai?.results)

      // 4. Reload #/nodes: availability unchanged & 3-surface AI column rendered
      await page.reload()
      await expect(page.locator('#main-content')).toBeVisible()
      const jpRow = findNodeRow(page, '🇯🇵 JP-01')
      await expectAvailabilityBadgeOrText(jpRow, '100%')
      await expectAiUnlockCell(jpRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'JP' },
        { surface: 'Gemini Web', tone: 'success', label: 'JP' },
      ])

      const usRow = findNodeRow(page, '🇺🇸 US-01')
      await expectAvailabilityBadgeOrText(usRow, '75%')
      await expectAiUnlockCell(usRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      const sgRow = findNodeRow(page, '🇸🇬 SG-01')
      await expectAvailabilityBadgeOrText(sgRow, '25%')
      await expectAiUnlockCell(sgRow, [
        { surface: 'ChatGPT Web', tone: 'danger', label: '受限' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'danger', label: '受限' },
      ])

      // 5. Open #/groups/<id> and verify dynamic admission of JP-01, then publish & verify YAML
      await openGroupsPage(page, harness.baseUrl, group.id)
      const previewHeading = page.getByRole('button', { name: /^预览代理列表/ })
      await expect(previewHeading).toContainText('1 个节点')
      await previewHeading.click()
      await expect(page.locator('.preview-members')).toContainText('🇯🇵 JP-01')
      await expect(page.locator('.preview-members')).not.toContainText('🇺🇸 US-01')
      await expect(page.locator('.preview-members')).not.toContainText('🇸🇬 SG-01')

      // Completing aiOnlyConfig() triggered refreshQuality() auto-publish of v2
      const autoSubRes = await harness.subGet(subUrl)
      expect(autoSubRes.status).toBe(200)
      assertYamlGroupExactOrder(parseMihomoYaml(autoSubRes.text), 'AI-Pool', ['🇯🇵 JP-01', 'DIRECT'])

      await openPublishPage(page, harness.baseUrl)
      await expect(page.getByRole('heading', { name: '当前成品 v2' })).toBeVisible()
      await expect(page.getByRole('region', { name: '当前成品 v2' })).toContainText('自动更新')

      await page.getByRole('button', { name: '重新发布', exact: true }).click()
      await confirmAlertDialog(page, '确认发布')
      await expect(page.getByRole('heading', { name: '当前成品 v3' })).toBeVisible()

      const historyTable = page.getByRole('region', { name: '版本历史' }).last().getByRole('table')
      await expect(historyTable.getByRole('row').filter({ hasText: /^v3\b/ })).toContainText('当前版本 · 手动发布')
      await expect(historyTable.getByRole('row').filter({ hasText: /^v2\b/ })).toContainText('历史有效 · 自动更新')
      await expect(historyTable.getByRole('row').filter({ hasText: /^v1\b/ })).toContainText('历史有效 · 手动发布')

      const subRes = await harness.subGet(subUrl)
      expect(subRes.status).toBe(200)
      const yaml = parseMihomoYaml(subRes.text)
      assertYamlGroupExactOrder(yaml, 'AI-Pool', ['🇯🇵 JP-01', 'DIRECT'])

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
