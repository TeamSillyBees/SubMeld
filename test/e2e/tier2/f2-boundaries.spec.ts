import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  buildDraft,
  buildLegacyPreR1Documents,
  buildProxyNode,
  buildQualityConfig,
  buildSource,
  type DraftConfig,
  uniqueId,
} from '../helpers/fixtures.ts'
import {
  aiReading,
  createMockProbe,
  defaultV4Capabilities,
  legacyV2Capabilities,
  legacyV3Capabilities,
  parseInviteLink,
  type MockProbeAgent,
  type ProbeCapabilities,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockProxyNode, type MockSubServer } from '../helpers/mock-sub-server.ts'

interface StatePayload {
  id: string
  revision: number
  draft: DraftConfig
  library: unknown
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

interface DeviceInfo {
  id: string
  name: string
  protocolVersion?: number
  agentVersion?: string
  status: string
  waiting: number
}

const activeCleanups: Array<() => Promise<void>> = []

test.afterEach(async () => {
  while (activeCleanups.length > 0) {
    const fn = activeCleanups.pop()!
    await fn().catch(() => {})
  }
})

async function setupHarnessWithNode(nodes: MockProxyNode[] = [buildProxyNode('🇺🇸 US-Compat-01')]): Promise<{
  harness: AppHarness
  subServer: MockSubServer
  sourceId: string
  nodeKeys: string[]
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

  const source = buildSource({ id: sourceId, name: 'F2 Source', url: feedUrl })
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

  return { harness, subServer, sourceId, nodeKeys }
}

async function pairProbe(
  harness: AppHarness,
  name: string,
  capabilities: ProbeCapabilities,
): Promise<{ probe: MockProbeAgent; deviceId: string }> {
  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { origin, profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin, profileId, name, capabilities })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<DeviceInfo[]>('/api/quality/devices')
  assert.equal(devicesRes.status, 200)
  const matched = devicesRes.data.find(d => d.name === name)
  assert.ok(matched, `Expected enrolled device "${name}" in /api/quality/devices`)
  return { probe, deviceId: matched.id }
}

test.describe('F2 Boundaries: Legacy Compat Drop & Startup Data Cleanup', () => {
  test('T2-F2-01 rejects v2 / 1.3.0 probe dispatch and malformed capabilities', async () => {
    const { harness, nodeKeys } = await setupHarnessWithNode()

    // Malformed capabilities syntax rejected at enroll (400)
    const badInviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
    assert.equal(badInviteRes.status, 200)
    const badInvite = parseInviteLink(badInviteRes.data.pairing)

    const invalidProtoProbe = createMockProbe({
      origin: badInvite.origin,
      profileId: badInvite.profileId,
      name: 'Invalid-Proto-0',
      capabilities: defaultV4Capabilities({ protocolVersion: 0 }),
    })
    assert.equal((await invalidProtoProbe.enroll(badInvite.ticket)).status, 400)

    const invalidVerProbe = createMockProbe({
      origin: badInvite.origin,
      profileId: badInvite.profileId,
      name: 'Invalid-Ver',
      capabilities: defaultV4Capabilities({ agentVersion: '1.3' }),
    })
    assert.equal((await invalidVerProbe.enroll(badInvite.ticket)).status, 400)

    // Valid v2 (1.3.0) enrolls cleanly, but dispatch rejects with 409 and poll returns null
    const { probe: v2Probe, deviceId } = await pairProbe(harness, 'Legacy-v2', legacyV2Capabilities())

    const devicesRes = await harness.apiGet<DeviceInfo[]>('/api/quality/devices')
    assert.equal(devicesRes.status, 200)
    const dev = devicesRes.data.find(d => d.id === deviceId)
    assert.equal(dev?.protocolVersion, 2)
    assert.equal(dev?.agentVersion, '1.3.0')

    const queueRes = await harness.apiPost<{ message: string }>('/api/quality/queue', {
      targetDeviceId: deviceId,
      keys: nodeKeys,
      config: buildQualityConfig(),
    })
    assert.equal(queueRes.status, 409)
    assert.match(queueRes.data.message, /2\.0\.0/)

    const pollRes = await v2Probe.poll({ wait: false })
    assert.equal(pollRes.status, 200)
    assert.equal(pollRes.body, null)

    const jobsRes = await harness.apiGet<unknown[]>('/api/quality/jobs')
    assert.equal(jobsRes.status, 200)
    assert.equal(jobsRes.data.length, 0)
  })

  test('T2-F2-02 rejects v3 / 1.3.1 and below-2.0.0 probes while accepting protocol v4 2.0.0', async () => {
    const { harness, nodeKeys } = await setupHarnessWithNode()

    const incompatibleSpecs: Array<{ label: string; caps: ProbeCapabilities }> = [
      { label: 'Legacy-v3-1.3.1', caps: legacyV3Capabilities() },
      { label: 'V4-1.9.9', caps: defaultV4Capabilities({ protocolVersion: 4, agentVersion: '1.9.9' }) },
      { label: 'V3-2.0.0', caps: defaultV4Capabilities({ protocolVersion: 3, agentVersion: '2.0.0' }) },
    ]

    for (const spec of incompatibleSpecs) {
      const { probe, deviceId } = await pairProbe(harness, spec.label, spec.caps)
      const queueRes = await harness.apiPost<{ message: string }>('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: nodeKeys,
        config: buildQualityConfig(),
      })
      assert.equal(queueRes.status, 409, `Expected 409 for ${spec.label}`)

      const pollRes = await probe.poll({ wait: false })
      assert.equal(pollRes.status, 200)
      assert.equal(pollRes.body, null)
    }

    // Dynamic downgrade on poll also blocks dispatch
    const { probe: v4Probe, deviceId: v4Id } = await pairProbe(harness, 'V4-2.0.0', defaultV4Capabilities())
    const downgradePoll = await v4Probe.poll({ wait: false, capabilities: legacyV3Capabilities() })
    assert.equal(downgradePoll.status, 200)
    assert.equal(downgradePoll.body, null)

    const downgradedQueue = await harness.apiPost('/api/quality/queue', {
      targetDeviceId: v4Id,
      keys: nodeKeys,
      config: buildQualityConfig(),
    })
    assert.equal(downgradedQueue.status, 409)

    // Restore v4 2.0.0 capability via poll -> dispatch & claim succeed
    const restorePoll = await v4Probe.poll({ wait: false, capabilities: defaultV4Capabilities() })
    assert.equal(restorePoll.status, 200)

    const validQueue = await harness.apiPost<{ id: string }>('/api/quality/queue', {
      targetDeviceId: v4Id,
      keys: nodeKeys,
      config: buildQualityConfig(),
    })
    assert.equal(validQueue.status, 200)

    const claimPoll = await v4Probe.poll({ wait: false })
    assert.equal(claimPoll.status, 200)
    assert.ok(claimPoll.body && typeof claimPoll.body === 'object' && 'jobId' in claimPoll.body)
    assert.equal(claimPoll.body.jobId, validQueue.data.id)
  })

  test('T2-F2-03 legacy quality-device/registration and obsolete agent actions return 404/410', async () => {
    const { harness, nodeKeys } = await setupHarnessWithNode()
    const { probe } = await pairProbe(harness, 'V4-For-Route-Check', defaultV4Capabilities())
    assert.ok(nodeKeys.length > 0)

    const getReg = await harness.apiGet('/api/quality-device/registration')
    assert.ok([404, 410].includes(getReg.status), `Expected 404/410, got ${getReg.status}`)

    const postReg = await harness.apiPost('/api/quality-device/registration', {})
    assert.ok([404, 410].includes(postReg.status), `Expected 404/410, got ${postReg.status}`)

    const getNext = await harness.apiGet('/api/quality-device/next')
    assert.ok([404, 410].includes(getNext.status))

    const postNext = await harness.apiPost('/api/quality-device/next', {})
    assert.ok([404, 410].includes(postNext.status))

    const unauthGet = await harness.apiGet('/api/quality-device/registration', { cookie: null })
    assert.equal(unauthGet.status, 401)

    // Unknown agent action with valid Bearer token
    const agentRegRes = await fetch(`${probe.origin}/api/quality/agent/registration`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${probe.secret}`,
      },
      body: JSON.stringify({ profileId: probe.profileId, jobId: randomUUID() }),
    })
    assert.equal(agentRegRes.status, 404)
  })

  test('T2-F2-04 malformed and partial legacy quality-reports cleanup safety on boot', async () => {
    const profileId = uniqueId('prof_')
    const sourceId = uniqueId('src_')
    const nodeId = uniqueId('nod_')
    const nodeKey = `${sourceId}/${nodeId}`
    const cleanReportId = randomUUID()
    const deviceId = randomUUID()
    const corruptDocId = randomUUID()
    const nonArrayResultsId = randomUUID()
    const partialRowsId = randomUUID()

    const harness = await startAppHarness({
      seedLegacy: seeder => {
        seeder.seedEntries(
          buildLegacyPreR1Documents(profileId, {
            sourceId,
            nodeId,
            nodeKey,
            reportId: cleanReportId,
            deviceId,
          }),
        )
        seeder.put(`quality-device/${profileId}`, 'invite', {
          ticketHash: 'preserved-ticket-hash',
          expiresAt: '2099-01-01T00:00:00.000Z',
        })
        seeder.put(`quality-reports/${profileId}`, corruptDocId, 'corrupted-non-object-report')
        seeder.put(`quality-reports/${profileId}`, nonArrayResultsId, {
          schemaVersion: 1,
          jobId: nonArrayResultsId,
          results: null,
        })
        seeder.put(`quality-reports/${profileId}`, partialRowsId, {
          schemaVersion: 1,
          jobId: partialRowsId,
          createdAt: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:00.000Z',
          config: { rounds: 3, concurrency: 6, bandwidth: false, speedConcurrency: 1, seconds: 5, mebibytes: 4, ai: true },
          results: [
            'bad-non-object-row',
            {
              key: nodeKey,
              ai: {
                grok: aiReading.restricted('region_restricted', 'HK'),
              },
            },
            {
              key: `${sourceId}/${uniqueId('nod_')}`,
              ai: {
                chatgptWeb: aiReading.green('US', 'chatgptWeb'),
                claudeApi: aiReading.green('US', 'chatgptWeb'),
              },
            },
            {
              key: `${sourceId}/${uniqueId('nod_')}`,
              ai: null,
            },
          ],
        })
      },
    })
    activeCleanups.push(() => harness.close())

    const stateRes = await harness.apiGet<StatePayload>(`/api/state?profile=${profileId}`)
    assert.equal(stateRes.status, 200)
    assertNoLegacyAiStrings(stateRes.data.draft)
    assertNoLegacyAiStrings(stateRes.data.library)

    // Obsolete quality-device keys removed, active invite preserved
    assert.equal(harness.readDbDoc(`quality-device/${profileId}`, 'registration'), undefined)
    assert.equal(harness.readDbDoc(`quality-device/${profileId}`, 'next'), undefined)
    assert.ok(harness.readDbDoc(`quality-device/${profileId}`, 'invite'))

    // Malformed reports survived safely without crashing; partial rows scrubbed
    assert.equal(harness.readDbDoc(`quality-reports/${profileId}`, corruptDocId), 'corrupted-non-object-report')
    assert.deepEqual(
      harness.readDbDoc<{ results: unknown }>(`quality-reports/${profileId}`, nonArrayResultsId)?.results,
      null,
    )

    const scrubbedPartial = harness.readDbDoc<{
      results: Array<string | { ai: Record<string, unknown> | null }>
    }>(`quality-reports/${profileId}`, partialRowsId)
    assert.ok(scrubbedPartial)
    assert.equal(scrubbedPartial.results[0], 'bad-non-object-row')
    assert.equal((scrubbedPartial.results[1] as { ai: unknown }).ai, null)
    assert.deepEqual(Object.keys((scrubbedPartial.results[2] as { ai: Record<string, unknown> }).ai).sort(), ['antigravity', 'chatgptApp', 'chatgptWeb', 'gemini'])
    assert.equal((scrubbedPartial.results[3] as { ai: unknown }).ai, null)
    assertNoLegacyAiStrings(scrubbedPartial)

    // Pre-R1 report accessible via API with only 3 surfaces
    const reportRes = await harness.apiGet<{ results: Array<{ ai: unknown }> }>(
      `/api/quality/report?id=${cleanReportId}`,
      { profile: profileId },
    )
    assert.equal(reportRes.status, 200)
    assertThreeSurfaceAi(reportRes.data.results[0]?.ai)
    assertNoLegacyAiStrings(reportRes.data)
  })

  test('T2-F2-05 re-submitted qualityBaselinePolicy is stripped or rejected on POST /api/draft', async () => {
    const { harness } = await setupHarnessWithNode()

    const stateRes = await harness.apiGet<StatePayload>('/api/state')
    assert.equal(stateRes.status, 200)

    const res = await harness.apiPost<{ draft?: Record<string, unknown> }>('/api/draft', {
      revision: stateRes.data.revision,
      draft: {
        ...stateRes.data.draft,
        qualityBaselinePolicy: { mode: 'fixed', reportId: randomUUID() },
        fixedQualitySnapshot: { reportId: randomUUID(), rows: {} },
      },
    })

    if (res.status === 400) {
      assert.equal(res.ok, false)
    } else {
      assert.equal(res.status, 200)
      assert.ok(res.data.draft && !('qualityBaselinePolicy' in res.data.draft))
      assert.ok(!('fixedQualitySnapshot' in res.data.draft))
    }

    const storedProfile = harness.readDbDoc<{
      draft: Record<string, unknown>
      fixedQualitySnapshot?: unknown
    }>('profiles', stateRes.data.id)
    assert.ok(storedProfile)
    assert.equal('qualityBaselinePolicy' in storedProfile.draft, false)
    assert.equal('fixedQualitySnapshot' in storedProfile, false)

    const latestState = await harness.apiGet<{ draft: Record<string, unknown> }>('/api/state')
    assert.equal(latestState.status, 200)
    assert.equal('qualityBaselinePolicy' in latestState.data.draft, false)
  })
})
