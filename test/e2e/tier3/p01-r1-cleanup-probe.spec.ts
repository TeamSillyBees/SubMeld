import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  aiPresets,
  buildAgentReport,
  createMockProbe,
  defaultV4Capabilities,
  legacyV2Capabilities,
  legacyV3Capabilities,
  parseInviteLink,
  type QualityNode,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  aiOnlyConfig,
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  basicOnlyConfig,
  buildDraft,
  buildInfoProxy,
  buildLegacyPreR1Documents,
  buildProxyNode,
  buildSource,
  uniqueId,
  unwrapLatestForDevice,
  type LatestNodeQuality,
} from '../helpers/fixtures.ts'

interface SourceNodesResponse {
  good: {
    nodes: Array<{ id: string; name: string }>
  } | null
}

interface QualityDeviceSummary {
  id: string
  name: string
  protocolVersion?: number
  agentVersion?: string
  status: string
}

interface QualityJobResponse {
  id: string
  status: string
  targetDeviceId: string | null
  total: number
}

interface QualityReportResponse {
  jobId: string
  config: {
    basic?: boolean
    ai: boolean
    bandwidth: boolean
  }
  results: Array<{
    key: string
    name: string
    available: boolean
    error: string | null
    samples: Array<{ tlsMs: number | null; httpsMs: number | null }>
    httpsMedianMs: number | null
    speed: unknown
    ai: unknown
  }>
}

async function seedSourceAndGetKeys(
  harness: AppHarness,
  subServer: MockSubServer,
  feedId: string,
  sourceId: string,
): Promise<string[]> {
  const source = buildSource({
    id: sourceId,
    name: 'P01 测试订阅',
    url: subServer.urlFor(feedId),
  })
  const stateRes = await harness.apiGet<{ revision: number; draft: ReturnType<typeof buildDraft> }>('/api/state')
  expect(stateRes.ok).toBe(true)

  const probeRes = await harness.apiPost('/api/probe', {
    kind: 'source',
    id: source.id,
    url: source.url,
  })
  expect(probeRes.ok).toBe(true)

  const draftRes = await harness.apiPost('/api/draft', {
    revision: stateRes.data.revision,
    draft: buildDraft({
      ...stateRes.data.draft,
      sources: [source],
    }),
  })
  expect(draftRes.ok).toBe(true)

  const nodesRes = await harness.apiGet<SourceNodesResponse>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
  expect(nodesRes.ok).toBe(true)
  const nodes = nodesRes.data.good?.nodes ?? []
  expect(nodes.length).toBeGreaterThan(0)
  return nodes.map(node => `${source.id}/${node.id}`)
}

test.describe('T3-P01 R1 Cleanup, Legacy Probe Rejection & Modular Probe Execution (F1, F2, F3)', () => {
  test('T3-P01-01 (F1,F2): startup cleanup purges Grok/Claude & legacy registration docs across SQLite and API', async () => {
    let harness: AppHarness | undefined
    const profileId = uniqueId('prof_')
    const sourceId = uniqueId('src_')
    const nodeId = uniqueId('nod_')
    const groupId = uniqueId('grp_')
    const reportId = randomUUID()
    const legacyDeviceId = randomUUID()

    try {
      harness = await startAppHarness({
        seedLegacy: seeder => {
          seeder.seedEntries(
            buildLegacyPreR1Documents(profileId, {
              sourceId,
              nodeId,
              nodeKey: `${sourceId}/${nodeId}`,
              groupId,
              reportId,
              deviceId: legacyDeviceId,
            }),
          )
        },
      })

      // API: cleaned report returns only the 3 kept AI surfaces without Grok/Claude
      const reportRes = await harness.apiGet<QualityReportResponse>(
        `/api/quality/report?id=${encodeURIComponent(reportId)}`,
        { profile: profileId },
      )
      expect(reportRes.status).toBe(200)
      assertNoLegacyAiStrings(reportRes.data)
      expect(reportRes.data.results).toHaveLength(1)
      assertThreeSurfaceAi(reportRes.data.results[0].ai)

      // API: workspace state draft has zero legacy Grok/Claude or baseline policy remnants
      const stateRes = await harness.apiGet<Record<string, unknown>>('/api/state', { profile: profileId })
      expect(stateRes.status).toBe(200)
      assertNoLegacyAiStrings(stateRes.data)
      expect('qualityBaselinePolicy' in ((stateRes.data.draft as Record<string, unknown>) ?? {})).toBe(false)

      // SQLite: legacy quality-device registration/next keys removed; stored docs stripped of Grok/Claude
      expect(harness.readDbDoc(`quality-device/${profileId}`, 'registration')).toBeUndefined()
      expect(harness.readDbDoc(`quality-device/${profileId}`, 'next')).toBeUndefined()

      const storedProfile = harness.readDbDoc<Record<string, unknown>>('profiles', profileId)
      expect(storedProfile).toBeDefined()
      assertNoLegacyAiStrings(storedProfile)
      expect(Object.hasOwn(storedProfile!, 'fixedQualitySnapshot')).toBe(false)

      const storedVersion = harness.readDbDoc<Record<string, unknown>>(`versions/${profileId}`, '000000000001')
      expect(storedVersion).toBeDefined()
      assertNoLegacyAiStrings(storedVersion)
      expect(Object.hasOwn(storedVersion!, 'qualityReportId')).toBe(false)
      expect(Object.hasOwn(storedVersion!, 'qualitySnapshot')).toBe(false)

      const storedLibrary = harness.readDbDoc('system', 'library')
      assertNoLegacyAiStrings(storedLibrary)

      const storedReports = harness.listDbSpace(`quality-reports/${profileId}`)
      expect(storedReports.length).toBeGreaterThanOrEqual(1)
      for (const entry of storedReports) {
        assertNoLegacyAiStrings(entry.data)
      }
    } finally {
      await harness?.close()
    }
  })

  test('T3-P01-02 (F2,F3): rejects v2 (1.3.0) and v3 (1.3.1) probes at dispatch/poll while v4 (2.0.0) runs modular basic & ai jobs', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      subServer = await startMockSubServer({
        main: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-01', { server: 'us-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-01', { server: 'jp-01.example.net', port: 10002 }),
            buildInfoProxy('剩余流量：500 GB'),
          ],
        },
      })
      harness = await startAppHarness()

      const sourceId = uniqueId('src_')
      const keys = await seedSourceAndGetKeys(harness, subServer, 'main', sourceId)
      expect(keys).toHaveLength(3)

      // Enroll legacy v2 (1.3.0) and legacy v3 (1.3.1) probes
      const inviteV2 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(inviteV2.status).toBe(200)
      const parsedV2 = parseInviteLink(inviteV2.data.pairing)
      const probeV2 = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsedV2.profileId,
        name: 'Legacy-V2-Probe',
        capabilities: legacyV2Capabilities(),
      })
      const enrollV2 = await probeV2.enroll(parsedV2.ticket)
      expect(enrollV2.status).toBe(200)

      const inviteV3 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(inviteV3.status).toBe(200)
      const parsedV3 = parseInviteLink(inviteV3.data.pairing)
      const probeV3 = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsedV3.profileId,
        name: 'Legacy-V3-Probe',
        capabilities: legacyV3Capabilities(),
      })
      const enrollV3 = await probeV3.enroll(parsedV3.ticket)
      expect(enrollV3.status).toBe(200)

      const devicesBeforeV4 = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices')
      expect(devicesBeforeV4.status).toBe(200)
      const deviceV2 = devicesBeforeV4.data.find(d => d.name === 'Legacy-V2-Probe')
      const deviceV3 = devicesBeforeV4.data.find(d => d.name === 'Legacy-V3-Probe')
      assert.ok(deviceV2, 'Expected v2 probe in devices list')
      assert.ok(deviceV3, 'Expected v3 probe in devices list')

      // Legacy probes rejected with 409 on queue and poll returns null
      const queueV2 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceV2.id,
        keys,
        config: basicOnlyConfig(),
      })
      expect(queueV2.status).toBe(409)
      const pollV2 = await probeV2.poll({ wait: false })
      expect(pollV2.status).toBe(200)
      expect(pollV2.body).toBeNull()

      const queueV3 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceV3.id,
        keys,
        config: aiOnlyConfig(),
      })
      expect(queueV3.status).toBe(409)
      const pollV3 = await probeV3.poll({ wait: false })
      expect(pollV3.status).toBe(200)
      expect(pollV3.body).toBeNull()

      // Enroll Protocol v4 (2.0.0) probe and execute modular AI-only and Basic-only jobs
      const inviteV4 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(inviteV4.status).toBe(200)
      const parsedV4 = parseInviteLink(inviteV4.data.pairing)
      const probeV4 = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsedV4.profileId,
        name: 'Modern-V4-Probe',
        capabilities: defaultV4Capabilities(),
      })
      const enrollV4 = await probeV4.enroll(parsedV4.ticket)
      expect(enrollV4.status).toBe(200)

      const devicesAfterV4 = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices')
      const deviceV4 = devicesAfterV4.data.find(d => d.name === 'Modern-V4-Probe')
      assert.ok(deviceV4, 'Expected v4 probe in devices list')
      expect(deviceV4.protocolVersion).toBe(4)
      expect(deviceV4.agentVersion).toBe('2.0.0')

      const queueAi = await harness.apiPost<QualityJobResponse>('/api/quality/queue', {
        targetDeviceId: deviceV4.id,
        keys,
        config: aiOnlyConfig(),
      })
      expect(queueAi.status).toBe(200)

      const aiRun = await probeV4.pollAndComplete((node: QualityNode) => {
        if (node.name.includes('US-01')) return { ai: aiPresets.allGreen('US') }
        return { exit: null, ai: aiPresets.mixed('JP') }
      })
      expect(aiRun.assignment?.config.basic).toBe(false)
      expect(aiRun.assignment?.config.ai).toBe(true)
      expect(aiRun.completeResponse?.status).toBe(200)

      const queueBasic = await harness.apiPost<QualityJobResponse>('/api/quality/queue', {
        targetDeviceId: deviceV4.id,
        keys,
        config: basicOnlyConfig({ rounds: 3 }),
      })
      expect(queueBasic.status).toBe(200)

      const basicRun = await probeV4.pollAndComplete(() => ({ latencyMs: 62 }))
      expect(basicRun.assignment?.config.basic).toBe(true)
      expect(basicRun.assignment?.config.ai).toBe(false)
      expect(basicRun.completeResponse?.status).toBe(200)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T3-P01-03 (F1,F3): aiOnly & basicOnly jobs enforce 3-surface AI output and reject legacy grok/claude keys', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      subServer = await startMockSubServer({
        main: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-Alpha', { server: 'us-alpha.example.net', port: 10001 }),
            buildProxyNode('🇭🇰 HK-Beta', { server: 'hk-beta.example.net', port: 10002 }),
            buildInfoProxy('到期时间：2027-01-01'),
          ],
        },
      })
      harness = await startAppHarness()

      const sourceId = uniqueId('src_')
      const keys = await seedSourceAndGetKeys(harness, subServer, 'main', sourceId)

      const invite = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      expect(invite.status).toBe(200)
      const parsed = parseInviteLink(invite.data.pairing)
      const probe = createMockProbe({
        origin: harness.baseUrl,
        profileId: parsed.profileId,
        name: 'Modular-V4-Probe',
      })
      expect((await probe.enroll(parsed.ticket)).status).toBe(200)

      const devicesRes = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices')
      const device = devicesRes.data.find(d => d.name === 'Modular-V4-Probe')
      assert.ok(device)

      // Queue AI-only job and verify legacy surfaces (grok/claudeWeb) in complete payload are rejected
      const aiQueueRes = await harness.apiPost<QualityJobResponse>('/api/quality/queue', {
        targetDeviceId: device.id,
        keys,
        config: aiOnlyConfig(),
      })
      expect(aiQueueRes.status).toBe(200)
      const aiJobId = aiQueueRes.data.id

      const pollAi = await probe.poll({ wait: false })
      expect(pollAi.status).toBe(200)
      assert.ok(pollAi.body && 'jobId' in pollAi.body, 'Expected AI-only assignment')
      const assignment = pollAi.body

      const validReport = buildAgentReport(assignment, node => {
        if (node.name.includes('US-Alpha')) {
          return { exit: { ip: '198.51.100.21', region: 'US' }, ai: aiPresets.mixed('US') }
        }
        if (node.name.includes('HK-Beta')) {
          return { exit: null, ai: aiPresets.allRestricted('HK') }
        }
        return {}
      })

      // Inject legacy grok surface and assert server rejects it
      const pollutedReport = structuredClone(validReport) as unknown as {
        results: Array<{ ai: Record<string, unknown> | null }>
      }
      if (pollutedReport.results[0].ai) {
        pollutedReport.results[0].ai.grok = {
          state: 'reachable',
          evidence: 'web_entry',
          httpStatus: 200,
          needsReview: false,
          providerRegion: 'US',
        }
      }
      const rejectedRes = await probe.complete(
        assignment.jobId,
        pollutedReport as unknown as typeof validReport,
      )
      expect(rejectedRes.ok).toBe(false)
      expect([400, 422]).toContain(rejectedRes.status)

      // Submit valid 3-surface AI-only report
      const acceptedRes = await probe.complete(assignment.jobId, validReport)
      expect(acceptedRes.status).toBe(200)

      const aiReportRes = await harness.apiGet<QualityReportResponse>(
        `/api/quality/report?id=${encodeURIComponent(aiJobId)}`,
      )
      expect(aiReportRes.status).toBe(200)
      assertNoLegacyAiStrings(aiReportRes.data)
      expect(aiReportRes.data.config.basic).toBe(false)
      expect(aiReportRes.data.config.ai).toBe(true)

      const usAiRow = aiReportRes.data.results.find(r => r.name.includes('US-Alpha'))
      const hkAiRow = aiReportRes.data.results.find(r => r.name.includes('HK-Beta'))
      const infoAiRow = aiReportRes.data.results.find(r => r.name.includes('到期时间'))
      assert.ok(usAiRow && hkAiRow && infoAiRow)
      expect(usAiRow.samples).toEqual([])
      expect(usAiRow.httpsMedianMs).toBeNull()
      expect(usAiRow.speed).toBeNull()
      assertThreeSurfaceAi(usAiRow.ai)
      assertThreeSurfaceAi(hkAiRow.ai)
      expect(hkAiRow.available).toBe(true)
      expect(infoAiRow.error).toBe('info_node')
      expect(infoAiRow.ai).toBeNull()

      const latestAfterAi = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(device.id)}`,
      )
      expect(latestAfterAi.status).toBe(200)
      assertNoLegacyAiStrings(latestAfterAi.data)
      const unwrappedAfterAi = unwrapLatestForDevice(latestAfterAi.data, device.id)
      assertThreeSurfaceAi(unwrappedAfterAi[usAiRow.key]?.ai?.results)
      expect(unwrappedAfterAi[usAiRow.key]?.basic).toBeNull()

      // Queue Basic-only job on a fresh check and verify AI is omitted (null) in report
      const basicQueueRes = await harness.apiPost<QualityJobResponse>('/api/quality/queue', {
        targetDeviceId: device.id,
        keys,
        config: basicOnlyConfig({ rounds: 2 }),
      })
      expect(basicQueueRes.status).toBe(200)
      const basicRun = await probe.pollAndComplete(() => ({ latencyMs: 55 }))
      expect(basicRun.completeResponse?.status).toBe(200)

      const basicReportRes = await harness.apiGet<QualityReportResponse>(
        `/api/quality/report?id=${encodeURIComponent(basicQueueRes.data.id)}`,
      )
      expect(basicReportRes.status).toBe(200)
      assertNoLegacyAiStrings(basicReportRes.data)
      expect(basicReportRes.data.config.basic).toBe(true)
      expect(basicReportRes.data.config.ai).toBe(false)
      for (const row of basicReportRes.data.results) {
        expect(row.ai).toBeNull()
      }
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
