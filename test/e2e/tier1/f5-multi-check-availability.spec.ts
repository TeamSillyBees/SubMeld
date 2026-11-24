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
  assertAvailabilityStats,
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
  type LatestNodeQuality,
} from '../helpers/fixtures.ts'
import {
  attachErrorCollectors,
  expectAvailabilityBadgeOrText,
  findNodeRow,
  openNodesPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface DraftStateResponse {
  id: string
  revision: number
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

async function setupAvailabilityContext(nodeNames: string[]) {
  const nodes = nodeNames.map((name, idx) =>
    buildProxyNode(name, { server: `avail-${idx}.example.net`, port: 10400 + idx }),
  )
  const subServer = await startMockSubServer({ feed1: { format: 'yaml', nodes } })
  const harness = await startAppHarness({ useRealCore: false })

  const state0 = await harness.apiGet<DraftStateResponse>('/api/state')
  assert.equal(state0.status, 200)

  const source = buildSource({ id: uniqueId('src_'), name: '可用率订阅源', url: subServer.urlFor('feed1') })
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

  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Probe-Avail' })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<Array<{ id: string }>>('/api/quality/devices')
  const deviceId = devicesRes.data[0]?.id
  assert.ok(deviceId)

  return {
    subServer,
    harness,
    source,
    revision: draftRes.data.revision,
    profileId,
    nodeMap,
    probe,
    deviceId,
  }
}

async function runBasicSequence(
  harness: AppHarness,
  probe: MockProbeAgent,
  deviceId: string,
  nodeKeys: string[],
  outcomesByKey: Record<string, boolean[]>,
) {
  const runs = Math.max(...Object.values(outcomesByKey).map(arr => arr.length))
  for (let i = 0; i < runs; i++) {
    const queueRes = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicOnlyConfig({ rounds: 2 }),
    })
    assert.equal(queueRes.status, 200)

    const completed = await probe.pollAndComplete((node) => {
      const ok = outcomesByKey[node.key]?.[i] ?? true
      return ok ? { latencyMs: 60 } : { available: false, error: 'no_response' }
    })
    assert.equal(completed.completeResponse?.status, 200)
  }
}

test.describe('Tier 1 — F5: Multi-Check Availability Statistics', () => {
  test('T1-F5-01 Mixed pass/fail basic runs yield rolling rate=0.75 (3/4) in API and SQLite', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupAvailabilityContext(['Node-A', 'Node-B'])
      subServer = ctx.subServer
      harness = ctx.harness

      const keyA = ctx.nodeMap.get('Node-A')!
      const keyB = ctx.nodeMap.get('Node-B')!

      await runBasicSequence(harness, ctx.probe, ctx.deviceId, [keyA, keyB], {
        [keyA]: [true, false, true, true],
        [keyB]: [false, true, false, false],
      })

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      assert.equal(latestRes.status, 200)
      const latestMap = unwrapLatestForDevice(latestRes.data, ctx.deviceId)

      assertAvailabilityStats(latestMap[keyA].availability, 3, 4)
      assert.deepEqual(latestMap[keyA].availability?.window, [true, false, true, true])
      assert.equal(latestMap[keyA].availability?.rate, 0.75)

      assertAvailabilityStats(latestMap[keyB].availability, 1, 4)
      assert.equal(latestMap[keyB].availability?.rate, 0.25)

      const dbDoc = harness.readDbDoc<LatestNodeQuality>(
        `quality-latest/${ctx.profileId}`,
        `${ctx.deviceId}/${keyA}`,
      )
      assert.ok(dbDoc)
      assertAvailabilityStats(dbDoc.availability, 3, 4)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F5-02 AI-only (basic=false) job leaves availability unmutated and uninitialized', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupAvailabilityContext(['Node-A', 'Node-B'])
      subServer = ctx.subServer
      harness = ctx.harness

      const keyA = ctx.nodeMap.get('Node-A')!
      const keyB = ctx.nodeMap.get('Node-B')!

      await runBasicSequence(harness, ctx.probe, ctx.deviceId, [keyA], {
        [keyA]: [true, true, false],
      })

      const aiQueue = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [keyA, keyB],
        config: aiOnlyConfig(),
      })
      assert.equal(aiQueue.status, 200)
      const aiComplete = await ctx.probe.pollAndComplete(() => ({
        exit: null,
        ai: aiPresets.allGreen('JP'),
      }))
      assert.equal(aiComplete.completeResponse?.status, 200)

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      const latestMap = unwrapLatestForDevice(latestRes.data, ctx.deviceId)

      assertAvailabilityStats(latestMap[keyA].availability, 2, 3)
      assert.deepEqual(latestMap[keyA].availability?.window, [true, true, false])
      assert.ok(latestMap[keyA].ai?.results)

      assert.equal(latestMap[keyB].basic, null)
      assert.equal(latestMap[keyB].availability, null)
      assert.ok(latestMap[keyB].ai?.results)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F5-03 #/nodes displays multi-check availability percentages (75% and 80%)', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupAvailabilityContext(['Node-A', 'Node-B'])
      subServer = ctx.subServer
      harness = ctx.harness

      const keyA = ctx.nodeMap.get('Node-A')!
      const keyB = ctx.nodeMap.get('Node-B')!

      await runBasicSequence(harness, ctx.probe, ctx.deviceId, [keyA], {
        [keyA]: [true, false, true, true], // 3/4 = 75%
      })
      await runBasicSequence(harness, ctx.probe, ctx.deviceId, [keyB], {
        [keyB]: [true, true, true, true, false], // 4/5 = 80%
      })

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openNodesPage(page, harness.baseUrl, { sort: 'availability' })

      const rowA = findNodeRow(page, 'Node-A')
      const rowB = findNodeRow(page, 'Node-B')
      await expectAvailabilityBadgeOrText(rowA, '75%')
      await expectAvailabilityBadgeOrText(rowB, '80%')

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F5-04 #/nodes sort by 可用率 orders nodes by multi-check rate descending and ascending', async ({ page }) => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupAvailabilityContext(['Node-Low', 'Node-High', 'Node-Mid'])
      subServer = ctx.subServer
      harness = ctx.harness

      const keyLow = ctx.nodeMap.get('Node-Low')!
      const keyHigh = ctx.nodeMap.get('Node-High')!
      const keyMid = ctx.nodeMap.get('Node-Mid')!

      // Last check intentionally inverted between Node-Low (last=true) and Node-Mid (last=false)
      await runBasicSequence(harness, ctx.probe, ctx.deviceId, [keyLow, keyHigh, keyMid], {
        [keyLow]: [false, false, false, true], // 25%
        [keyHigh]: [true, true, true, true],   // 100%
        [keyMid]: [true, true, true, false],   // 75%
      })

      const collector = attachErrorCollectors(page)
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openNodesPage(page, harness.baseUrl)

      const availSortBtn = page
        .getByRole('group', { name: /节点质量排序/ })
        .getByRole('button', { name: /可用率/ })
      await expect(availSortBtn).toBeVisible()
      await availSortBtn.click()

      await expect.poll(() => page.url()).toContain('sort=availability')

      const getRowOrder = () =>
        page.locator('.nodes-table tbody tr').evaluateAll(rows =>
          rows.map(r => r.textContent ?? ''),
        )

      const descRows = await getRowOrder()
      const idxHigh = descRows.findIndex(t => t.includes('Node-High'))
      const idxMid = descRows.findIndex(t => t.includes('Node-Mid'))
      const idxLow = descRows.findIndex(t => t.includes('Node-Low'))
      expect(idxHigh).toBeGreaterThanOrEqual(0)
      expect(idxHigh).toBeLessThan(idxMid)
      expect(idxMid).toBeLessThan(idxLow)

      await availSortBtn.click()
      await expect.poll(() => page.url()).toContain('sort=-availability')

      const ascRows = await getRowOrder()
      const ascLow = ascRows.findIndex(t => t.includes('Node-Low'))
      const ascMid = ascRows.findIndex(t => t.includes('Node-Mid'))
      const ascHigh = ascRows.findIndex(t => t.includes('Node-High'))
      expect(ascLow).toBeGreaterThanOrEqual(0)
      expect(ascLow).toBeLessThan(ascMid)
      expect(ascMid).toBeLessThan(ascHigh)

      collector.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F5-05 minAvailability filter keeps 4/5 (80%) and drops 3/5 (60%) in check and Mihomo YAML', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupAvailabilityContext(['Node-80', 'Node-60'])
      subServer = ctx.subServer
      harness = ctx.harness

      const key80 = ctx.nodeMap.get('Node-80')!
      const key60 = ctx.nodeMap.get('Node-60')!

      await runBasicSequence(harness, ctx.probe, ctx.deviceId, [key80, key60], {
        [key80]: [true, true, true, true, false], // 4/5 = 0.8 (last check false!)
        [key60]: [true, true, true, false, false], // 3/5 = 0.6
      })

      const group = buildProxyGroup({
        name: '高可用率组',
        qualityDeviceId: ctx.deviceId,
        members: [
          buildPoolMember({
            sourceIds: [ctx.source.id],
            quality: buildQualityCondition({ minAvailability: 0.8, sortBy: 'availability' }),
          }),
        ],
      })

      const saveRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
        revision: ctx.revision,
        draft: buildDraft({ sources: [ctx.source], groups: [group] }),
      })
      assert.equal(saveRes.status, 200)

      const checkRes = await harness.apiPost<{ groups: Array<{ members: Array<{ name: string }> }> }>('/api/check', {})
      assert.equal(checkRes.status, 200)
      assert.deepEqual(checkRes.data.groups[0]?.members.map(m => m.name), ['Node-80'])

      const publishRes = await harness.apiPost('/api/publish', { revision: saveRes.data.revision })
      assert.equal(publishRes.status, 200)

      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.ok(linkRes.data.url)
      const subRes = await harness.subGet(linkRes.data.url)
      assert.equal(subRes.status, 200)
      const yamlObj = parseMihomoYaml(subRes.text)
      assertYamlGroupExactOrder(yamlObj, group.name, ['Node-80'])
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
