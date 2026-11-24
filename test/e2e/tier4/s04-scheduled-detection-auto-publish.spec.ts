import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
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
  configureQualitySchedule,
  confirmAlertDialog,
  openPublishPage,
  openQualityPage,
  triggerScheduleRunButton,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

test.describe('T4-S04 Scheduled Detection & Auto-Publish', () => {
  test('persists daily basic & 3-day ai schedules, runs due & triggered checks, and auto-publishes v2 YAML', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        sched: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-Alpha', { server: 'us-alpha.example.net', port: 10001 }),
            buildProxyNode('🇩🇪 DE-Beta', { server: 'de-beta.example.net', port: 10002 }),
          ],
        },
      })

      harness = await startAppHarness({ tickMs: 0 })

      // Pair v4 probe
      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(inviteRes.status).toBe(200)
      const parsed = parseInviteLink(inviteRes.data.pairing)
      const probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsed.profileId,
        name: 'Sched-Probe',
        capabilities: defaultV4Capabilities(),
      })
      expect((await probe.enroll(parsed.ticket)).status).toBe(200)
      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      const device = devicesRes.data.find(d => d.name === 'Sched-Probe')
      assert.ok(device)

      // Seed source & Auto-AI group bound to Sched-Probe
      const stateRes = await harness.apiGet<{ revision: number }>('/api/state')
      const source = buildSource({ id: uniqueId('src_'), name: 'Sched-Sub', url: subServer.urlFor('sched') })
      const group = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'Auto-AI',
        qualityDeviceId: device.id,
        members: [
          buildPoolMember({
            sourceIds: [source.id],
            quality: buildQualityCondition({ aiAll: true, minAvailability: 0.8 }),
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
        .toBe(2)

      // Initial basic+ai run: US-Alpha unlocked, DE-Beta restricted
      expect(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: device.id,
          keys: nodeKeys,
          config: basicAndAiConfig(),
        })).status,
      ).toBe(200)

      const initialRun = await probe.pollAndComplete(node => {
        if (node.name.includes('US-Alpha')) {
          return { latencyMs: 45, lossRate: 0, exit: { ip: '198.51.100.1', region: 'US' }, ai: aiPresets.allGreen('US') }
        }
        return { latencyMs: 65, lossRate: 0, exit: { ip: '198.51.100.2', region: 'DE' }, ai: aiPresets.allRestricted('HK') }
      })
      expect(initialRun.completeResponse?.status).toBe(200)

      // 1. Publish v1 manually via UI & enable private subscription link
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openPublishPage(page, harness.baseUrl)
      await page.getByRole('button', { name: '运行检查' }).click()
      await expect(page.getByText('已完成 Mihomo 校验。')).toBeVisible()
      await page.getByRole('button', { name: '发布配置' }).click()
      await confirmAlertDialog(page, '确认发布')
      await expect(page.getByRole('heading', { name: '当前成品 v1' })).toBeVisible()

      const linkRes = await harness.apiPost<{ url: string }>('/api/link', { action: 'rotate' })
      expect(linkRes.status).toBe(200)
      const subUrl = linkRes.data.url

      const v1Sub = await harness.subGet(subUrl)
      expect(v1Sub.status).toBe(200)
      assertYamlGroupExactOrder(parseMihomoYaml(v1Sub.text), 'Auto-AI', ['🇺🇸 US-Alpha'])

      // 2. Configure daily basic schedule (1440m) + 3-day ai schedule (4320m) on #/quality schedules tab
      await openQualityPage(page, harness.baseUrl, 'schedules')
      await configureQualitySchedule(page, {
        probeName: /Sched-Probe/,
        scope: 'kept',
        autoRefreshGroups: true,
        basic: { enabled: true, intervalMinutes: 1440, bandwidth: false },
        ai: { enabled: false, intervalMinutes: 4320 },
      })

      // First-run basic schedule has lastRunAt === null, so triggerTick() dispatches it immediately
      await harness.triggerTick()
      const basicSchedRun = await probe.pollAndComplete(node => {
        if (node.name.includes('US-Alpha')) {
          return { latencyMs: 46, lossRate: 0, exit: { ip: '198.51.100.1', region: 'US' } }
        }
        return { latencyMs: 64, lossRate: 0, exit: { ip: '198.51.100.2', region: 'DE' } }
      })
      expect(basicSchedRun.assignment?.config.basic).toBe(true)
      expect(basicSchedRun.assignment?.config.ai).toBe(false)
      expect(basicSchedRun.completeResponse?.status).toBe(200)

      // Enable 3-day AI schedule and verify persistence across reload
      await configureQualitySchedule(page, {
        probeName: /Sched-Probe/,
        scope: 'kept',
        autoRefreshGroups: true,
        basic: { enabled: true, intervalMinutes: 1440, bandwidth: false },
        ai: { enabled: true, intervalMinutes: 4320 },
      })

      await page.reload()
      await openQualityPage(page, harness.baseUrl, 'schedules')
      const persistedSchedule = await harness.apiGet<{
        autoRefreshGroups: boolean
        basic: { enabled: boolean; intervalMinutes: number; lastRunAt: string | null }
        ai: { enabled: boolean; intervalMinutes: number }
      }>('/api/quality/schedule')
      expect(persistedSchedule.status).toBe(200)
      expect(persistedSchedule.data.autoRefreshGroups).toBe(true)
      expect(persistedSchedule.data.basic.enabled).toBe(true)
      expect(persistedSchedule.data.basic.intervalMinutes).toBe(1440)
      expect(persistedSchedule.data.basic.lastRunAt).not.toBeNull()
      expect(persistedSchedule.data.ai.enabled).toBe(true)
      expect(persistedSchedule.data.ai.intervalMinutes).toBe(4320)

      // 3. Trigger scheduled AI run via UI button and flip unlock status (US-Alpha -> restricted, DE-Beta -> allGreen)
      await triggerScheduleRunButton(page, 'ai')
      const aiSchedRun = await probe.pollAndComplete(node => {
        if (node.name.includes('US-Alpha')) {
          return { exit: { ip: '198.51.100.1', region: 'US' }, ai: aiPresets.allRestricted('HK') }
        }
        return { exit: { ip: '198.51.100.2', region: 'DE' }, ai: aiPresets.allGreen('DE') }
      })
      expect(aiSchedRun.assignment?.config.basic).toBe(false)
      expect(aiSchedRun.assignment?.config.ai).toBe(true)
      expect(aiSchedRun.completeResponse?.status).toBe(200)

      // 4. Verify automatic 'auto' v2 publish and updated /sub/<token> YAML
      await expect
        .poll(async () => {
          const hist = await harness!.apiGet<Array<{ seq: number; kind: string }>>('/api/history')
          return hist.data[0] ?? null
        })
        .toMatchObject({ seq: 2, kind: 'auto' })

      await openPublishPage(page, harness.baseUrl)
      await expect(page.getByRole('heading', { name: '当前成品 v2' })).toBeVisible()
      await expect(page.getByText(/自动更新/).first()).toBeVisible()

      const v2Sub = await harness.subGet(subUrl)
      expect(v2Sub.status).toBe(200)
      assertYamlGroupExactOrder(parseMihomoYaml(v2Sub.text), 'Auto-AI', ['🇩🇪 DE-Beta'])

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
