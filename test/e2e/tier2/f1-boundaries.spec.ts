import assert from 'node:assert/strict'
import { expect, test, type Locator } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  basicAndAiConfig,
  basicOnlyConfig,
  aiOnlyConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildSource,
  type DraftConfig,
  uniqueId,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  aiReading,
  buildAgentReport,
  createMockProbe,
  parseInviteLink,
  type AgentReport,
  type AiResults,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockProxyNode, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  expectAiUnlockCell,
  expectNoAiPlatformFilterDropdown,
  expectNoLegacyAiPlatforms,
  expectNoReportBaselinePicker,
  findNodeRow,
  openNodesPage,
  openQualityPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface ProbeSetup {
  harness: AppHarness
  subServer: MockSubServer
  probe: MockProbeAgent
  profileId: string
  sourceId: string
  deviceId: string
  nodeKeys: string[]
  nodeNamesByKey: Record<string, string>
}

interface StatePayload {
  id: string
  revision: number
  draft: DraftConfig
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

interface CheckPayload {
  groups: Array<{
    id: string
    name: string
    members: Array<{ key: string; name: string; kind: string }>
  }>
}

const activeCleanups: Array<() => Promise<void>> = []

test.afterEach(async () => {
  while (activeCleanups.length > 0) {
    const fn = activeCleanups.pop()!
    await fn().catch(() => {})
  }
})

async function setupWithNodes(nodes: MockProxyNode[]): Promise<ProbeSetup> {
  const harness = await startAppHarness()
  activeCleanups.push(() => harness.close())

  const subServer = await startMockSubServer({
    main: { format: 'yaml', nodes },
  })
  activeCleanups.push(() => subServer.close())

  const initialStateRes = await harness.apiGet<StatePayload>('/api/state')
  assert.equal(initialStateRes.status, 200)

  const sourceId = uniqueId('src_')
  const feedUrl = subServer.urlFor('main')
  const probeRes = await harness.apiPost('/api/probe', {
    kind: 'source',
    id: sourceId,
    url: feedUrl,
  })
  assert.equal(probeRes.status, 200)

  const source = buildSource({ id: sourceId, name: 'F1 Boundary Source', url: feedUrl })
  const saveRes = await harness.apiPost<StatePayload>('/api/draft', {
    revision: initialStateRes.data.revision,
    draft: buildDraft({
      ...initialStateRes.data.draft,
      sources: [source],
    }),
  })
  assert.equal(saveRes.status, 200)

  const savedNodes = saveRes.data.sources[sourceId]?.good?.nodes ?? []
  const nodeKeys = savedNodes.map(n => `${sourceId}/${n.id}`)
  const nodeNamesByKey = Object.fromEntries(savedNodes.map(n => [`${sourceId}/${n.id}`, n.name]))

  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { origin, profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin, profileId, name: 'F1-Probe' })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
  assert.equal(devicesRes.status, 200)
  const deviceId = devicesRes.data[0]?.id
  assert.ok(deviceId, 'Expected paired probe deviceId')

  return {
    harness,
    subServer,
    probe,
    profileId,
    sourceId,
    deviceId,
    nodeKeys,
    nodeNamesByKey,
  }
}

async function expectAiCellUntestedOrSkipped(
  row: Locator,
  expectedKind?: 'untested' | 'weak_connection' | 'missing_exit',
): Promise<void> {
  await expect(row).toBeVisible()
  let aiCell = row
    .locator('td[data-col="ai"], [data-ai-unlock], td:has(.mobile-cell-label:has-text("AI 解锁"))')
    .first()
  if ((await aiCell.count()) === 0) {
    const colIndex = await row.evaluate(tr => {
      const table = tr.closest('table')
      if (!table) return -1
      const headerRow =
        Array.from(table.querySelectorAll('thead tr')).find(r => r.querySelector('th') !== null) ??
        Array.from(table.querySelectorAll('tr')).find(r => r.querySelector('th') !== null) ??
        null
      if (!headerRow) return -1
      return Array.from(headerRow.children).findIndex(
        cell => cell.tagName.toLowerCase() === 'th' && /AI\s*解锁/i.test(cell.textContent ?? ''),
      )
    })
    expect(colIndex, 'Unable to locate AI 解锁 column cell or header').toBeGreaterThanOrEqual(0)
    aiCell = row.locator(`td:nth-child(${colIndex + 1})`).first()
  }
  await expect(aiCell, 'Expected AI 解锁 cell in row').toHaveCount(1)
  await expect(aiCell).toBeVisible()
  const { cellText, titleText } = await aiCell.evaluate(el => {
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.mobile-cell-label').forEach(node => node.remove())
    const titled = el.getAttribute('title') ?? el.querySelector('[title]')?.getAttribute('title') ?? ''
    return {
      cellText: (clone.textContent ?? '').trim(),
      titleText: titled.trim(),
    }
  })
  expect(cellText, 'AI 解锁 cell must not be empty').not.toBe('')
  expect(cellText).not.toMatch(/NaN|undefined|null/)
  expect(cellText).not.toMatch(/grok|claude/i)
  if (expectedKind === 'untested') {
    expect(cellText).toMatch(/^(?:未检测|未测|AI\s*未检测)$/)
  } else if (expectedKind === 'weak_connection') {
    expect(cellText).toBe('弱网跳过')
    expect(titleText).toMatch(/已跳过\s*AI\s*检测/)
    expect(titleText).toMatch(/丢包过高|延迟过长/)
  } else if (expectedKind === 'missing_exit') {
    expect(cellText).toBe('未取到出口')
    expect(titleText).toMatch(/已跳过\s*AI\s*检测/)
    expect(titleText).toMatch(/未获取出口/)
  } else {
    expect(cellText).toMatch(
      /^(?:未检测|未测|AI\s*未检测|已跳过|跳过|弱网跳过|未取到出口|—|-)$|^(?:未检测|未测|AI\s*未检测|已跳过|跳过|弱网跳过|未取到出口)(?:[\s（(·:—\-].*)?$|(?:已跳过|弱网跳过|未取到出口|AI\s*未检测)/,
    )
  }
}

test.describe('F1 Boundaries: Prune Grok & Claude, Exit Inference, and 3-State AI Display', () => {
  test('T2-F1-01 rejects legacy grok/claudeWeb/claudeApi in complete without mutating latest or report', async () => {
    const { harness, probe, deviceId, nodeKeys } = await setupWithNodes([
      buildProxyNode('🇺🇸 US-Alpha-01', { server: 'us-alpha.example.net', port: 10001 }),
    ])

    const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicAndAiConfig(),
    })
    assert.equal(queueRes.status, 200)

    const pollRes = await probe.poll({ wait: false })
    assert.equal(pollRes.status, 200)
    assert.ok(pollRes.body && typeof pollRes.body === 'object' && 'jobId' in pollRes.body)
    const assignment = pollRes.body

    const cleanReport = buildAgentReport(assignment, () => ({
      ai: aiPresets.allGreen('US'),
    }))

    const legacyPayloads: Array<Record<string, unknown>> = [
      { ...cleanReport.results[0].ai, grok: aiReading.green('US') },
      { ...cleanReport.results[0].ai, claudeWeb: aiReading.restricted('region_restricted', 'HK') },
      { ...cleanReport.results[0].ai, claudeApi: aiReading.uncertain('challenge') },
      {
        grok: aiReading.green('US'),
        claudeWeb: aiReading.restricted(),
        claudeApi: aiReading.uncertain(),
      },
    ]

    for (const badAi of legacyPayloads) {
      const malformedReport: AgentReport = {
        ...cleanReport,
        results: [
          {
            ...cleanReport.results[0],
            ai: badAi as unknown as AiResults,
          },
        ],
      }
      const completeRes = await probe.complete(assignment.jobId, malformedReport)
      assert.equal(completeRes.status, 400)
      assert.equal(completeRes.ok, false)
    }

    const jobsAfterReject = await harness.apiGet<Array<{ id: string; status: string }>>('/api/quality/jobs')
    assert.equal(jobsAfterReject.status, 200)
    assert.equal(jobsAfterReject.data[0]?.id, assignment.jobId)
    assert.equal(jobsAfterReject.data[0]?.status, 'running')
    assertNoLegacyAiStrings(jobsAfterReject.data)

    const missingReport = await harness.apiGet(`/api/quality/report?id=${assignment.jobId}`)
    assert.equal(missingReport.status, 404)

    const latestBeforeClean = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
    assert.equal(latestBeforeClean.status, 200)
    assert.deepEqual(latestBeforeClean.data, {})

    const validComplete = await probe.complete(assignment.jobId, cleanReport)
    assert.equal(validComplete.status, 200)

    const reportRes = await harness.apiGet<{ results: Array<{ ai: unknown }> }>(
      `/api/quality/report?id=${assignment.jobId}`,
    )
    assert.equal(reportRes.status, 200)
    assertThreeSurfaceAi(reportRes.data.results[0]?.ai)
    assertNoLegacyAiStrings(reportRes.data)

    const latestAfterClean = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
    assert.equal(latestAfterClean.status, 200)
    assertNoLegacyAiStrings(latestAfterClean.data)
  })

  test('T2-F1-02 rejects legacy AI keys and sorts in POST /api/draft quality conditions', async () => {
    const { harness, sourceId, deviceId } = await setupWithNodes([
      buildProxyNode('🇺🇸 US-Draft-01', { server: 'us-draft.example.net', port: 10002 }),
    ])

    const stateRes = await harness.apiGet<StatePayload>('/api/state')
    assert.equal(stateRes.status, 200)

    const invalidQualityPayloads: Array<Record<string, unknown>> = [
      { aiSurfaces: ['chatgptWeb', 'grok'] },
      { platforms: ['claudeWeb', 'claudeApi'] },
      { aiPlatforms: ['Claude', 'Grok'] },
      { sortBy: 'Grok' },
      { sortBy: 'claudeApi' },
      { grok: true },
    ]

    for (const badQuality of invalidQualityPayloads) {
      const group = buildProxyGroup({
        name: 'BadLegacyGroup',
        qualityDeviceId: deviceId,
        members: [
          buildPoolMember({
            sourceIds: [sourceId],
            quality: badQuality as unknown as ReturnType<typeof buildQualityCondition>,
          }),
        ],
      })
      const draftRes = await harness.apiPost('/api/draft', {
        revision: stateRes.data.revision,
        draft: buildDraft({
          ...stateRes.data.draft,
          groups: [group],
        }),
      })
      assert.equal(draftRes.status, 400, `Expected 400 for quality payload ${JSON.stringify(badQuality)}`)
    }

    const afterState = await harness.apiGet<StatePayload>('/api/state')
    assert.equal(afterState.status, 200)
    assert.equal(afterState.data.draft.groups.length, 0)
    assertNoLegacyAiStrings(afterState.data.draft)
  })

  test('T2-F1-03 inferredExitRegion returns null when 3 surfaces disagree and infers when 2 agree', async () => {
    const { harness, probe, sourceId, deviceId, nodeKeys } = await setupWithNodes([
      buildProxyNode('Alpha-Disagree', { server: 'alpha.example.net', port: 10003 }),
      buildProxyNode('Beta-Agree2', { server: 'beta.example.net', port: 10004 }),
    ])

    const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: aiOnlyConfig(),
    })
    assert.equal(queueRes.status, 200)

    const pollRes = await probe.poll({ wait: false })
    assert.equal(pollRes.status, 200)
    assert.ok(pollRes.body && typeof pollRes.body === 'object' && 'jobId' in pollRes.body)
    const assignment = pollRes.body

    const report = buildAgentReport(assignment, node => {
      if (node.name.includes('Alpha-Disagree')) {
        return {
          exit: null,
          ai: {
            chatgptWeb: aiReading.green('US', 'chatgptWeb'),
            chatgptApp: aiReading.green('JP', 'chatgptApp'),
            gemini: aiReading.green('SG', 'gemini'),
          },
        }
      }
      return {
        exit: null,
        ai: {
          chatgptWeb: aiReading.green('JP', 'chatgptWeb'),
          chatgptApp: aiReading.green('JP', 'chatgptApp'),
          gemini: aiReading.uncertain('unknown', null),
        },
      }
    })

    const completeRes = await probe.complete(assignment.jobId, report)
    assert.equal(completeRes.status, 200)

    const latestRes = await harness.apiGet<Record<string, { basic: unknown; ai: { results: unknown } | null }>>(
      `/api/quality/latest?deviceId=${deviceId}`,
    )
    assert.equal(latestRes.status, 200)
    for (const key of nodeKeys) {
      assert.equal(latestRes.data[key]?.basic, null)
      assertThreeSurfaceAi(latestRes.data[key]?.ai?.results)
    }

    const stateRes = await harness.apiGet<StatePayload>('/api/state')
    assert.equal(stateRes.status, 200)

    const groupJp = buildProxyGroup({
      name: 'Inferred-JP',
      qualityDeviceId: deviceId,
      members: [buildPoolMember({ sourceIds: [sourceId], quality: buildQualityCondition({ exitRegions: ['JP'] }) })],
    })
    const groupUs = buildProxyGroup({
      name: 'Inferred-US',
      qualityDeviceId: deviceId,
      members: [buildPoolMember({ sourceIds: [sourceId], quality: buildQualityCondition({ exitRegions: ['US'] }) })],
    })
    const groupSg = buildProxyGroup({
      name: 'Inferred-SG',
      qualityDeviceId: deviceId,
      members: [buildPoolMember({ sourceIds: [sourceId], quality: buildQualityCondition({ exitRegions: ['SG'] }) })],
    })

    const draftRes = await harness.apiPost('/api/draft', {
      revision: stateRes.data.revision,
      draft: buildDraft({
        ...stateRes.data.draft,
        groups: [groupJp, groupUs, groupSg],
      }),
    })
    assert.equal(draftRes.status, 200)

    const checkRes = await harness.apiPost<CheckPayload>('/api/check', {})
    assert.equal(checkRes.status, 200)

    const jpMembers = checkRes.data.groups.find(g => g.id === groupJp.id)?.members ?? []
    const usMembers = checkRes.data.groups.find(g => g.id === groupUs.id)?.members ?? []
    const sgMembers = checkRes.data.groups.find(g => g.id === groupSg.id)?.members ?? []

    assert.deepEqual(
      jpMembers.map(m => m.name),
      ['Beta-Agree2'],
    )
    assert.equal(usMembers.length, 0)
    assert.equal(sgMembers.length, 0)
  })

  test('T2-F1-04 needsReview true with 2 agreeing regions excludes aiAll and renders warning in UI', async ({ page }) => {
    const { harness, probe, sourceId, deviceId, nodeKeys } = await setupWithNodes([
      buildProxyNode('Alpha-Review', { server: 'alpha-review.example.net', port: 10005 }),
    ])

    const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: aiOnlyConfig(),
    })
    assert.equal(queueRes.status, 200)

    const pollRes = await probe.poll({ wait: false })
    assert.equal(pollRes.status, 200)
    assert.ok(pollRes.body && typeof pollRes.body === 'object' && 'jobId' in pollRes.body)
    const assignment = pollRes.body

    const report = buildAgentReport(assignment, () => ({
      exit: null,
      ai: {
        chatgptWeb: {
          state: 'reachable',
          evidence: 'compliance_json',
          httpStatus: 200,
          needsReview: true,
          providerRegion: 'US',
        },
        chatgptApp: {
          state: 'region_mismatch',
          evidence: 'region_disagrees',
          httpStatus: 200,
          needsReview: true,
          providerRegion: 'US',
        },
        gemini: aiReading.green('US', 'gemini'),
      },
    }))

    const completeRes = await probe.complete(assignment.jobId, report)
    assert.equal(completeRes.status, 200)

    const stateRes = await harness.apiGet<StatePayload>('/api/state')
    assert.equal(stateRes.status, 200)

    const groupAiAll = buildProxyGroup({
      name: 'Group-AiAll',
      qualityDeviceId: deviceId,
      members: [buildPoolMember({ sourceIds: [sourceId], quality: buildQualityCondition({ aiAll: true }) })],
    })
    const groupGemini = buildProxyGroup({
      name: 'Group-GeminiOnly',
      qualityDeviceId: deviceId,
      members: [buildPoolMember({ sourceIds: [sourceId], quality: buildQualityCondition({ aiSurfaces: ['gemini'] }) })],
    })
    const groupExitUs = buildProxyGroup({
      name: 'Group-ExitUS',
      qualityDeviceId: deviceId,
      members: [buildPoolMember({ sourceIds: [sourceId], quality: buildQualityCondition({ exitRegions: ['US'] }) })],
    })

    const draftRes = await harness.apiPost('/api/draft', {
      revision: stateRes.data.revision,
      draft: buildDraft({
        ...stateRes.data.draft,
        groups: [groupAiAll, groupGemini, groupExitUs],
      }),
    })
    assert.equal(draftRes.status, 200)

    const checkRes = await harness.apiPost<CheckPayload>('/api/check', {})
    assert.equal(checkRes.status, 200)

    assert.equal(checkRes.data.groups.find(g => g.id === groupAiAll.id)?.members.length, 0)
    assert.deepEqual(
      checkRes.data.groups.find(g => g.id === groupGemini.id)?.members.map(m => m.name),
      ['Alpha-Review'],
    )
    assert.deepEqual(
      checkRes.data.groups.find(g => g.id === groupExitUs.id)?.members.map(m => m.name),
      ['Alpha-Review'],
    )

    const errors = attachErrorCollectors(page)
    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

    await openNodesPage(page, harness.baseUrl)
    await expectNoLegacyAiPlatforms(page)
    await expectNoAiPlatformFilterDropdown(page)
    await expectAiUnlockCell(findNodeRow(page, 'Alpha-Review'), [
      { surface: 'ChatGPT Web', tone: 'warning', label: '未知' },
      { surface: 'ChatGPT APP', tone: 'warning', label: '未知' },
      { surface: 'Gemini Web', tone: 'success', label: 'US' },
    ])

    await openQualityPage(page, harness.baseUrl, 'reports')
    await expectNoLegacyAiPlatforms(page)
    await expectNoAiPlatformFilterDropdown(page)
    await expectAiUnlockCell(findNodeRow(page, 'Alpha-Review'), [
      { surface: 'ChatGPT Web', tone: 'warning', label: '未知' },
      { surface: 'ChatGPT APP', tone: 'warning', label: '未知' },
      { surface: 'Gemini Web', tone: 'success', label: 'US' },
    ])

    errors.assertNoErrors()
  })

  test('T2-F1-05 ai null and aiSkipped states render without Grok/Claude placeholders', async ({ page }) => {
    const { harness, probe, deviceId, nodeKeys, nodeNamesByKey } = await setupWithNodes([
      buildProxyNode('Alpha-BasicOnly', { server: 'alpha-basic.example.net', port: 10006 }),
      buildProxyNode('Beta-WeakConn', { server: 'beta-weak.example.net', port: 10007 }),
      buildProxyNode('Gamma-Mixed', { server: 'gamma-mixed.example.net', port: 10008 }),
      buildProxyNode('Delta-MissingExit', { server: 'delta-missing.example.net', port: 10009 }),
    ])

    const keyByName = Object.fromEntries(Object.entries(nodeNamesByKey).map(([k, v]) => [v, k]))
    const keyBasicOnly = keyByName['Alpha-BasicOnly']
    const keyWeakConn = keyByName['Beta-WeakConn']
    const keyMixed = keyByName['Gamma-Mixed']
    const keyMissingExit = keyByName['Delta-MissingExit']
    assert.ok(keyBasicOnly && keyWeakConn && keyMixed && keyMissingExit)

    // Job 1: basicOnlyConfig -> ai === null
    const q1 = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [keyBasicOnly],
      config: basicOnlyConfig(),
    })
    assert.equal(q1.status, 200)
    const p1 = await probe.poll({ wait: false })
    assert.ok(p1.body && typeof p1.body === 'object' && 'jobId' in p1.body)
    const r1 = buildAgentReport(p1.body)
    assert.equal(r1.results[0]?.ai, null)
    assert.equal((await probe.complete(p1.body.jobId, r1)).status, 200)

    // Job 2: aiOnlyConfig with missing_exit -> aiSkipped: 'missing_exit', ai: null, available: false
    const q2 = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [keyMissingExit],
      config: aiOnlyConfig(),
    })
    assert.equal(q2.status, 200)
    const p2 = await probe.poll({ wait: false })
    assert.ok(p2.body && typeof p2.body === 'object' && 'jobId' in p2.body)
    const r2 = buildAgentReport(p2.body, () => ({ aiSkipped: 'missing_exit' }))
    assert.equal(r2.results[0]?.aiSkipped, 'missing_exit')
    assert.equal(r2.results[0]?.ai, null)
    assert.equal(r2.results[0]?.available, false)
    assert.equal((await probe.complete(p2.body.jobId, r2)).status, 200)

    // Job 3: basicAndAiConfig -> weak_connection + mixed 3-surface row
    const q3 = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [keyWeakConn, keyMixed],
      config: basicAndAiConfig({ rounds: 3 }),
    })
    assert.equal(q3.status, 200)
    const p3 = await probe.poll({ wait: false })
    assert.ok(p3.body && typeof p3.body === 'object' && 'jobId' in p3.body)
    const r3 = buildAgentReport(p3.body, node => {
      if (node.key === keyWeakConn) {
        return {
          samples: [
            { tlsMs: 10, httpsMs: 4200, httpStatus: 204 },
            { tlsMs: 10, httpsMs: 4200, httpStatus: 204 },
            { tlsMs: 10, httpsMs: 4200, httpStatus: 204 },
          ],
        }
      }
      return { ai: aiPresets.mixed('US') }
    })
    assert.equal((await probe.complete(p3.body.jobId, r3)).status, 200)

    // Verify backend reports and latest records contain zero legacy AI terms
    for (const jobId of [q1.data.id, q2.data.id, q3.data.id]) {
      const repRes = await harness.apiGet(`/api/quality/report?id=${jobId}`)
      assert.equal(repRes.status, 200)
      assertNoLegacyAiStrings(repRes.data)
    }

    const latestRes = await harness.apiGet<
      Record<string, { ai: { results: unknown; aiSkipped?: string } | null }>
    >(`/api/quality/latest?deviceId=${deviceId}`)
    assert.equal(latestRes.status, 200)
    assert.equal(Object.keys(latestRes.data).length, nodeKeys.length)
    assertNoLegacyAiStrings(latestRes.data)
    assert.equal(latestRes.data[keyBasicOnly]?.ai, null)
    assert.equal(latestRes.data[keyWeakConn]?.ai?.aiSkipped, 'weak_connection')
    assert.equal(latestRes.data[keyWeakConn]?.ai?.results, null)
    assert.equal(latestRes.data[keyMissingExit]?.ai?.aiSkipped, 'missing_exit')
    assert.equal(latestRes.data[keyMissingExit]?.ai?.results, null)
    assertThreeSurfaceAi(latestRes.data[keyMixed]?.ai?.results)

    // UI verification against M4 #/quality Reports & M5 #/nodes unified AI column
    const errors = attachErrorCollectors(page)
    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

    await openQualityPage(page, harness.baseUrl, 'reports')
    await expectNoLegacyAiPlatforms(page)
    await expectNoAiPlatformFilterDropdown(page)
    await expectAiUnlockCell(findNodeRow(page, 'Gamma-Mixed'), [
      { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
      { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
      { surface: 'Gemini Web', tone: 'warning', label: '未知' },
    ])
    const weakReportRow = findNodeRow(page, 'Beta-WeakConn')
    await expectAiCellUntestedOrSkipped(weakReportRow, 'weak_connection')

    await openNodesPage(page, harness.baseUrl)
    await expectNoLegacyAiPlatforms(page)
    await expectNoAiPlatformFilterDropdown(page)
    await expectNoReportBaselinePicker(page)
    await expectAiUnlockCell(findNodeRow(page, 'Gamma-Mixed'), [
      { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
      { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
      { surface: 'Gemini Web', tone: 'warning', label: '未知' },
    ])
    await expectAiCellUntestedOrSkipped(findNodeRow(page, 'Alpha-BasicOnly'), 'untested')
    await expectAiCellUntestedOrSkipped(findNodeRow(page, 'Beta-WeakConn'), 'weak_connection')
    await expectAiCellUntestedOrSkipped(findNodeRow(page, 'Delta-MissingExit'), 'missing_exit')

    errors.assertNoErrors()
  })
})
