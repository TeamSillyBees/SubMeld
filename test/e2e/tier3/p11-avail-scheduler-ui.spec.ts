import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertAvailabilityStats,
  assertThreeSurfaceAi,
  buildProxyNode,
  buildSource,
  unwrapLatestForDevice,
  type QualityScheduleConfig,
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
  configureQualitySchedule,
  expectAiUnlockCell,
  expectAvailabilityBadgeOrText,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  findNodeRow,
  openNodesPage,
  openQualityPage,
  triggerScheduleRunButton,
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

test.describe('T3-P11 Multi-Check Availability x Quality Scheduler x Unified AI UI (F5, F7, F8)', () => {
  test('T3-P11-01 (F5,F7) (F5,F8): repeated scheduled basic runs build rolling availability, scheduled ai preserves rates, and #/nodes displays & sorts by availability alongside 3-surface AI column', async ({ page }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      // Order HK -> JP -> US in subscription so descending availability sort actively reorders rows
      subServer = await startMockSubServer({
        feed: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇭🇰 HK-HKG-01', { server: 'hk-hkg-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10003 }),
          ],
        },
      })
      harness = await startAppHarness()

      const stateRes = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const profileId = stateRes.data.id
      const source = buildSource({ name: 'Avail Sched Feed', url: subServer.urlFor('feed') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })).status, 200)
      assert.equal(
        (await harness.apiPost('/api/draft', {
          revision: stateRes.data.revision,
          draft: { ...stateRes.data.draft, sources: [source] },
        })).status,
        200,
      )

      const nodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
      const nodes = nodesRes.data.good?.nodes ?? []
      const hkKey = `${source.id}/${nodes.find(n => n.name.includes('HK-HKG-01'))!.id}`
      const jpKey = `${source.id}/${nodes.find(n => n.name.includes('JP-TYO-01'))!.id}`
      const usKey = `${source.id}/${nodes.find(n => n.name.includes('US-LAX-01'))!.id}`

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Sched-Avail-Probe' })
      assert.equal((await probe.enroll(parseInviteLink(inviteRes.data.pairing).ticket)).status, 200)
      const deviceId = (await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')).data[0].id

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openQualityPage(page, harness.baseUrl, 'schedules')
      await configureQualitySchedule(page, {
        probeName: /Sched-Avail-Probe/,
        scope: 'kept',
        autoRefreshGroups: true,
        basic: { enabled: true, intervalMinutes: 60, bandwidth: false },
        ai: { enabled: true, intervalMinutes: 4320 },
      })

      // Execute 4 scheduled basic runs: US = 4/4 (100%), JP = 3/4 (75%), HK = 2/4 (50%)
      for (let round = 1; round <= 4; round++) {
        await triggerScheduleRunButton(page, 'basic')
        const run = await probe.pollAndComplete(node => {
          if (node.key === usKey) return { latencyMs: 60, exit: { ip: '198.51.100.1', region: 'US' } }
          if (node.key === jpKey) {
            return round === 4
              ? { available: false, error: 'no_response' }
              : { latencyMs: 70, exit: { ip: '198.51.100.2', region: 'JP' } }
          }
          assert.equal(node.key, hkKey)
          return round >= 3
            ? { available: false, error: 'no_response' }
            : { latencyMs: 45, exit: { ip: '198.51.100.3', region: 'HK' } }
        })
        assert.equal(run.assignment?.config.basic, true)
        assert.equal(run.assignment?.config.ai, false)
        assert.equal(run.completeResponse?.status, 200)
      }

      // Execute 1 scheduled AI-only run; must preserve availability rates (F5, F7)
      await triggerScheduleRunButton(page, 'ai')
      const aiRun = await probe.pollAndComplete(node => {
        if (node.key === usKey) return { exit: { ip: '198.51.100.1', region: 'US' }, ai: aiPresets.allGreen('US') }
        if (node.key === jpKey) {
          return {
            exit: { ip: '198.51.100.2', region: 'JP' },
            ai: {
              chatgptWeb: aiReading.green('JP', 'chatgptWeb'),
              chatgptApp: aiReading.restricted('region_restricted', 'HK'),
              gemini: aiReading.uncertain('challenge'),
            },
          }
        }
        return { exit: null, ai: aiPresets.allRestricted('HK') }
      })
      assert.equal(aiRun.assignment?.config.basic, false)
      assert.equal(aiRun.assignment?.config.ai, true)
      assert.equal(aiRun.completeResponse?.status, 200)

      const sched = (await harness.apiGet<QualityScheduleConfig>('/api/quality/schedule')).data
      assert.ok(sched.basic.lastRunAt)
      assert.ok(sched.basic.lastJobId)
      assert.ok(sched.ai.lastRunAt)
      assert.ok(sched.ai.lastJobId)

      const latest = unwrapLatestForDevice(
        (await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)).data,
        deviceId,
      )
      assertAvailabilityStats(latest[usKey].availability, 4, 4)
      assertAvailabilityStats(latest[jpKey].availability, 3, 4)
      assertAvailabilityStats(latest[hkKey].availability, 2, 4)
      assertThreeSurfaceAi(latest[jpKey].ai?.results)

      // (F5, F8) Verify #/nodes displays rolling availability percentages + 3-surface AI column & sorts by 可用率
      await openNodesPage(page, harness.baseUrl)
      await expectNoAiPlatformFilterDropdown(page)
      await expectNoLegacyAiPlatforms(page)

      const usRow = findNodeRow(page, '🇺🇸 US-LAX-01')
      const jpRow = findNodeRow(page, '🇯🇵 JP-TYO-01')
      const hkRow = findNodeRow(page, '🇭🇰 HK-HKG-01')

      await expectAvailabilityBadgeOrText(usRow, '100%')
      await expectAvailabilityBadgeOrText(jpRow, '75%')
      await expectAvailabilityBadgeOrText(hkRow, '50%')

      await expectAiUnlockCell(usRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
        { surface: 'ChatGPT APP', tone: 'success', label: 'US' },
        { surface: 'Gemini Web', tone: 'success', label: 'US' },
      ])
      await expectAiUnlockCell(jpRow, [
        { surface: 'ChatGPT Web', tone: 'success', label: 'JP' },
        { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
        { surface: 'Gemini Web', tone: 'warning', label: '未知' },
      ])

      const availSortBtn = page.getByRole('button', { name: /^可用率/ }).first()
      await expect(availSortBtn).toBeVisible()
      await availSortBtn.click()
      await expect(page.getByRole('button', { name: /可用率，当前降序/ })).toHaveAttribute('aria-pressed', 'true')

      const orderedNames = await page.locator('.nodes-table tbody tr').evaluateAll(rows =>
        rows.map(r => r.textContent ?? ''),
      )
      const usIdx = orderedNames.findIndex(t => t.includes('US-LAX-01'))
      const jpIdx = orderedNames.findIndex(t => t.includes('JP-TYO-01'))
      const hkIdx = orderedNames.findIndex(t => t.includes('HK-HKG-01'))
      assert.ok(usIdx >= 0 && jpIdx > usIdx && hkIdx > jpIdx, `Expected US -> JP -> HK order, got ${JSON.stringify(orderedNames)}`)

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
