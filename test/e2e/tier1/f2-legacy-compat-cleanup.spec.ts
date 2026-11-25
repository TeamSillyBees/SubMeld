import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  createMockProbe,
  defaultV4Capabilities,
  parseInviteLink,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'
import {
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  basicAndAiConfig,
  buildDraft,
  buildLegacyPreR1Documents,
  buildProxyNode,
  buildSource,
  uniqueId,
  unwrapLatestForDevice,
} from '../helpers/fixtures.ts'

interface DraftStateResponse {
  id: string
  revision: number
  draft: Record<string, unknown>
  library: { groups: Array<{ groups: Array<{ members: Array<{ quality?: Record<string, unknown> }> }> }> }
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

interface QualityDeviceRecord {
  id: string
  name: string
  status: string
  protocolVersion?: number
  agentVersion?: string
}

interface QualityJobRecord {
  id: string
  status: string
  progress: { stage: string; done: number; total: number }
}

interface QualityReportRecord {
  jobId: string
  results: Array<{ key: string; ai: unknown }>
}

test.describe('Tier 1 — F2: Drop Legacy Agent Compat & Cleanup Stored Data', () => {
  test('T1-F2-01 Protocol v4 (2.0.0) probe executes full enroll/poll/progress/complete lifecycle', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let probe: MockProbeAgent | undefined

    try {
      const nodes = [
        buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10101 }),
        buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10102 }),
      ]
      subServer = await startMockSubServer({ feed1: { format: 'yaml', nodes } })
      harness = await startAppHarness({ useRealCore: false })

      const state0 = await harness.apiGet<DraftStateResponse>('/api/state')
      assert.equal(state0.status, 200)

      const source = buildSource({ id: uniqueId('src_'), name: 'V4 订阅源', url: subServer.urlFor('feed1') })
      const probeSrc = await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })
      assert.equal(probeSrc.status, 200)

      const draftRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({ sources: [source] }),
      })
      assert.equal(draftRes.status, 200)
      const keys = (draftRes.data.sources[source.id]?.good?.nodes ?? []).map(n => `${source.id}/${n.id}`)
      assert.equal(keys.length, 2)

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      assert.equal(inviteRes.status, 200)
      const { profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

      probe = createMockProbe({
        origin: harness.baseUrl,
        profileId,
        name: 'Probe-V4-01',
        capabilities: defaultV4Capabilities(),
      })

      const enrollRes = await probe.enroll(ticket)
      assert.equal(enrollRes.status, 200)
      assert.equal((enrollRes.body as { ok?: boolean }).ok, true)

      const devicesRes = await harness.apiGet<QualityDeviceRecord[]>('/api/quality/devices')
      assert.equal(devicesRes.status, 200)
      const device = devicesRes.data.find(d => d.name === 'Probe-V4-01')
      assert.ok(device)
      assert.equal(device.protocolVersion, 4)
      assert.equal(device.agentVersion, '2.0.0')
      assert.equal(device.status, 'online')

      const queueRes = await harness.apiPost<QualityJobRecord>('/api/quality/queue', {
        targetDeviceId: device.id,
        keys,
        config: basicAndAiConfig(),
      })
      assert.equal(queueRes.status, 200)
      assert.equal(queueRes.data.status, 'waiting')

      const pollRes = await probe.poll({ wait: false })
      assert.equal(pollRes.status, 200)
      assert.ok(pollRes.body && 'jobId' in pollRes.body)
      const assignment = pollRes.body
      assert.equal(assignment.jobId, queueRes.data.id)

      const progressRes = await probe.progress(assignment.jobId, {
        stage: 'latency',
        done: 1,
        total: assignment.nodes.length,
      })
      assert.equal(progressRes.status, 200)

      const runningJobs = await harness.apiGet<QualityJobRecord[]>('/api/quality/jobs')
      assert.equal(runningJobs.status, 200)
      const activeJob = runningJobs.data.find(j => j.id === assignment.jobId)
      assert.equal(activeJob?.status, 'running')
      assert.equal(activeJob?.progress.stage, 'latency')

      const report = {
        schemaVersion: 1 as const,
        jobId: assignment.jobId,
        startedAt: new Date(Date.now() - 300).toISOString(),
        finishedAt: new Date().toISOString(),
        results: assignment.nodes.map(node => ({
          key: node.key,
          available: true,
          error: null,
          samples: [
            { tlsMs: 25, httpsMs: 70, httpStatus: 204 },
            { tlsMs: 26, httpsMs: 72, httpStatus: 204 },
            { tlsMs: 27, httpsMs: 74, httpStatus: 204 },
          ],
          tlsMedianMs: 26,
          httpsMedianMs: 72,
          jitterMs: 2,
          lossRate: 0,
          exit: { ip: '198.51.100.10', region: 'US' },
          speed: null,
          ai: {
            chatgptWeb: { state: 'reachable' as const, evidence: 'compliance_json' as const, httpStatus: 200, needsReview: false, providerRegion: 'US' },
            chatgptApp: { state: 'reachable' as const, evidence: 'app_gateway' as const, httpStatus: 200, needsReview: false, providerRegion: 'US' },
            gemini: { state: 'reachable' as const, evidence: 'web_entry' as const, httpStatus: 200, needsReview: false, providerRegion: 'US' },
            antigravity: { state: 'reachable' as const, evidence: 'web_entry' as const, httpStatus: 200, needsReview: false, providerRegion: 'US' },
          },
        })),
      }
      const completeRes = await probe.complete(assignment.jobId, report)
      assert.equal(completeRes.status, 200)

      const doneJobs = await harness.apiGet<QualityJobRecord[]>('/api/quality/jobs')
      assert.equal(doneJobs.data.find(j => j.id === assignment.jobId)?.status, 'completed')

      const reportRes = await harness.apiGet<QualityReportRecord>(`/api/quality/report?id=${encodeURIComponent(assignment.jobId)}`)
      assert.equal(reportRes.status, 200)
      assert.equal(reportRes.data.results.length, 2)

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(device.id)}`)
      assert.equal(latestRes.status, 200)
      const latestMap = unwrapLatestForDevice(latestRes.data, device.id)
      for (const key of keys) {
        assert.ok(latestMap[key]?.basic?.available)
        assertThreeSurfaceAi(latestMap[key]?.ai?.results)
      }
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F2-02 Startup cleanup purges Grok and Claude from quality-reports/*', async () => {
    let harness: AppHarness | undefined
    const profileId = 'default'
    const reportId = randomUUID()

    try {
      harness = await startAppHarness({
        useRealCore: false,
        seedLegacy: (seeder) => {
          seeder.seedEntries(buildLegacyPreR1Documents(profileId, { reportId }))
        },
      })

      const dbReport = harness.readDbDoc<QualityReportRecord>(`quality-reports/${profileId}`, reportId)
      assert.ok(dbReport)
      assertNoLegacyAiStrings(dbReport)
      assertThreeSurfaceAi(dbReport.results[0]?.ai)

      const apiReport = await harness.apiGet<QualityReportRecord>(`/api/quality/report?id=${encodeURIComponent(reportId)}`)
      assert.equal(apiReport.status, 200)
      assertNoLegacyAiStrings(apiReport.data)
      assertThreeSurfaceAi(apiReport.data.results[0]?.ai)
    } finally {
      await harness?.close()
    }
  })

  test('T1-F2-03 Startup cleanup strips qualityBaselinePolicy, fixedQualitySnapshot, qualitySnapshot, qualityReportId & legacy registration keys', async () => {
    let harness: AppHarness | undefined
    const profileId = 'default'
    const reportId = randomUUID()

    try {
      harness = await startAppHarness({
        useRealCore: false,
        seedLegacy: (seeder) => {
          seeder.seedEntries(buildLegacyPreR1Documents(profileId, { reportId }))
        },
      })

      const profileDoc = harness.readDbDoc<Record<string, unknown>>('profiles', profileId)
      assert.ok(profileDoc)
      assert.equal(Object.hasOwn(profileDoc, 'fixedQualitySnapshot'), false)
      const draftDoc = profileDoc.draft as Record<string, unknown>
      assert.equal(Object.hasOwn(draftDoc, 'qualityBaselinePolicy'), false)
      assertNoLegacyAiStrings(profileDoc)

      const versionDoc = harness.readDbDoc<Record<string, unknown>>(`versions/${profileId}`, '000000000001')
      assert.ok(versionDoc)
      assert.equal(Object.hasOwn(versionDoc, 'qualitySnapshot'), false)
      assert.equal(Object.hasOwn(versionDoc, 'qualityReportId'), false)
      assert.equal(Object.hasOwn(versionDoc, 'qualityDeviceId'), false)
      const recipeDoc = versionDoc.recipe as Record<string, unknown>
      assert.equal(Object.hasOwn(recipeDoc, 'qualityBaselinePolicy'), false)
      assertNoLegacyAiStrings(versionDoc)

      assert.equal(harness.readDbDoc(`quality-device/${profileId}`, 'registration'), undefined)
      assert.equal(harness.readDbDoc(`quality-device/${profileId}`, 'next'), undefined)

      const stateRes = await harness.apiGet<DraftStateResponse>('/api/state')
      assert.equal(stateRes.status, 200)
      assert.equal(Object.hasOwn(stateRes.data.draft, 'qualityBaselinePolicy'), false)
      assertNoLegacyAiStrings(stateRes.data.draft)
    } finally {
      await harness?.close()
    }
  })

  test('T1-F2-04 Startup cleanup strips legacy AI filters & sorts from system/library templates', async () => {
    let harness: AppHarness | undefined
    const profileId = 'default'

    try {
      harness = await startAppHarness({
        useRealCore: false,
        seedLegacy: (seeder) => {
          seeder.seedEntries(buildLegacyPreR1Documents(profileId))
        },
      })

      const libraryDoc = harness.readDbDoc<Record<string, unknown>>('system', 'library')
      assert.ok(libraryDoc)
      assertNoLegacyAiStrings(libraryDoc)

      const stateRes = await harness.apiGet<DraftStateResponse>('/api/state')
      assert.equal(stateRes.status, 200)
      assertNoLegacyAiStrings(stateRes.data.library)
      const templateQuality = stateRes.data.library.groups[0]?.groups[0]?.members[0]?.quality
      assert.ok(templateQuality)
      assert.equal(Object.hasOwn(templateQuality, 'aiPlatforms'), false)
      assert.equal(Object.hasOwn(templateQuality, 'platforms'), false)
      assert.equal(Object.hasOwn(templateQuality, 'sortBy'), false)
    } finally {
      await harness?.close()
    }
  })

  test('T1-F2-05 Startup cleanup is idempotent across restarts', async () => {
    let harness1: AppHarness | undefined
    let harness2: AppHarness | undefined
    const profileId = 'default'
    const reportId = randomUUID()
    const deviceId = randomUUID()

    try {
      harness1 = await startAppHarness({
        useRealCore: false,
        seedLegacy: (seeder) => {
          seeder.seedEntries(buildLegacyPreR1Documents(profileId, { reportId, deviceId }))
        },
      })

      const spacesToSnapshot = [
        'profiles',
        `versions/${profileId}`,
        `quality-reports/${profileId}`,
        `quality-jobs/${profileId}`,
        `quality-devices/${profileId}`,
        `quality-device/${profileId}`,
        'system',
      ] as const

      const firstPassSnapshot: Record<string, Array<{ key: string; data: unknown }>> = {}
      const seedEntries: Array<readonly [string, string, unknown]> = []
      for (const space of spacesToSnapshot) {
        const docs = harness1.listDbSpace(space)
        firstPassSnapshot[space] = docs
        for (const row of docs) {
          seedEntries.push([space, row.key, row.data])
        }
      }

      await harness1.close()
      harness1 = undefined

      harness2 = await startAppHarness({
        useRealCore: false,
        seedLegacy: (seeder) => {
          seeder.seedEntries(seedEntries)
        },
      })

      for (const space of spacesToSnapshot) {
        assert.deepEqual(harness2.listDbSpace(space), firstPassSnapshot[space])
      }

      const stateRes = await harness2.apiGet<DraftStateResponse>('/api/state')
      assert.equal(stateRes.status, 200)
      assertNoLegacyAiStrings(stateRes.data.draft)

      const reportRes = await harness2.apiGet<QualityReportRecord>(`/api/quality/report?id=${encodeURIComponent(reportId)}`)
      assert.equal(reportRes.status, 200)
      assertThreeSurfaceAi(reportRes.data.results[0]?.ai)
    } finally {
      await harness1?.close()
      await harness2?.close()
    }
  })
})
