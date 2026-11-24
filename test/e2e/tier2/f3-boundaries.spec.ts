import assert from 'node:assert/strict'
import { test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  aiOnlyConfig,
  assertThreeSurfaceAi,
  basicAndAiConfig,
  basicOnlyConfig,
  buildDraft,
  buildInfoProxy,
  buildProxyNode,
  buildQualityConfig,
  buildSource,
  type DraftConfig,
  uniqueId,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  aiReading,
  buildAgentReport,
  buildQualityRow,
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
  type QualityConfig,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockProxyNode, type MockSubServer } from '../helpers/mock-sub-server.ts'

interface StatePayload {
  id: string
  revision: number
  draft: DraftConfig
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

interface LatestRecord {
  nodeKey: string
  deviceId: string
  basic: {
    available: boolean
    infoNode: boolean
    error: string | null
  } | null
  speed: {
    speedMbps: number | null
    speedFailed: boolean
  } | null
  ai: {
    results: unknown
    aiSkipped?: string
  } | null
  availability: {
    window: boolean[]
    total: number
    success: number
    rate: number
  } | null
}

const activeCleanups: Array<() => Promise<void>> = []

test.afterEach(async () => {
  while (activeCleanups.length > 0) {
    const fn = activeCleanups.pop()!
    await fn().catch(() => {})
  }
})

async function setupProbeAndNodes(nodes: MockProxyNode[]): Promise<{
  harness: AppHarness
  subServer: MockSubServer
  probe: MockProbeAgent
  deviceId: string
  nodeKeys: string[]
  keyByName: Record<string, string>
}> {
  const harness = await startAppHarness()
  activeCleanups.push(() => harness.close())

  const subServer = await startMockSubServer({
    main: { format: 'yaml', nodes },
  })
  activeCleanups.push(() => subServer.close())

  const stateRes = await harness.apiGet<StatePayload>('/api/state')
  assert.equal(stateRes.status, 200)

  const sourceId = uniqueId('src_')
  const feedUrl = subServer.urlFor('main')
  const probeRes = await harness.apiPost('/api/probe', {
    kind: 'source',
    id: sourceId,
    url: feedUrl,
  })
  assert.equal(probeRes.status, 200)

  const source = buildSource({ id: sourceId, name: 'F3 Source', url: feedUrl })
  const saveRes = await harness.apiPost<StatePayload>('/api/draft', {
    revision: stateRes.data.revision,
    draft: buildDraft({
      ...stateRes.data.draft,
      sources: [source],
    }),
  })
  assert.equal(saveRes.status, 200)

  const savedNodes = saveRes.data.sources[sourceId]?.good?.nodes ?? []
  const nodeKeys = savedNodes.map(n => `${sourceId}/${n.id}`)
  const keyByName = Object.fromEntries(savedNodes.map(n => [n.name, `${sourceId}/${n.id}`]))

  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { origin, profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin, profileId, name: 'F3-Probe' })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<Array<{ id: string }>>('/api/quality/devices')
  assert.equal(devicesRes.status, 200)
  const deviceId = devicesRes.data[0]?.id
  assert.ok(deviceId)

  return { harness, subServer, probe, deviceId, nodeKeys, keyByName }
}

test.describe('F3 Boundaries: Modular Probe Execution & Complete Invariants', () => {
  test('T2-F3-01 rejects { basic: false, ai: false } with 400 and leaves job queue empty', async () => {
    const { harness, deviceId, nodeKeys } = await setupProbeAndNodes([
      buildProxyNode('🇺🇸 US-F3-01'),
    ])

    const queueRes = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: buildQualityConfig({ basic: false, ai: false }),
    })
    assert.equal(queueRes.status, 400)

    const jobsRes = await harness.apiGet<unknown[]>('/api/quality/jobs')
    assert.equal(jobsRes.status, 200)
    assert.equal(jobsRes.data.length, 0)
  })

  test('T2-F3-02 { basic: false, bandwidth: true, ai: true } forces bandwidth false and rejects speed on complete', async () => {
    const { harness, probe, deviceId, nodeKeys } = await setupProbeAndNodes([
      buildProxyNode('🇺🇸 US-F3-02'),
    ])

    const queueRes = await harness.apiPost<{ id: string; config: QualityConfig }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: buildQualityConfig({ basic: false, bandwidth: true, ai: true }),
    })
    assert.equal(queueRes.status, 200)
    assert.equal(queueRes.data.config.basic, false)
    assert.equal(queueRes.data.config.bandwidth, false)
    assert.equal(queueRes.data.config.ai, true)

    const pollRes = await probe.poll({ wait: false })
    assert.equal(pollRes.status, 200)
    assert.ok(pollRes.body && typeof pollRes.body === 'object' && 'jobId' in pollRes.body)
    const assignment = pollRes.body
    assert.equal(assignment.config.basic, false)
    assert.equal(assignment.config.bandwidth, false)

    // Inject non-null speed into AI-only report -> 422
    const invalidReport = buildAgentReport(assignment)
    invalidReport.results[0].speed = {
      bytes: 1024,
      elapsedMs: 1000,
      averageBps: 8192,
      peakBps: 9000,
      perSecondBps: [8192],
      stop: 'bytes',
    }
    const rejectRes = await probe.complete(assignment.jobId, invalidReport)
    assert.equal(rejectRes.status, 422)

    // Clean AI-only report -> 200
    const validReport = buildAgentReport(assignment)
    assert.equal(validReport.results[0]?.speed, null)
    assert.deepEqual(validReport.results[0]?.samples, [])
    const acceptRes = await probe.complete(assignment.jobId, validReport)
    assert.equal(acceptRes.status, 200)

    const latestRes = await harness.apiGet<Record<string, LatestRecord>>(
      `/api/quality/latest?deviceId=${deviceId}`,
    )
    assert.equal(latestRes.status, 200)
    const row = latestRes.data[nodeKeys[0]]
    assert.ok(row)
    assert.equal(row.basic, null)
    assert.equal(row.speed, null)
    assertThreeSurfaceAi(row.ai?.results)
  })

  test('T2-F3-03 rejects out-of-range QualityConfig numeric bounds with 400 and accepts min/max bounds', async () => {
    const { harness, deviceId, nodeKeys } = await setupProbeAndNodes([
      buildProxyNode('🇺🇸 US-F3-03'),
    ])

    const invalidConfigs: Array<Partial<QualityConfig>> = [
      { rounds: 1 },
      { rounds: 9 },
      { rounds: 2.5 },
      { concurrency: 0 },
      { concurrency: 13 },
      { concurrency: 1.5 },
      { speedConcurrency: 0 },
      { speedConcurrency: 3 },
      { speedConcurrency: 1.5 },
      { seconds: 1 },
      { seconds: 16 },
      { seconds: 2.5 },
      { mebibytes: 0 },
      { mebibytes: 33 },
      { mebibytes: 4.5 },
    ]

    for (const override of invalidConfigs) {
      const res = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: nodeKeys,
        config: buildQualityConfig(override),
      })
      assert.equal(res.status, 400, `Expected 400 for invalid config ${JSON.stringify(override)}`)
    }

    const jobsAfterInvalid = await harness.apiGet<unknown[]>('/api/quality/jobs')
    assert.equal(jobsAfterInvalid.status, 200)
    assert.equal(jobsAfterInvalid.data.length, 0)

    // Valid exact min/max boundary values (cancel after each queue to respect probeQueueLimit = 5)
    const validBoundaries = [
      buildQualityConfig({
        basic: true,
        rounds: 2,
        concurrency: 1,
        bandwidth: true,
        speedConcurrency: 1,
        seconds: 2,
        mebibytes: 1,
        ai: true,
      }),
      buildQualityConfig({
        basic: true,
        rounds: 8,
        concurrency: 12,
        bandwidth: true,
        speedConcurrency: 2,
        seconds: 15,
        mebibytes: 32,
        ai: true,
      }),
    ]

    for (const cfg of validBoundaries) {
      const queueRes = await harness.apiPost<{ id: string }>('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: nodeKeys,
        config: cfg,
      })
      assert.equal(queueRes.status, 200)
      const cancelRes = await harness.apiPost('/api/quality/cancel', { id: queueRes.data.id })
      assert.equal(cancelRes.status, 200)
    }
  })

  test('T2-F3-04 validates ai-only samples/available invariants and basic-only sample counts/bounds', async () => {
    const { harness, probe, deviceId, nodeKeys } = await setupProbeAndNodes([
      buildProxyNode('🇭🇰 HK-F3-04', { server: 'hk-f3-04.example.net', port: 10010 }),
    ])

    // Part A: AI-only job invariants
    const qAi = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: aiOnlyConfig(),
    })
    assert.equal(qAi.status, 200)
    const pAi = await probe.poll({ wait: false })
    assert.ok(pAi.body && typeof pAi.body === 'object' && 'jobId' in pAi.body)
    const aiAssign = pAi.body

    // A1: non-empty samples in AI-only -> 422
    const aiWithSamples = buildAgentReport(aiAssign)
    aiWithSamples.results[0].samples = [{ tlsMs: 10, httpsMs: 50 }]
    assert.equal((await probe.complete(aiAssign.jobId, aiWithSamples)).status, 422)

    // A2: available: false with restricted (non-network_error) AI -> 422
    const aiBadFalse = buildAgentReport(aiAssign, () => ({
      available: false,
      exit: null,
      ai: aiPresets.allRestricted('HK'),
    }))
    assert.equal((await probe.complete(aiAssign.jobId, aiBadFalse)).status, 422)

    // A3: available: true with exit: null and all network_error AI -> 422
    const aiBadTrue = buildAgentReport(aiAssign, () => ({
      available: true,
      exit: null,
      ai: {
        chatgptWeb: aiReading.uncertain('network_error'),
        chatgptApp: aiReading.uncertain('network_error'),
        gemini: aiReading.uncertain('network_error'),
      },
    }))
    assert.equal((await probe.complete(aiAssign.jobId, aiBadTrue)).status, 422)

    // A4: valid restricted AI-only with exit: null (omitting available so derived available === true) -> 200
    const aiValidRestricted = buildAgentReport(aiAssign, () => ({
      exit: null,
      ai: aiPresets.allRestricted('HK'),
    }))
    assert.equal(aiValidRestricted.results[0]?.available, true)
    assert.deepEqual(aiValidRestricted.results[0]?.samples, [])
    assert.equal((await probe.complete(aiAssign.jobId, aiValidRestricted)).status, 200)

    // Part B: Basic-only job invariants (rounds = 3)
    const qBasic = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicOnlyConfig({ rounds: 3 }),
    })
    assert.equal(qBasic.status, 200)
    const pBasic = await probe.poll({ wait: false })
    assert.ok(pBasic.body && typeof pBasic.body === 'object' && 'jobId' in pBasic.body)
    const basicAssign = pBasic.body

    // B1: empty samples with error: null -> 422
    const basicEmptySamples = buildAgentReport(basicAssign)
    basicEmptySamples.results[0].samples = []
    assert.equal((await probe.complete(basicAssign.jobId, basicEmptySamples)).status, 422)

    // B2: mismatched sample length (2 vs rounds 3) -> 422
    const basicWrongLen = buildAgentReport(basicAssign)
    basicWrongLen.results[0].samples = [
      { tlsMs: 10, httpsMs: 50, httpStatus: 204 },
      { tlsMs: 11, httpsMs: 52, httpStatus: 204 },
    ]
    assert.equal((await probe.complete(basicAssign.jobId, basicWrongLen)).status, 422)

    // B3: negative sample latency -> 400 (Zod schema)
    const basicNegativeSample = buildAgentReport(basicAssign)
    basicNegativeSample.results[0].samples = [
      { tlsMs: 10, httpsMs: -1, httpStatus: 204 },
      { tlsMs: 10, httpsMs: 50, httpStatus: 204 },
      { tlsMs: 10, httpsMs: 50, httpStatus: 204 },
    ]
    assert.equal((await probe.complete(basicAssign.jobId, basicNegativeSample)).status, 400)

    // B4: valid basic-only report -> 200
    const basicValid = buildAgentReport(basicAssign)
    assert.equal((await probe.complete(basicAssign.jobId, basicValid)).status, 200)
  })

  test('T2-F3-05 handles info_node and invalid_node rows in both basic+ai and ai-only runs', async () => {
    const { harness, probe, deviceId, nodeKeys, keyByName } = await setupProbeAndNodes([
      buildProxyNode('🇺🇸 US-Valid-01', { server: 'us-valid.example.net', port: 10011 }),
      buildInfoProxy('剩余流量：500 GB'),
      buildProxyNode('🇯🇵 JP-BadNode-01', { server: 'jp-bad.example.net', port: 10012 }),
    ])

    const validKey = keyByName['🇺🇸 US-Valid-01']
    const infoKey = keyByName['剩余流量：500 GB']
    const invalidKey = keyByName['🇯🇵 JP-BadNode-01']
    assert.ok(validKey && infoKey && invalidKey)

    // Job 1: basicAndAiConfig
    const q1 = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: basicAndAiConfig(),
    })
    assert.equal(q1.status, 200)
    const p1 = await probe.poll({ wait: false })
    assert.ok(p1.body && typeof p1.body === 'object' && 'jobId' in p1.body)
    const assign1 = p1.body

    const report1 = buildAgentReport(assign1, node => {
      if (node.key === invalidKey) return { error: 'invalid_node' }
      return {}
    })
    assert.equal((await probe.complete(assign1.jobId, report1)).status, 200)

    const latestAfter1 = await harness.apiGet<Record<string, LatestRecord>>(
      `/api/quality/latest?deviceId=${deviceId}`,
    )
    assert.equal(latestAfter1.status, 200)
    assert.equal(latestAfter1.data[validKey]?.availability?.total, 1)
    assert.equal(latestAfter1.data[validKey]?.basic?.available, true)
    assertThreeSurfaceAi(latestAfter1.data[validKey]?.ai?.results)

    assert.equal(latestAfter1.data[infoKey]?.basic?.available, false)
    assert.equal(latestAfter1.data[infoKey]?.basic?.error, 'info_node')
    assert.equal(latestAfter1.data[infoKey]?.basic?.infoNode, true)
    assert.equal(latestAfter1.data[infoKey]?.ai, null)
    assert.equal(latestAfter1.data[infoKey]?.availability, null)

    assert.equal(latestAfter1.data[invalidKey]?.basic?.available, false)
    assert.equal(latestAfter1.data[invalidKey]?.basic?.error, 'invalid_node')
    assert.equal(latestAfter1.data[invalidKey]?.ai, null)
    assert.equal(latestAfter1.data[invalidKey]?.availability, null)

    // Job 2: aiOnlyConfig negative & positive checks for info_node / invalid_node
    const q2 = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: aiOnlyConfig(),
    })
    assert.equal(q2.status, 200)
    const p2 = await probe.poll({ wait: false })
    assert.ok(p2.body && typeof p2.body === 'object' && 'jobId' in p2.body)
    const assign2 = p2.body

    // Negative 1: info_node injecting non-null ai -> 422
    const badInfoAiReport = buildAgentReport(assign2, node => {
      if (node.key === invalidKey) return { error: 'invalid_node' }
      return {}
    })
    const infoRowIndex = badInfoAiReport.results.findIndex(r => r.key === infoKey)
    assert.ok(infoRowIndex >= 0)
    badInfoAiReport.results[infoRowIndex] = {
      ...badInfoAiReport.results[infoRowIndex],
      ai: aiPresets.allGreen('US'),
    }
    assert.equal((await probe.complete(assign2.jobId, badInfoAiReport)).status, 422)

    // Negative 2: invalid_node claiming available: true -> 422
    const badInvalidAvailReport = buildAgentReport(assign2, node => {
      if (node.key === invalidKey) return { error: 'invalid_node' }
      return {}
    })
    const invalidRowIndex = badInvalidAvailReport.results.findIndex(r => r.key === invalidKey)
    assert.ok(invalidRowIndex >= 0)
    badInvalidAvailReport.results[invalidRowIndex] = buildQualityRow(
      assign2.nodes[invalidRowIndex],
      assign2.config,
      { error: 'invalid_node' },
    )
    badInvalidAvailReport.results[invalidRowIndex].available = true
    assert.equal((await probe.complete(assign2.jobId, badInvalidAvailReport)).status, 422)

    // Positive: clean AI-only report -> 200, availability untouched
    const cleanAiReport = buildAgentReport(assign2, node => {
      if (node.key === invalidKey) return { error: 'invalid_node' }
      return {}
    })
    assert.equal((await probe.complete(assign2.jobId, cleanAiReport)).status, 200)

    const latestAfter2 = await harness.apiGet<Record<string, LatestRecord>>(
      `/api/quality/latest?deviceId=${deviceId}`,
    )
    assert.equal(latestAfter2.status, 200)
    assert.equal(latestAfter2.data[validKey]?.availability?.total, 1)
    assert.equal(latestAfter2.data[infoKey]?.ai, null)
    assert.equal(latestAfter2.data[infoKey]?.availability, null)
    assert.equal(latestAfter2.data[invalidKey]?.ai, null)
    assert.equal(latestAfter2.data[invalidKey]?.availability, null)
  })
})
