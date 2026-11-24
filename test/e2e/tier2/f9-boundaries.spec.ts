import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertYamlGroupExactOrder,
  basicAndAiConfig,
  basicOnlyConfig,
  buildDraft,
  buildFilter,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildSource,
  parseMihomoYaml,
  uniqueId,
  type DraftConfig,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  aiReading,
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  closeModal,
  expectInheritedProbeInRule,
  expectNoReportBaselinePicker,
  getRuleFilterSection,
  openAdvancedQualityModal,
  openGroupsPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface WorkspaceStateResponse {
  id: string
  revision: number
  draft: DraftConfig
  sources: Record<
    string,
    {
      good: {
        nodes: Array<{ id: string; name: string; region: string }>
      } | null
    }
  >
}

interface CheckViewResponse {
  revision: number
  groups: Array<{
    id: string
    name: string
    members: Array<{ key: string; name: string; kind: string }>
  }>
  issues: Array<{ code: string; severity: string; message: string }>
}

interface ProbeDeviceItem {
  id: string
  name: string
}

async function pairMockProbe(
  harness: AppHarness,
  name: string,
): Promise<{ probe: MockProbeAgent; deviceId: string }> {
  const invite = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  expect(invite.status).toBe(200)
  const parsed = parseInviteLink(invite.data.pairing)
  const probe = createMockProbe({
    origin: harness.baseUrl,
    profileId: parsed.profileId,
    name,
  })
  const enrollRes = await probe.enroll(parsed.ticket)
  expect(enrollRes.status).toBe(200)
  const devicesRes = await harness.apiGet<ProbeDeviceItem[]>('/api/quality/devices')
  expect(devicesRes.status).toBe(200)
  const device = devicesRes.data.find(d => d.name === name)
  expect(device).toBeDefined()
  return { probe, deviceId: device!.id }
}

async function seedSourceAndGroups(
  harness: AppHarness,
  subServer: MockSubServer,
  feedId: string,
  nodes: ReturnType<typeof buildProxyNode>[],
  options: {
    unknownFilter?: 'auto' | 'keep' | 'exclude'
    buildGroups: (srcId: string, storedNodes: Array<{ id: string; key: string; name: string; region: string }>) => DraftConfig['groups']
  },
): Promise<{
  state: WorkspaceStateResponse
  sourceId: string
  storedNodes: Array<{ id: string; key: string; name: string; region: string }>
}> {
  subServer.setFeed(feedId, { format: 'yaml', nodes })
  const initial = await harness.apiGet<WorkspaceStateResponse>('/api/state')
  expect(initial.status).toBe(200)
  const sourceId = uniqueId('src_')
  const srcUrl = subServer.urlFor(feedId)
  const probeRes = await harness.apiPost('/api/probe', { kind: 'source', id: sourceId, url: srcUrl })
  expect(probeRes.status).toBe(200)

  const src = buildSource({
    id: sourceId,
    name: `F9源-${feedId}`,
    url: srcUrl,
    filter: buildFilter({ unknown: options.unknownFilter ?? 'auto' }),
  })
  const draft1 = buildDraft({
    ...initial.data.draft,
    sources: [src],
  })
  const saved1 = await harness.apiPost<WorkspaceStateResponse>('/api/draft', {
    revision: initial.data.revision,
    draft: draft1,
  })
  expect(saved1.status).toBe(200)
  const rawNodes = saved1.data.sources[sourceId]?.good?.nodes ?? []
  expect(rawNodes).toHaveLength(nodes.length)
  const storedNodes = rawNodes.map(n => ({
    ...n,
    key: `${sourceId}/${n.id}`,
  }))

  const draft2 = buildDraft({
    ...saved1.data.draft,
    groups: options.buildGroups(sourceId, storedNodes),
  })
  const saved2 = await harness.apiPost<WorkspaceStateResponse>('/api/draft', {
    revision: saved1.data.revision,
    draft: draft2,
  })
  expect(saved2.status).toBe(200)
  return {
    state: saved2.data,
    sourceId,
    storedNodes,
  }
}

test.describe('Tier 2 F9 — Inline Pool Quality Filters, Modal & Probe Inheritance Boundaries', () => {
  let harness: AppHarness | undefined
  let subServer: MockSubServer | undefined

  test.afterEach(async () => {
    await subServer?.close()
    subServer = undefined
    await harness?.close()
    harness = undefined
  })

  test('T2-F9-01 handles empty match with fallbackWhenEmpty: false vs true and zero-candidate corner case', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F9-Probe-01')

    const groupId = uniqueId('grp_')
    const { state, sourceId, storedNodes } = await seedSourceAndGroups(
      harness,
      subServer,
      'f9-01',
      [
        buildProxyNode('Alpha-01', { server: 'a1.example.net', port: 12001 }),
        buildProxyNode('Beta-02', { server: 'b2.example.net', port: 12002 }),
        buildProxyNode('Gamma-03', { server: 'g3.example.net', port: 12003 }),
      ],
      {
        unknownFilter: 'keep',
        buildGroups: srcId => [
          buildProxyGroup({
            id: groupId,
            name: 'FallbackGroup',
            type: 'select',
            qualityDeviceId: deviceId,
            members: [
              buildPoolMember({
                sourceIds: [srcId],
                quality: buildQualityCondition({ maxLatencyMs: 50, fallbackWhenEmpty: false }),
              }),
            ],
          }),
        ],
      },
    )

    const qRes = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: storedNodes.map(n => n.key),
      config: basicOnlyConfig({ rounds: 2 }),
    })
    expect(qRes.status).toBe(200)
    expect((await probe.pollAndComplete(() => ({ latencyMs: 120 }))).completeResponse?.status).toBe(200)

    const emptyCheck = await harness.apiPost<CheckViewResponse>('/api/check', {})
    expect(emptyCheck.status).toBe(200)
    expect(emptyCheck.data.groups.find(g => g.id === groupId)?.members).toEqual([])

    const emptyPublish = await harness.apiPost('/api/publish', { revision: state.revision })
    expect(emptyPublish.status).toBe(422)

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
    await openGroupsPage(page, harness.baseUrl, groupId)

    const filterSection = getRuleFilterSection(page)
    await expect(filterSection).toContainText(/匹配\s*0\s*个保留节点|当前没有匹配节点/)

    const modal = await openAdvancedQualityModal(page, filterSection)
    const fallbackToggle = modal.getByLabel(/筛空时恢复基础候选/)
    await expect(fallbackToggle).toBeVisible()
    await fallbackToggle.click()
    await closeModal(modal)

    await expect(filterSection).toContainText(/兜底恢复\s*3\s*个节点/)
    await expect(filterSection).toContainText(/匹配\s*3\s*个保留节点/)

    // Save group via UI and publish
    await page.getByRole('button', { name: /保存/ }).first().click()
    const currentHarness = harness
    await expect
      .poll(async () => {
        const st = await currentHarness.apiGet<WorkspaceStateResponse>('/api/state')
        return st.data.draft.groups.find(g => g.id === groupId)?.members[0]
      })
      .toMatchObject({ kind: 'pool', quality: { fallbackWhenEmpty: true } })

    const updatedState = await harness.apiGet<WorkspaceStateResponse>('/api/state')
    const okCheck = await harness.apiPost<CheckViewResponse>('/api/check', {})
    expect(okCheck.status).toBe(200)
    expect(okCheck.data.groups.find(g => g.id === groupId)?.members).toHaveLength(3)

    const okPublish = await harness.apiPost('/api/publish', { revision: updatedState.data.revision })
    expect(okPublish.status).toBe(200)
    const linkRes = await harness.apiGet<{ url: string }>('/api/link')
    const subRes = await harness.subGet(linkRes.data.url)
    expect(subRes.status).toBe(200)
    assertYamlGroupExactOrder(
      parseMihomoYaml(subRes.text),
      'FallbackGroup',
      storedNodes.map(n => n.name),
    )

    // Corner case: candidates.length === 0 (e.g. regions: ['DE'] with no DE nodes) -> fallbackWhenEmpty: true stays empty
    const zeroCandidateSave = await harness.apiPost<WorkspaceStateResponse>('/api/draft', {
      revision: updatedState.data.revision,
      draft: buildDraft({
        ...updatedState.data.draft,
        groups: [
          buildProxyGroup({
            id: groupId,
            name: 'FallbackGroup',
            type: 'select',
            qualityDeviceId: deviceId,
            members: [
              buildPoolMember({
                sourceIds: [sourceId],
                regions: ['DE'],
                quality: buildQualityCondition({ maxLatencyMs: 50, fallbackWhenEmpty: true }),
              }),
            ],
          }),
        ],
      }),
    })
    expect(zeroCandidateSave.status).toBe(200)
    const zeroCheck = await harness.apiPost<CheckViewResponse>('/api/check', {})
    expect(zeroCheck.data.groups.find(g => g.id === groupId)?.members).toEqual([])
    const zeroPublish = await harness.apiPost('/api/publish', { revision: zeroCandidateSave.data.revision })
    expect(zeroPublish.status).toBe(422)

    collector.assertNoErrors()
  })

  test('T2-F9-02 follows relaxWhenEmpty order: Phase A latency stops before challenge, Phase B challenge precedes fallback', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F9-Probe-02')

    const groupId = uniqueId('grp_')
    const { state, storedNodes } = await seedSourceAndGroups(
      harness,
      subServer,
      'f9-02',
      [
        buildProxyNode('Node-LatHigh', { server: 'lat.example.net', port: 12101 }),
        buildProxyNode('Node-Challenge', { server: 'chg.example.net', port: 12102 }),
      ],
      {
        unknownFilter: 'keep',
        buildGroups: srcId => [
          buildProxyGroup({
            id: groupId,
            name: 'RelaxOrderGroup',
            type: 'select',
            qualityDeviceId: deviceId,
            members: [
              buildPoolMember({
                sourceIds: [srcId],
                quality: buildQualityCondition({
                  maxLatencyMs: 100,
                  aiAll: true,
                  relaxWhenEmpty: true,
                  fallbackWhenEmpty: true,
                }),
              }),
            ],
          }),
        ],
      },
    )

    const [latHighNode, challengeNode] = storedNodes

    // Phase A: Node-LatHigh (400ms, allGreen) + Node-Challenge (400ms, degraded_challenge)
    const q1 = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [latHighNode.key, challengeNode.key],
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(q1.status).toBe(200)
    const done1 = await probe.pollAndComplete(node =>
      node.key === latHighNode.key
        ? { latencyMs: 400, ai: aiPresets.allGreen('US') }
        : {
            latencyMs: 400,
            ai: {
              chatgptWeb: aiReading.uncertain('degraded_challenge', 'US'),
              chatgptApp: aiReading.green('US', 'chatgptApp'),
              gemini: aiReading.green('US', 'gemini'),
            },
          },
    )
    expect(done1.completeResponse?.status).toBe(200)

    const checkA = await harness.apiPost<CheckViewResponse>('/api/check', {})
    expect(checkA.status).toBe(200)
    expect(checkA.data.groups.find(g => g.id === groupId)?.members.map(m => m.name)).toEqual([latHighNode.name])

    const pubA = await harness.apiPost('/api/publish', { revision: state.revision })
    expect(pubA.status).toBe(200)
    const linkRes = await harness.apiGet<{ url: string }>('/api/link')
    const subA = await harness.subGet(linkRes.data.url)
    assertYamlGroupExactOrder(parseMihomoYaml(subA.text), 'RelaxOrderGroup', [latHighNode.name])

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
    await openGroupsPage(page, harness.baseUrl, groupId)
    await expect(getRuleFilterSection(page)).toContainText(/取消延迟上限后保留\s*1\s*个节点/)

    // Phase B: Make Node-LatHigh strictly restricted so removing maxLatencyMs leaves 0 strict matches -> Step 2 challenge relaxation runs
    const q2 = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [latHighNode.key],
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(q2.status).toBe(200)
    const done2 = await probe.pollAndComplete(() => ({
      latencyMs: 400,
      ai: aiPresets.allRestricted('HK'),
    }))
    expect(done2.completeResponse?.status).toBe(200)

    const checkB = await harness.apiPost<CheckViewResponse>('/api/check', {})
    expect(checkB.status).toBe(200)
    expect(checkB.data.groups.find(g => g.id === groupId)?.members.map(m => m.name)).toEqual([challengeNode.name])

    const pubB = await harness.apiPost('/api/publish', { revision: state.revision })
    expect(pubB.status).toBe(200)
    const subB = await harness.subGet(linkRes.data.url)
    assertYamlGroupExactOrder(parseMihomoYaml(subB.text), 'RelaxOrderGroup', [challengeNode.name])

    await openGroupsPage(page, harness.baseUrl, groupId)
    await expect(getRuleFilterSection(page)).toContainText(/允许浏览器验证后保留\s*1\s*个节点/, { timeout: 15_000 })

    collector.assertNoErrors()
  })

  test('T2-F9-03 rejects invalid numeric bounds on POST /api/draft and clamps modal inputs cleanly', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F9-Probe-03')

    const groupId = uniqueId('grp_')
    const { state, sourceId, storedNodes } = await seedSourceAndGroups(
      harness,
      subServer,
      'f9-03',
      [buildProxyNode('Numeric-01', { server: 'num.example.net', port: 12201 })],
      {
        unknownFilter: 'keep',
        buildGroups: srcId => [
          buildProxyGroup({
            id: groupId,
            name: 'NumericBoundsGroup',
            type: 'select',
            qualityDeviceId: deviceId,
            members: [
              buildPoolMember({
                sourceIds: [srcId],
                quality: buildQualityCondition({ alive: true }),
              }),
            ],
          }),
        ],
      },
    )

    const qRes = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: storedNodes.map(n => n.key),
      config: basicOnlyConfig({ rounds: 2 }),
    })
    expect(qRes.status).toBe(200)
    expect((await probe.pollAndComplete()).completeResponse?.status).toBe(200)

    const invalidQualityCases: Array<{ label: string; quality: Record<string, unknown> }> = [
      { label: 'minAvailability > 1', quality: { minAvailability: 1.5 } },
      { label: 'minAvailability < 0', quality: { minAvailability: -0.1 } },
      { label: 'maxLatencyMs < 0', quality: { maxLatencyMs: -1 } },
      { label: 'maxLatencyMs > 600000', quality: { maxLatencyMs: 600001 } },
      { label: 'maxLossRate > 1', quality: { maxLossRate: 1.1 } },
      { label: 'maxLossRate < 0', quality: { maxLossRate: -0.05 } },
      { label: 'maxJitterMs < 0', quality: { maxJitterMs: -1 } },
      { label: 'minBandwidthMbps < 0', quality: { minBandwidthMbps: -1 } },
      { label: 'topN = 0', quality: { topN: 0 } },
      { label: 'topN = 1.5', quality: { topN: 1.5 } },
      { label: 'topN = 16001', quality: { topN: 16001 } },
      { label: 'unknown strict key', quality: { unexpectedField: 42 } },
    ]

    for (const item of invalidQualityCases) {
      const badRes = await harness.apiPost('/api/draft', {
        revision: state.revision,
        draft: buildDraft({
          ...state.draft,
          groups: [
            buildProxyGroup({
              id: groupId,
              name: 'NumericBoundsGroup',
              type: 'select',
              qualityDeviceId: deviceId,
              members: [
                {
                  kind: 'pool',
                  sourceIds: [sourceId],
                  regions: [],
                  quality: item.quality as never,
                },
              ],
            }),
          ],
        }),
      })
      expect(badRes.status, `Expected 400 for ${item.label}`).toBe(400)
    }

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
    await openGroupsPage(page, harness.baseUrl, groupId)

    const modal = await openAdvancedQualityModal(page, getRuleFilterSection(page))

    const latencyInput = modal.getByLabel(/最大 HTTPS 延迟/).first()
    await latencyInput.fill('9999999')
    const lossInput = modal.getByLabel(/最大丢包率/).first()
    await lossInput.fill('150')
    const topNInput = modal.getByLabel(/最多保留节点数/).first()
    await topNInput.fill('99999')

    await closeModal(modal)

    // Save group and confirm server accepts valid clamped values within schema ranges
    const beforeSave = await harness.apiGet<WorkspaceStateResponse>('/api/state')
    expect(beforeSave.status).toBe(200)
    const beforeRevision = beforeSave.data.revision

    const [saveResponse] = await Promise.all([
      page.waitForResponse(res => {
        if (res.request().method() !== 'POST') return false
        try {
          return new URL(res.url()).pathname.endsWith('/api/draft')
        } catch {
          return false
        }
      }),
      page.getByRole('button', { name: /保存/ }).first().click(),
    ])
    expect(saveResponse.status()).toBe(200)

    const currentHarness = harness
    await expect
      .poll(async () => {
        const st = await currentHarness.apiGet<WorkspaceStateResponse>('/api/state')
        return st.data.revision
      })
      .toBeGreaterThan(beforeRevision)

    const afterSave = await harness.apiGet<WorkspaceStateResponse>('/api/state')
    expect(afterSave.status).toBe(200)
    const savedPool = afterSave.data.draft.groups.find(g => g.id === groupId)?.members[0]
    expect(savedPool?.kind).toBe('pool')
    if (!savedPool || savedPool.kind !== 'pool') {
      throw new Error('Expected saved group member to be a pool rule')
    }
    expect(savedPool.quality).toBeDefined()
    expect(savedPool.quality?.maxLatencyMs).toBeDefined()
    expect(savedPool.quality?.maxLatencyMs).toBeGreaterThanOrEqual(0)
    expect(savedPool.quality?.maxLatencyMs).toBeLessThanOrEqual(600000)
    expect(savedPool.quality?.maxLossRate).toBeDefined()
    expect(savedPool.quality?.maxLossRate).toBeGreaterThanOrEqual(0)
    expect(savedPool.quality?.maxLossRate).toBeLessThanOrEqual(1)
    expect(savedPool.quality?.topN).toBeDefined()
    expect(Number.isInteger(savedPool.quality?.topN)).toBe(true)
    expect(savedPool.quality?.topN).toBeGreaterThanOrEqual(1)
    expect(savedPool.quality?.topN).toBeLessThanOrEqual(16000)

    collector.assertNoErrors()
  })

  test('T2-F9-04 switching group probe updates evaluation of all pool rules in that group', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe: probeA, deviceId: deviceA } = await pairMockProbe(harness, 'Probe-Alpha')
    const { probe: probeB, deviceId: deviceB } = await pairMockProbe(harness, 'Probe-Beta')

    const groupId = uniqueId('grp_')
    const { state, sourceId, storedNodes } = await seedSourceAndGroups(
      harness,
      subServer,
      'f9-04',
      [
        buildProxyNode('🇺🇸 US-01', { server: 'us-01.example.net', port: 12301 }),
        buildProxyNode('🇯🇵 JP-01', { server: 'jp-01.example.net', port: 12302 }),
        buildProxyNode('🇸🇬 SG-01', { server: 'sg-01.example.net', port: 12303 }),
        buildProxyNode('🇩🇪 DE-01', { server: 'de-01.example.net', port: 12304 }),
      ],
      {
        buildGroups: srcId => [
          buildProxyGroup({
            id: groupId,
            name: 'InheritedProbeGroup',
            type: 'select',
            qualityDeviceId: deviceA,
            members: [
              buildPoolMember({
                sourceIds: [srcId],
                regions: ['US', 'JP'],
                quality: buildQualityCondition({ maxLatencyMs: 150 }),
              }),
              buildPoolMember({
                sourceIds: [srcId],
                regions: ['SG', 'DE'],
                quality: buildQualityCondition({ aiAll: true }),
              }),
            ],
          }),
        ],
      },
    )

    const usNode = storedNodes.find(n => n.region === 'US')!
    const jpNode = storedNodes.find(n => n.region === 'JP')!
    const sgNode = storedNodes.find(n => n.region === 'SG')!
    const deNode = storedNodes.find(n => n.region === 'DE')!

    // Probe-Alpha: US-01 fast (40ms), JP-01 slow (350ms), SG-01 allGreen, DE-01 allRestricted
    const qA = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceA,
      keys: storedNodes.map(n => n.key),
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(qA.status).toBe(200)
    expect(
      (
        await probeA.pollAndComplete(node => {
          if (node.key === usNode.key) return { latencyMs: 40, ai: aiPresets.allRestricted('HK') }
          if (node.key === jpNode.key) return { latencyMs: 350, ai: aiPresets.allRestricted('HK') }
          if (node.key === sgNode.key) return { latencyMs: 350, ai: aiPresets.allGreen('SG') }
          return { latencyMs: 350, ai: aiPresets.allRestricted('HK') }
        })
      ).completeResponse?.status,
    ).toBe(200)

    // Probe-Beta: inverted — JP-01 fast (80ms), US-01 slow (400ms), DE-01 allGreen, SG-01 allRestricted
    const qB = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceB,
      keys: storedNodes.map(n => n.key),
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(qB.status).toBe(200)
    expect(
      (
        await probeB.pollAndComplete(node => {
          if (node.key === jpNode.key) return { latencyMs: 80, ai: aiPresets.allRestricted('HK') }
          if (node.key === usNode.key) return { latencyMs: 400, ai: aiPresets.allRestricted('HK') }
          if (node.key === deNode.key) return { latencyMs: 350, ai: aiPresets.allGreen('DE') }
          return { latencyMs: 350, ai: aiPresets.allRestricted('HK') }
        })
      ).completeResponse?.status,
    ).toBe(200)

    const pubA = await harness.apiPost('/api/publish', { revision: state.revision })
    expect(pubA.status).toBe(200)
    const linkRes = await harness.apiGet<{ url: string }>('/api/link')
    const subA = await harness.subGet(linkRes.data.url)
    assertYamlGroupExactOrder(parseMihomoYaml(subA.text), 'InheritedProbeGroup', [usNode.name, sgNode.name])

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
    await openGroupsPage(page, harness.baseUrl, groupId)
    await expectNoReportBaselinePicker(page)

    const filterSection = getRuleFilterSection(page)
    await expectInheritedProbeInRule(filterSection, 'Probe-Alpha')

    // Switch group probe to Probe-Beta via UI probe selector and verify both rules inherit Probe-Beta
    const probeSelector = filterSection.getByRole('combobox', { name: /探针/ }).first()
    await expect(probeSelector).toBeVisible()
    const betaOption = await probeSelector.locator('option').evaluateAll((options, targetId) => {
      const byValue = options.find(o => (o as HTMLOptionElement).value === targetId)
      if (byValue) {
        return { value: (byValue as HTMLOptionElement).value, label: (byValue.textContent ?? '').trim() }
      }
      const byLabel = options.find(o => /Probe-Beta/.test(o.textContent ?? ''))
      if (byLabel) {
        return { value: (byLabel as HTMLOptionElement).value, label: (byLabel.textContent ?? '').trim() }
      }
      return null
    }, deviceB)
    expect(betaOption, `No matching <option> for Probe-Beta (${deviceB})`).not.toBeNull()
    await probeSelector.selectOption(
      betaOption!.value ? { value: betaOption!.value } : { label: betaOption!.label },
    )
    await expectInheritedProbeInRule(filterSection, 'Probe-Beta')

    // Switch to Rule 2 in the group member list and verify it also inherits Probe-Beta
    const rule2EditBtn = page.getByRole('button', { name: /编辑筛选/ }).nth(1)
    await expect(rule2EditBtn).toBeVisible()
    await rule2EditBtn.click()
    await expectInheritedProbeInRule(getRuleFilterSection(page), 'Probe-Beta')

    await page.getByRole('button', { name: /保存/ }).first().click()
    const currentHarness = harness
    await expect
      .poll(async () => {
        const st = await currentHarness.apiGet<WorkspaceStateResponse>('/api/state')
        return st.data.draft.groups.find(g => g.id === groupId)?.qualityDeviceId
      })
      .toBe(deviceB)

    const updatedState = await harness.apiGet<WorkspaceStateResponse>('/api/state')
    expect(updatedState.data.draft.groups.find(g => g.id === groupId)?.members).toHaveLength(2)
    expect(sourceId).toBeTruthy()

    const checkB = await harness.apiPost<CheckViewResponse>('/api/check', {})
    expect(checkB.status).toBe(200)
    expect(checkB.data.groups.find(g => g.id === groupId)?.members.map(m => m.name)).toEqual([jpNode.name, deNode.name])

    const pubB = await harness.apiPost('/api/publish', { revision: updatedState.data.revision })
    expect(pubB.status).toBe(200)
    const subB = await harness.subGet(linkRes.data.url)
    assertYamlGroupExactOrder(parseMihomoYaml(subB.text), 'InheritedProbeGroup', [jpNode.name, deNode.name])

    collector.assertNoErrors()
  })

  test('T2-F9-05 evaluates multi-rule group mixing quality-filtered, non-quality, node, and builtin rules', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F9-Probe-05')

    const groupId = uniqueId('grp_')
    const { state, storedNodes } = await seedSourceAndGroups(
      harness,
      subServer,
      'f9-05',
      [
        buildProxyNode('🇺🇸 US-01', { server: 'us-01.example.net', port: 12401 }),
        buildProxyNode('🇯🇵 JP-01', { server: 'jp-01.example.net', port: 12402 }),
        buildProxyNode('🇸🇬 SG-01', { server: 'sg-01.example.net', port: 12403 }),
      ],
      {
        buildGroups: (srcId, nodes) => {
          const sg = nodes.find(n => n.region === 'SG')!
          return [
            buildProxyGroup({
              id: groupId,
              name: 'MixedRulesGroup',
              type: 'select',
              qualityDeviceId: deviceId,
              members: [
                buildPoolMember({
                  sourceIds: [srcId],
                  regions: ['US'],
                  quality: buildQualityCondition({ alive: true, maxLatencyMs: 100 }),
                }),
                buildPoolMember({
                  sourceIds: [srcId],
                  regions: ['JP'],
                }),
                { kind: 'node', sourceId: srcId, id: sg.id },
                buildPoolMember({
                  sourceIds: [srcId],
                  regions: ['US'],
                  quality: buildQualityCondition({ alive: true }),
                }),
                { kind: 'builtin', id: 'DIRECT' },
              ],
            }),
          ]
        },
      },
    )

    const usNode = storedNodes.find(n => n.region === 'US')!
    const jpNode = storedNodes.find(n => n.region === 'JP')!
    const sgNode = storedNodes.find(n => n.region === 'SG')!

    // Measure ONLY US-01 (pass) and JP-01 (fail); leave SG-01 completely untested
    const qRes = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [usNode.key, jpNode.key],
      config: basicOnlyConfig({ rounds: 2 }),
    })
    expect(qRes.status).toBe(200)
    const done = await probe.pollAndComplete(node =>
      node.key === usNode.key
        ? { available: true, latencyMs: 50 }
        : { available: false, error: 'no_response' },
    )
    expect(done.completeResponse?.status).toBe(200)

    const checkRes = await harness.apiPost<CheckViewResponse>('/api/check', {})
    expect(checkRes.status).toBe(200)
    const groupMembers = checkRes.data.groups.find(g => g.id === groupId)?.members ?? []
    expect(groupMembers.map(m => m.name)).toEqual([usNode.name, jpNode.name, sgNode.name, 'DIRECT'])

    const pubRes = await harness.apiPost('/api/publish', { revision: state.revision })
    expect(pubRes.status).toBe(200)
    const linkRes = await harness.apiGet<{ url: string }>('/api/link')
    const subRes = await harness.subGet(linkRes.data.url)
    expect(subRes.status).toBe(200)
    assertYamlGroupExactOrder(
      parseMihomoYaml(subRes.text),
      'MixedRulesGroup',
      [usNode.name, jpNode.name, sgNode.name, 'DIRECT'],
    )

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
    await openGroupsPage(page, harness.baseUrl, groupId)
    await expectNoReportBaselinePicker(page)

    const filterSection = getRuleFilterSection(page)
    await expect(filterSection).toBeVisible()
    await expect(filterSection).toContainText(/匹配\s*1\s*个保留节点/)

    collector.assertNoErrors()
  })
})
