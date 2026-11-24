import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  aiPresets,
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'
import {
  aiOnlyConfig,
  assertYamlGroupExactOrder,
  basicAndAiConfig,
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
  expectNoReportBaselinePicker,
  getRuleFilterSection,
  openGroupsPage,
  openNodesPage,
  openPublishPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface DraftStateResponse {
  id: string
  revision: number
  current: Record<string, unknown> | null
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
  draft: { groups: Array<{ id: string; qualityDeviceId?: string | null }> }
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

async function setupNodesAndHarness(nodeNames = ['Node-1', 'Node-2']) {
  const nodes = nodeNames.map((name, idx) =>
    buildProxyNode(name, { server: `n-${idx}.example.net`, port: 10500 + idx }),
  )
  const subServer = await startMockSubServer({ feed1: { format: 'yaml', nodes } })
  const harness = await startAppHarness({ useRealCore: false })

  const state0 = await harness.apiGet<DraftStateResponse>('/api/state')
  assert.equal(state0.status, 200)

  const source = buildSource({ id: uniqueId('src_'), name: '单探针订阅源', url: subServer.urlFor('feed1') })
  const probeSrc = await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })
  assert.equal(probeSrc.status, 200)

  const draftRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
    revision: state0.data.revision,
    draft: buildDraft({ sources: [source] }),
  })
  assert.equal(draftRes.status, 200)

  const keys = (draftRes.data.sources[source.id]?.good?.nodes ?? []).map(n => ({
    key: `${source.id}/${n.id}`,
    name: n.name,
  }))

  return {
    subServer,
    harness,
    profileId: draftRes.data.id,
    revision: draftRes.data.revision,
    source,
    keys,
  }
}

test.describe('Tier 1 — F6: Remove Report Pinning & Per-Group Single-Probe Evaluation', () => {
  test('T1-F6-01 QualityBaselinePicker is absent across #/nodes, #/groups, and #/publish', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndHarness()
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe, deviceId } = await enrollProbe(harness, 'Probe-NoPin')
      const q = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: ctx.keys.map(k => k.key),
        config: basicAndAiConfig(),
      })
      assert.equal(q.status, 200)
      await probe.pollAndComplete()

      const group = buildProxyGroup({
        name: '无锁定测试组',
        qualityDeviceId: deviceId,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition({ alive: true }) })],
      })
      const saveRes = await harness.apiPost('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

      await openNodesPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)

      await openGroupsPage(page, harness.baseUrl, group.id)
      await expectNoReportBaselinePicker(page)

      await openPublishPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F6-02 Group.qualityDeviceId evaluates pools from quality-latest without cross-probe bleed', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndHarness(['Node-1', 'Node-2'])
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe: probeA, deviceId: deviceA } = await enrollProbe(harness, 'Probe-A')
      const { probe: probeB, deviceId: deviceB } = await enrollProbe(harness, 'Probe-B')

      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceA,
        keys: ctx.keys.map(k => k.key),
        config: basicOnlyConfig(),
      })
      await probeA.pollAndComplete((node) =>
        node.name === 'Node-1' ? { latencyMs: 60 } : { available: false, error: 'no_response' },
      )

      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceB,
        keys: ctx.keys.map(k => k.key),
        config: basicOnlyConfig(),
      })
      await probeB.pollAndComplete((node) =>
        node.name === 'Node-2' ? { latencyMs: 60 } : { available: false, error: 'no_response' },
      )

      const groupA = buildProxyGroup({
        name: 'Group-A',
        qualityDeviceId: deviceA,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition({ alive: true, maxLatencyMs: 200 }) })],
      })
      const groupB = buildProxyGroup({
        name: 'Group-B',
        qualityDeviceId: deviceB,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition({ alive: true, maxLatencyMs: 200 }) })],
      })

      const saveRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [groupA, groupB] }),
      })
      assert.equal(saveRes.status, 200)

      const checkRes = await harness.apiPost<{ groups: Array<{ name: string; members: Array<{ name: string }> }> }>('/api/check', {})
      assert.equal(checkRes.status, 200)
      const checkedA = checkRes.data.groups.find(g => g.name === 'Group-A')
      const checkedB = checkRes.data.groups.find(g => g.name === 'Group-B')
      assert.deepEqual(checkedA?.members.map(m => m.name), ['Node-1'])
      assert.deepEqual(checkedB?.members.map(m => m.name), ['Node-2'])

      const pubRes = await harness.apiPost('/api/publish', { revision: saveRes.data.revision })
      assert.equal(pubRes.status, 200)
      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      const subRes = await harness.subGet(linkRes.data.url!)
      const yamlObj = parseMihomoYaml(subRes.text)
      assertYamlGroupExactOrder(yamlObj, 'Group-A', ['Node-1'])
      assertYamlGroupExactOrder(yamlObj, 'Group-B', ['Node-2'])
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F6-03 Switching group probe on #/groups updates live member preview and persists qualityDeviceId', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndHarness(['Node-1', 'Node-2'])
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe: probeA, deviceId: deviceA } = await enrollProbe(harness, 'Probe-Switch-A')
      const { probe: probeB, deviceId: deviceB } = await enrollProbe(harness, 'Probe-Switch-B')

      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceA,
        keys: ctx.keys.map(k => k.key),
        config: basicOnlyConfig(),
      })
      await probeA.pollAndComplete((node) =>
        node.name === 'Node-1' ? { latencyMs: 50 } : { available: false, error: 'no_response' },
      )

      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceB,
        keys: ctx.keys.map(k => k.key),
        config: basicOnlyConfig(),
      })
      await probeB.pollAndComplete((node) =>
        node.name === 'Node-2' ? { latencyMs: 50 } : { available: false, error: 'no_response' },
      )

      const group = buildProxyGroup({
        name: 'Switch-Probe-Group',
        qualityDeviceId: deviceA,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition({ alive: true, maxLatencyMs: 200 }) })],
      })
      const saveRes = await harness.apiPost('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      const previewToggle = page.getByRole('button', { name: /预览代理列表/ }).first()
      await expect(previewToggle).toBeVisible()
      if ((await previewToggle.getAttribute('aria-expanded')) === 'false') {
        await previewToggle.click()
      }
      const previewList = page.locator('.preview-members')
      await expect(previewList).toContainText('Node-1')
      await expect(previewList).not.toContainText('Node-2')

      const probeSelect = getRuleFilterSection(page).getByRole('combobox', { name: /探针/ }).first()
      await expect(probeSelect).toBeVisible()
      await probeSelect.selectOption({ value: deviceB })

      await expect(previewList).toContainText('Node-2')
      await expect(previewList).not.toContainText('Node-1')

      await Promise.all([
        page.waitForResponse(
          res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/draft') && res.ok(),
        ),
        page.getByRole('button', { name: /保存代理组/ }).click(),
      ])
      const stateAfter = await harness.apiGet<DraftStateResponse>('/api/state')
      assert.equal(stateAfter.data.draft.groups[0]?.qualityDeviceId, deviceB)

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F6-04 Publish compiles Mihomo YAML without pinned qualityReportId or qualitySnapshot', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndHarness(['Node-1'])
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe, deviceId } = await enrollProbe(harness, 'Probe-Publish')
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: ctx.keys.map(k => k.key),
        config: basicAndAiConfig(),
      })
      await probe.pollAndComplete(() => ({ latencyMs: 50, ai: aiPresets.allGreen('US') }))

      const group = buildProxyGroup({
        name: 'Clean-Publish-Group',
        qualityDeviceId: deviceId,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition({ alive: true, aiAll: true }) })],
      })
      const saveRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const publishRes = await harness.apiPost<DraftStateResponse>('/api/publish', { revision: saveRes.data.revision })
      assert.equal(publishRes.status, 200)
      assert.equal((publishRes.data.current as { seq?: number } | null)?.seq, 1)

      const historyRes = await harness.apiGet<Array<Record<string, unknown>>>('/api/history')
      assert.equal(historyRes.status, 200)
      assert.equal(Object.hasOwn(historyRes.data[0], 'qualityReportId'), false)
      assert.equal(Object.hasOwn(historyRes.data[0], 'qualitySnapshot'), false)

      const versionDoc = harness.readDbDoc<Record<string, unknown>>(`versions/${ctx.profileId}`, '000000000001')
      assert.ok(versionDoc)
      assert.equal(Object.hasOwn(versionDoc, 'qualityReportId'), false)
      assert.equal(Object.hasOwn(versionDoc, 'qualitySnapshot'), false)

      const profileDoc = harness.readDbDoc<Record<string, unknown>>('profiles', ctx.profileId)
      assert.ok(profileDoc)
      assert.equal(Object.hasOwn(profileDoc, 'fixedQualitySnapshot'), false)

      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      const subRes = await harness.subGet(linkRes.data.url!)
      const yamlObj = parseMihomoYaml(subRes.text)
      assertYamlGroupExactOrder(yamlObj, group.name, ['Node-1'])
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F6-05 New probe run updates live group evaluation and /sub YAML via quality-latest', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupNodesAndHarness(['Node-1', 'Node-2'])
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe, deviceId } = await enrollProbe(harness, 'Probe-Live')
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: ctx.keys.map(k => k.key),
        config: basicAndAiConfig(),
      })
      await probe.pollAndComplete((node) =>
        node.name === 'Node-1'
          ? { latencyMs: 50, ai: aiPresets.allGreen('US') }
          : { latencyMs: 50, ai: aiPresets.allRestricted('HK') },
      )

      const group = buildProxyGroup({
        name: 'Live-Eval-Group',
        qualityDeviceId: deviceId,
        members: [buildPoolMember({ sourceIds: [ctx.source.id], quality: buildQualityCondition({ alive: true, aiAll: true }) })],
      })
      const saveRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const pubRes = await harness.apiPost('/api/publish', { revision: saveRes.data.revision })
      assert.equal(pubRes.status, 200)
      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.ok(linkRes.data.url)

      const sub1 = await harness.subGet(linkRes.data.url)
      assertYamlGroupExactOrder(parseMihomoYaml(sub1.text), group.name, ['Node-1'])

      // Run a new AI-only check swapping which node unlocks all 3 AI surfaces
      await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: ctx.keys.map(k => k.key),
        config: aiOnlyConfig(),
      })
      await probe.pollAndComplete((node) =>
        node.name === 'Node-1'
          ? { exit: null, ai: aiPresets.allRestricted('HK') }
          : { exit: null, ai: aiPresets.allGreen('US') },
      )

      const checkRes = await harness.apiPost<{ groups: Array<{ members: Array<{ name: string }> }> }>('/api/check', {})
      assert.equal(checkRes.status, 200)
      assert.deepEqual(checkRes.data.groups[0]?.members.map(m => m.name), ['Node-2'])

      const sub2 = await harness.subGet(linkRes.data.url)
      assertYamlGroupExactOrder(parseMihomoYaml(sub2.text), group.name, ['Node-2'])
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
