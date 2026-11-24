import { expect, test, type Locator } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  aiOnlyConfig,
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  basicAndAiConfig,
  basicOnlyConfig,
  buildDraft,
  buildFilter,
  buildProxyNode,
  buildSource,
  uniqueId,
  unwrapLatestForDevice,
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
  expectAiUnlockCell,
  expectNoAiPlatformFilterDropdown,
  expectNoHorizontalOverflow,
  expectNoLegacyAiPlatforms,
  findNodeRow,
  openNodesPage,
  openQualityPage,
  runAxeAudit,
  unlockOrSetupAuth,
  waitForAnimationsToSettle,
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

interface ProbeDeviceItem {
  id: string
  name: string
}

interface QueuedJobResponse {
  id: string
  status: string
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

async function seedNodes(
  harness: AppHarness,
  subServer: MockSubServer,
  feedId: string,
  names: string[],
): Promise<{ nodeKeys: string[]; nodeNames: string[] }> {
  const nodes = names.map((name, idx) =>
    buildProxyNode(name, { server: `f8-node-${idx + 1}.example.net`, port: 11000 + idx }),
  )
  subServer.setFeed(feedId, { format: 'yaml', nodes })
  const initial = await harness.apiGet<WorkspaceStateResponse>('/api/state')
  expect(initial.status).toBe(200)
  const sourceId = uniqueId('src_')
  const srcUrl = subServer.urlFor(feedId)
  const probeRes = await harness.apiPost('/api/probe', { kind: 'source', id: sourceId, url: srcUrl })
  expect(probeRes.status).toBe(200)

  const draft = buildDraft({
    ...initial.data.draft,
    sources: [
      buildSource({
        id: sourceId,
        name: `F8源-${feedId}`,
        url: srcUrl,
        filter: buildFilter({ unknown: 'keep' }),
      }),
    ],
  })
  const saved = await harness.apiPost<WorkspaceStateResponse>('/api/draft', {
    revision: initial.data.revision,
    draft,
  })
  expect(saved.status).toBe(200)
  const stored = saved.data.sources[sourceId]?.good?.nodes ?? []
  expect(stored).toHaveLength(names.length)
  return {
    nodeKeys: stored.map(n => `${sourceId}/${n.id}`),
    nodeNames: stored.map(n => n.name),
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

test.describe('Tier 2 F8 — Unified 3-Platform AI Unlock Column & Display Boundaries', () => {
  let harness: AppHarness | undefined
  let subServer: MockSubServer | undefined

  test.afterEach(async () => {
    await subServer?.close()
    subServer = undefined
    await harness?.close()
    harness = undefined
  })

  test('T2-F8-01 renders green "可用" when reachable has providerRegion: null and exitRegion: null', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F8-Probe-01')
    const { nodeKeys, nodeNames } = await seedNodes(harness, subServer, 'f8-01', ['Alpha-01'])

    const qRes = await harness.apiPost<QueuedJobResponse>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(qRes.status).toBe(200)

    const done = await probe.pollAndComplete(() => ({
      exit: null,
      ai: {
        chatgptWeb: aiReading.green(null, 'chatgptWeb'),
        chatgptApp: aiReading.green(null, 'chatgptApp'),
        gemini: aiReading.green(null, 'gemini'),
      },
    }))
    expect(done.completeResponse?.status).toBe(200)

    const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)
    expect(latestRes.status).toBe(200)
    const latest = unwrapLatestForDevice(latestRes.data, deviceId)
    const rec = latest[nodeKeys[0]]
    expect(rec.basic?.exit).toBeNull()
    assertThreeSurfaceAi(rec.ai?.results)
    expect(rec.ai?.results?.chatgptWeb.providerRegion).toBeNull()
    assertNoLegacyAiStrings(latestRes.data)

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

    await openNodesPage(page, harness.baseUrl)
    await expectNoAiPlatformFilterDropdown(page)
    await expectNoLegacyAiPlatforms(page)
    await expectAiUnlockCell(findNodeRow(page, nodeNames[0]), [
      { surface: 'ChatGPT Web', tone: 'success', label: '可用' },
      { surface: 'ChatGPT APP', tone: 'success', label: '可用' },
      { surface: 'Gemini Web', tone: 'success', label: '可用' },
    ])

    await openQualityPage(page, harness.baseUrl, 'reports')
    await expectNoAiPlatformFilterDropdown(page)
    await expectNoLegacyAiPlatforms(page)
    await expectAiUnlockCell(findNodeRow(page, nodeNames[0]), [
      { surface: 'ChatGPT Web', tone: 'success', label: '可用' },
      { surface: 'ChatGPT APP', tone: 'success', label: '可用' },
      { surface: 'Gemini Web', tone: 'success', label: '可用' },
    ])

    collector.assertNoErrors()
  })

  test('T2-F8-02 renders yellow "未知" (not "受限") when unavailable has needsReview: true', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F8-Probe-02')
    const { nodeKeys, nodeNames } = await seedNodes(harness, subServer, 'f8-02', ['Beta-02'])

    const qRes = await harness.apiPost<QueuedJobResponse>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(qRes.status).toBe(200)

    const done = await probe.pollAndComplete(() => ({
      ai: {
        chatgptWeb: { ...aiReading.restricted('unavailable'), needsReview: true },
        chatgptApp: aiReading.restricted('unavailable'),
        gemini: aiReading.uncertain('challenge'),
      },
    }))
    expect(done.completeResponse?.status).toBe(200)

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

    const expected = [
      { surface: 'ChatGPT Web' as const, tone: 'warning' as const, label: '未知' },
      { surface: 'ChatGPT APP' as const, tone: 'danger' as const, label: '受限' },
      { surface: 'Gemini Web' as const, tone: 'warning' as const, label: '未知' },
    ]

    await openNodesPage(page, harness.baseUrl)
    await expectAiUnlockCell(findNodeRow(page, nodeNames[0]), expected)

    await openQualityPage(page, harness.baseUrl, 'reports')
    await expectAiUnlockCell(findNodeRow(page, nodeNames[0]), expected)

    collector.assertNoErrors()
  })

  test('T2-F8-03 renders non-crashing untested/skipped states for ai: null and aiSkipped rows', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F8-Probe-03')
    const { nodeKeys, nodeNames } = await seedNodes(harness, subServer, 'f8-03', [
      'Gamma-Untested',
      'Gamma-WeakConn',
      'Gamma-MissingExit',
    ])
    const [untestedKey, weakKey, missingExitKey] = nodeKeys
    const [untestedName, weakName, missingExitName] = nodeNames

    // Job 1: basicOnlyConfig -> ai: null
    const q1 = await harness.apiPost<QueuedJobResponse>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [untestedKey],
      config: basicOnlyConfig({ rounds: 2 }),
    })
    expect(q1.status).toBe(200)
    expect((await probe.pollAndComplete()).completeResponse?.status).toBe(200)

    // Job 2: basicAndAiConfig with weak latency (>= 4000ms) -> aiSkipped: 'weak_connection'
    const q2 = await harness.apiPost<QueuedJobResponse>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [weakKey],
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(q2.status).toBe(200)
    expect((await probe.pollAndComplete(() => ({ latencyMs: 4500 }))).completeResponse?.status).toBe(200)

    // Job 3: aiOnlyConfig with missing_exit -> aiSkipped: 'missing_exit', exit: null, ai: null, available: false
    const q3 = await harness.apiPost<QueuedJobResponse>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: [missingExitKey],
      config: aiOnlyConfig(),
    })
    expect(q3.status).toBe(200)
    const d3 = await probe.pollAndComplete(() => ({
      aiSkipped: 'missing_exit',
      exit: null,
      ai: null,
      available: false,
    }))
    expect(d3.completeResponse?.status).toBe(200)

    const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)
    expect(latestRes.status).toBe(200)
    const latest = unwrapLatestForDevice(latestRes.data, deviceId)
    expect(latest[untestedKey]?.ai).toBeNull()
    expect(latest[weakKey]?.ai?.aiSkipped).toBe('weak_connection')
    expect(latest[missingExitKey]?.ai?.aiSkipped).toBe('missing_exit')

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

    await openNodesPage(page, harness.baseUrl)
    await expectNoLegacyAiPlatforms(page)
    await expectNoAiPlatformFilterDropdown(page)
    for (const [nodeName, expectedKind] of [
      [untestedName, 'untested'],
      [weakName, 'weak_connection'],
      [missingExitName, 'missing_exit'],
    ] as const) {
      const row = findNodeRow(page, nodeName)
      await expect(row).toBeVisible()
      const text = (await row.textContent()) ?? ''
      expect(text).not.toMatch(/NaN|undefined|null/)
      await expectAiCellUntestedOrSkipped(row, expectedKind)
    }

    await openQualityPage(page, harness.baseUrl, 'reports')
    await expectNoLegacyAiPlatforms(page)
    await expectNoAiPlatformFilterDropdown(page)

    // Inspect missing_exit report and Node Detail
    const jobSelect = page.getByLabel('选择检测任务')
    await jobSelect.selectOption(q3.data.id)
    const missingRow = findNodeRow(page, missingExitName)
    await expectAiCellUntestedOrSkipped(missingRow, 'missing_exit')

    await page.getByRole('button', { name: new RegExp(`查看检测详情\\s+${missingExitName}`) }).click()
    await expect(page.locator('#main-content')).toContainText(/未获取出口|已跳过\s*AI\s*检测/)
    await expectNoLegacyAiPlatforms(page)
    await page.getByRole('button', { name: '返回检测结果' }).click()

    // Inspect weak_connection report and Node Detail
    await jobSelect.selectOption(q2.data.id)
    const weakRow = findNodeRow(page, weakName)
    await expectAiCellUntestedOrSkipped(weakRow, 'weak_connection')

    await page.getByRole('button', { name: new RegExp(`查看检测详情\\s+${weakName}`) }).click()
    await expect(page.locator('#main-content')).toContainText(/丢包过高|延迟过长|已跳过\s*AI\s*检测/)
    await expectNoLegacyAiPlatforms(page)

    collector.assertNoErrors()
  })

  test('T2-F8-04 displays mixed 3-state AI column cleanly across 1440x940, 390x844, and 320x700 with zero overflow', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F8-Probe-04')
    const { nodeKeys, nodeNames } = await seedNodes(harness, subServer, 'f8-04', ['Delta-Mixed'])

    const qRes = await harness.apiPost<QueuedJobResponse>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(qRes.status).toBe(200)

    const done = await probe.pollAndComplete(() => ({
      ai: aiPresets.mixed('US'),
    }))
    expect(done.completeResponse?.status).toBe(200)

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)

    const expected = [
      { surface: 'ChatGPT Web' as const, tone: 'success' as const, label: 'US' },
      { surface: 'ChatGPT APP' as const, tone: 'danger' as const, label: '受限' },
      { surface: 'Gemini Web' as const, tone: 'warning' as const, label: '未知' },
    ]

    for (const viewport of [
      { width: 1440, height: 940 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport)

      await openNodesPage(page, harness.baseUrl)
      await waitForAnimationsToSettle(page)
      await expectNoHorizontalOverflow(page)
      await expectAiUnlockCell(findNodeRow(page, nodeNames[0]), expected)

      await openQualityPage(page, harness.baseUrl, 'reports')
      await waitForAnimationsToSettle(page)
      await expectNoHorizontalOverflow(page)
      await expectAiUnlockCell(findNodeRow(page, nodeNames[0]), expected)
    }

    collector.assertNoErrors()
  })

  test('T2-F8-05 passes WCAG 2.1 AA contrast audit on Node Detail and restores focus to trigger button', async ({ page }) => {
    harness = await startAppHarness()
    subServer = await startMockSubServer()
    const collector = attachErrorCollectors(page)
    const { probe, deviceId } = await pairMockProbe(harness, 'F8-Probe-05')
    const { nodeKeys, nodeNames } = await seedNodes(harness, subServer, 'f8-05', ['Epsilon-Detail'])

    const qRes = await harness.apiPost<QueuedJobResponse>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicAndAiConfig({ rounds: 2 }),
    })
    expect(qRes.status).toBe(200)

    const done = await probe.pollAndComplete(() => ({
      ai: aiPresets.mixed('US'),
    }))
    expect(done.completeResponse?.status).toBe(200)

    await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
    await openQualityPage(page, harness.baseUrl, 'reports')

    const triggerBtn = page.getByRole('button', { name: new RegExp(`查看检测详情\\s+${nodeNames[0]}`) }).first()
    await expect(triggerBtn).toBeVisible()
    await triggerBtn.click()

    const detailHeading = page.locator('#main-content h3').filter({ hasText: nodeNames[0] }).first()
    await expect(detailHeading).toBeVisible()
    await expect(detailHeading).toBeFocused()

    const detailContainer = page.locator('#main-content .quality-detail').or(page.locator('#main-content')).first()
    await expectAiUnlockCell(detailContainer, [
      { surface: 'ChatGPT Web', tone: 'success', label: 'US' },
      { surface: 'ChatGPT APP', tone: 'danger', label: '受限' },
      { surface: 'Gemini Web', tone: 'warning', label: '未知' },
    ])
    await expectNoLegacyAiPlatforms(page)

    await runAxeAudit(page, 'T2-F8-05 Node Detail WCAG 2.1 AA')

    await page.getByRole('button', { name: '返回检测结果' }).click()
    await expect(triggerBtn).toBeVisible()
    await expect(triggerBtn).toBeFocused()

    collector.assertNoErrors()
  })
})
