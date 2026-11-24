import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertAvailabilityStats,
  assertYamlGroupContains,
  assertYamlGroupExactOrder,
  basicOnlyConfig,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildSource,
  getYamlGroupProxies,
  parseMihomoYaml,
  unwrapLatestForDevice,
} from '../helpers/fixtures.ts'
import {
  createMockProbe,
  parseInviteLink,
  type AutoResponderHandle,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  closeModal,
  expectInheritedProbeInRule,
  expectNoReportBaselinePicker,
  expectQuickChipActive,
  getRuleFilterSection,
  openAdvancedQualityModal,
  openGroupsPage,
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
  token: string | null
  draft: {
    sources: Array<Record<string, unknown>>
    groups: Array<Record<string, unknown>>
    services: unknown[]
    rules: unknown[]
    base: Record<string, unknown>
  }
}

test.describe('T3-P12 Multi-Check Availability x Single-Probe Group Eval x Inline Filter & Inheritance (F5, F6, F9)', () => {
  test('T3-P12-01 (F5,F9) (F6,F9): rolling availability chip & advanced modal evaluate single-probe history with rule inheritance and live probe switching', async ({ page }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        feed: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
            buildProxyNode('🇸🇬 SG-SIN-01', { server: 'sg-sin-01.example.net', port: 10003 }),
          ],
        },
      })
      harness = await startAppHarness()

      const initState = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const profileId = initState.data.id
      const source = buildSource({ name: 'Avail Eval Feed', url: subServer.urlFor('feed') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })).status, 200)

      // Pair Probe-1 and Probe-2
      const invite1 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const probe1 = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Probe-1' })
      assert.equal((await probe1.enroll(parseInviteLink(invite1.data.pairing).ticket)).status, 200)

      const invite2 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const probe2 = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Probe-2' })
      assert.equal((await probe2.enroll(parseInviteLink(invite2.data.pairing).ticket)).status, 200)

      const devices = (await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')).data
      const probe1Id = devices.find(d => d.name === 'Probe-1')!.id
      const probe2Id = devices.find(d => d.name === 'Probe-2')!.id

      const group = buildProxyGroup({
        name: 'Avail-Eval-Group',
        qualityDeviceId: probe1Id,
        members: [buildPoolMember({ sourceIds: [source.id] })],
      })
      const saveDraftRes = await harness.apiPost<WorkspaceStatePayload>('/api/draft', {
        revision: initState.data.revision,
        draft: { ...initState.data.draft, sources: [source], groups: [group] },
      })
      assert.equal(saveDraftRes.status, 200)

      const nodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
      const nodes = nodesRes.data.good?.nodes ?? []
      const usKey = `${source.id}/${nodes.find(n => n.name.includes('US-LAX-01'))!.id}`
      const jpKey = `${source.id}/${nodes.find(n => n.name.includes('JP-TYO-01'))!.id}`
      const sgKey = `${source.id}/${nodes.find(n => n.name.includes('SG-SIN-01'))!.id}`
      const allKeys = [usKey, jpKey, sgKey]

      // Probe-1 5 basic checks:
      // US = pass 1..4, FAIL 5 -> 4/5 = 80% (latest basic failed!)
      // JP = fail 1..2, PASS 3..5 -> 3/5 = 60% (latest basic passed!)
      // SG = pass 1..5 -> 5/5 = 100%
      for (let i = 1; i <= 5; i++) {
        assert.equal(
          (await harness.apiPost('/api/quality/queue', {
            targetDeviceId: probe1Id,
            keys: allKeys,
            config: basicOnlyConfig(),
          })).status,
          200,
        )
        const res = await probe1.pollAndComplete(node => {
          if (node.key === usKey) {
            return i === 5
              ? { available: false, error: 'no_response' }
              : { latencyMs: 65, exit: { ip: '198.51.100.1', region: 'US' } }
          }
          if (node.key === jpKey) {
            return i <= 2
              ? { available: false, error: 'no_response' }
              : { latencyMs: 55, exit: { ip: '198.51.100.2', region: 'JP' } }
          }
          return { latencyMs: 45, exit: { ip: '198.51.100.3', region: 'SG' } }
        })
        assert.equal(res.completeResponse?.status, 200)
      }

      const p1Latest = unwrapLatestForDevice(
        (await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(probe1Id)}`)).data,
        probe1Id,
      )
      assertAvailabilityStats(p1Latest[usKey].availability, 4, 5)
      assert.equal(p1Latest[usKey].basic?.available, false)
      assertAvailabilityStats(p1Latest[jpKey].availability, 3, 5)
      assert.equal(p1Latest[jpKey].basic?.available, true)
      assertAvailabilityStats(p1Latest[sgKey].availability, 5, 5)

      // Probe-2 5 basic checks: JP = 5/5 (100%), US = 1/5 (20%), SG = 0/5 (0%)
      for (let i = 1; i <= 5; i++) {
        assert.equal(
          (await harness.apiPost('/api/quality/queue', {
            targetDeviceId: probe2Id,
            keys: allKeys,
            config: basicOnlyConfig(),
          })).status,
          200,
        )
        const res = await probe2.pollAndComplete(node => {
          if (node.key === jpKey) return { latencyMs: 40, exit: { ip: '198.51.100.12', region: 'JP' } }
          if (node.key === usKey) {
            return i === 5
              ? { latencyMs: 90, exit: { ip: '198.51.100.11', region: 'US' } }
              : { available: false, error: 'no_response' }
          }
          return { available: false, error: 'no_response' }
        })
        assert.equal(res.completeResponse?.status, 200)
      }

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      // (F6) No QualityBaselinePicker
      await expectNoReportBaselinePicker(page)

      // (F5, F9) Toggle inline quick chip "高可用率" on Rule 1: keeps US (80% despite last fail) & SG (100%), drops JP (60% despite last pass)
      const rule = getRuleFilterSection(page)
      await toggleQuickQualityChip(rule, /高可用率/)
      await expectQuickChipActive(rule, /高可用率/, true)
      await expect(rule.getByRole('status')).toContainText('匹配 2 个保留节点')
      await expect(rule.locator('.pool-sample')).toContainText('US-LAX-01')
      await expect(rule.locator('.pool-sample')).toContainText('SG-SIN-01')
      await expect(rule.locator('.pool-sample')).not.toContainText('JP-TYO-01')

      // (F6, F9) Add 2nd pool rule -> automatically inherits Probe-1
      await rule.getByRole('button', { name: '另加一条筛选' }).click()
      await expectInheritedProbeInRule(rule, 'Probe-1')

      const modal = await openAdvancedQualityModal(page, rule)
      const sortSelect = modal.getByLabel(/组内排序/).first()
      await expect(sortSelect).toBeVisible()
      await sortSelect.selectOption('availability')
      await modal.getByLabel(/最多保留节点数/).first().fill('1')
      const minAvailInput = modal.getByLabel(/最低可用率/).first()
      if ((await minAvailInput.count()) > 0 && (await minAvailInput.isVisible())) {
        await minAvailInput.fill('80')
      }
      const applyBtn = modal.getByRole('button', { name: /^(?:应用|确定|保存)$/ }).first()
      if ((await applyBtn.count()) > 0 && (await applyBtn.isVisible())) {
        await applyBtn.click()
        await expect(modal).toBeHidden()
      } else {
        await closeModal(modal)
      }

      // Rule 2 preview selects top-1 by availability: SG-SIN-01 (100%)
      await expect(rule.getByRole('status')).toContainText('匹配 1 个保留节点')
      await expect(rule.locator('.pool-sample')).toContainText('SG-SIN-01')

      // Add Rule 2 to group and save
      const addRuleBtn = rule.getByRole('button', { name: '加入全部保留节点' })
      if ((await addRuleBtn.count()) > 0 && (await addRuleBtn.isVisible())) {
        await addRuleBtn.click()
      }
      await page.getByRole('button', { name: '保存代理组' }).click()

      await expect.poll(async () => {
        const st = await harness!.apiGet<WorkspaceStatePayload>('/api/state')
        const grp = st.data.draft.groups.find(g => g.id === group.id) as { members?: unknown[] } | undefined
        return (grp?.members?.length ?? 0) >= 2
      }).toBe(true)

      // Publish & verify YAML reflects Probe-1 rolling availability evaluation (F5, F6, F9)
      let latestState = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      let pubRes = await harness.apiPost<WorkspaceStatePayload>('/api/publish', { revision: latestState.data.revision })
      assert.equal(pubRes.status, 200)
      let linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.equal(linkRes.status, 200)
      assert.ok(linkRes.data.url)
      const yamlProbe1 = parseMihomoYaml((await harness.subGet(linkRes.data.url)).text)
      assertYamlGroupContains(yamlProbe1, 'Avail-Eval-Group', ['🇺🇸 US-LAX-01', '🇸🇬 SG-SIN-01'])
      assert.equal(getYamlGroupProxies(yamlProbe1, 'Avail-Eval-Group').includes('🇯🇵 JP-TYO-01'), false)

      // (F6, F9) Switch group single probe to Probe-2 in UI -> all rules re-evaluate against Probe-2 (JP 100%, US 20%, SG 0%)
      await openGroupsPage(page, harness.baseUrl, group.id)
      const probeCombobox = getRuleFilterSection(page).getByRole('combobox', { name: /探针/ }).first()
      await expect(probeCombobox).toBeVisible()
      const probe2Label = await probeCombobox.locator('option').evaluateAll(options =>
        options.find(o => (o.textContent ?? '').includes('Probe-2'))?.textContent?.trim() ?? '',
      )
      if (probe2Label) {
        await probeCombobox.selectOption({ label: probe2Label })
      } else {
        await probeCombobox.selectOption(probe2Id)
      }
      await expect(getRuleFilterSection(page).getByRole('status')).toContainText('匹配 1 个保留节点')
      await expect(getRuleFilterSection(page).locator('.pool-sample')).toContainText('JP-TYO-01')
      await page.getByRole('button', { name: '保存代理组' }).click()

      await expect.poll(async () => {
        const st = await harness!.apiGet<WorkspaceStatePayload>('/api/state')
        const grp = st.data.draft.groups.find(g => g.id === group.id) as { qualityDeviceId?: string | null } | undefined
        return grp?.qualityDeviceId
      }).toBe(probe2Id)

      latestState = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const updatedGroup = latestState.data.draft.groups.find(g => g.id === group.id) as { qualityDeviceId?: string | null; members: Array<Record<string, unknown>> }
      assert.equal(updatedGroup.qualityDeviceId, probe2Id)
      assert.ok(updatedGroup.members.length >= 2)

      // Ensure Probe-2 rule evaluation yields only JP-TYO-01 (100%)
      pubRes = await harness.apiPost<WorkspaceStatePayload>('/api/publish', { revision: latestState.data.revision })
      assert.equal(pubRes.status, 200)
      linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.equal(linkRes.status, 200)
      assert.ok(linkRes.data.url)
      const yamlProbe2 = parseMihomoYaml((await harness.subGet(linkRes.data.url)).text)
      assertYamlGroupExactOrder(yamlProbe2, 'Avail-Eval-Group', ['🇯🇵 JP-TYO-01'])

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
