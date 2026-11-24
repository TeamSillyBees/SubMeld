import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  assertAvailabilityStats,
  assertThreeSurfaceAi,
  basicAndAiConfig,
  basicAndBandwidthConfig,
  basicOnlyConfig,
  aiOnlyConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildSource,
  getYamlGroupProxies,
  parseMihomoYaml,
  uniqueId,
  unwrapLatestForDevice,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  buildAgentReport,
  createMockProbe,
  credential,
  parseInviteLink,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'

interface WorkspaceStateDto {
  id: string
  revision: number
  draft: Record<string, unknown>
  sources: Record<string, { good?: { nodes: Array<{ id: string; name: string }> } | null }>
}

interface CheckResponseDto {
  revision: number
  groups: Array<{ id: string; name: string; members: Array<{ key: string; name: string; kind: string }> }>
  issues: Array<{ severity: string; code: string; message: string; id: string | null }>
}

interface DeviceDto {
  id: string
  name: string
  status: string
}

interface QualityJobDto {
  id: string
  status: string
  total: number
  targetDeviceId: string | null
}

async function pairProbe(
  harness: AppHarness,
  name: string,
  profile?: string,
): Promise<{ probe: MockProbeAgent; deviceId: string; profileId: string }> {
  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {}, { profile })
  expect(inviteRes.status).toBe(200)
  const parsed = parseInviteLink(inviteRes.data.pairing)
  const probe = createMockProbe({
    origin: parsed.origin,
    profileId: parsed.profileId,
    name,
  })
  const enrollRes = await probe.enroll(parsed.ticket)
  expect(enrollRes.status).toBe(200)
  const pollRes = await probe.poll()
  expect(pollRes.status).toBe(200)

  const devicesRes = await harness.apiGet<DeviceDto[]>('/api/quality/devices', { profile })
  expect(devicesRes.status).toBe(200)
  const device = devicesRes.data.find(d => d.name === probe.name)
  expect(device).toBeDefined()
  return { probe, deviceId: device!.id, profileId: parsed.profileId }
}

test.describe('Tier 2 — F4 Per-Probe Latest Store & Incremental Merge Boundaries', () => {
  test('T2-F4-01 unknown nodeKey & revoked probe complete do not pollute quality-latest', async () => {
    const harness = await startAppHarness()
    try {
      const stateRes = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(stateRes.status).toBe(200)

      const src = buildSource({ id: uniqueId('src_'), name: 'Local F4-01', local: true, paused: true })
      const nodes = [
        buildProxyNode('🇺🇸 Node-1', { server: 'f401-1.example.net', port: 10001 }),
        buildProxyNode('🇯🇵 Node-2', { server: 'f401-2.example.net', port: 10002 }),
      ]
      const draftRes = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: stateRes.data.revision,
        draft: buildDraft({ sources: [src] }),
        localNodes: { [src.id]: nodes },
      })
      expect(draftRes.status).toBe(200)
      const savedNodes = draftRes.data.sources[src.id].good!.nodes
      const keys = savedNodes.map(n => `${src.id}/${n.id}`)

      const { probe, deviceId } = await pairProbe(harness, 'F4-01-Probe')

      const unknownQueueRes = await harness.apiPost<{ message: string }>('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [`${src.id}/missing01`],
        config: basicOnlyConfig(),
      })
      expect(unknownQueueRes.status).toBe(409)

      const job1Res = await harness.apiPost<QualityJobDto>('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys,
        config: basicOnlyConfig(),
      })
      expect(job1Res.status).toBe(200)

      const poll1 = await probe.poll()
      expect(poll1.status).toBe(200)
      const assignment1 = poll1.body
      expect(assignment1 && typeof assignment1 === 'object' && 'jobId' in assignment1).toBe(true)
      if (!assignment1 || typeof assignment1 !== 'object' || !('jobId' in assignment1)) return

      const tamperedReport = buildAgentReport(assignment1)
      tamperedReport.results[0] = { ...tamperedReport.results[0], key: 'unknown01/node9999' }
      const tamperedComplete = await probe.complete(assignment1.jobId, tamperedReport)
      expect(tamperedComplete.status).toBe(422)

      const latestAfterTamper = await harness.apiGet('/api/quality/latest')
      expect(latestAfterTamper.status).toBe(200)
      expect(latestAfterTamper.data).toEqual({})

      const cancelRes = await harness.apiPost('/api/quality/cancel', { id: job1Res.data.id })
      expect(cancelRes.status).toBe(200)

      const job2Res = await harness.apiPost<QualityJobDto>('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys,
        config: basicOnlyConfig(),
      })
      expect(job2Res.status).toBe(200)
      const poll2 = await probe.poll()
      expect(poll2.status).toBe(200)
      const assignment2 = poll2.body
      expect(assignment2 && typeof assignment2 === 'object' && 'jobId' in assignment2).toBe(true)
      if (!assignment2 || typeof assignment2 !== 'object' || !('jobId' in assignment2)) return

      const revokeRes = await harness.apiPost('/api/quality/revoke', { id: deviceId })
      expect(revokeRes.status).toBe(200)

      const completeAfterRevoke = await probe.complete(assignment2.jobId, buildAgentReport(assignment2))
      expect(completeAfterRevoke.status).toBe(403)

      const pollAfterRevoke = await probe.poll()
      expect(pollAfterRevoke.status).toBe(403)

      const latestByDevice = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(latestByDevice.status).toBe(200)
      expect(latestByDevice.data).toEqual({})

      const latestAll = await harness.apiGet('/api/quality/latest')
      expect(latestAll.status).toBe(200)
      expect(latestAll.data).toEqual({})
    } finally {
      await harness.close()
    }
  })

  test('T2-F4-02 failed basic overwrites basic while preserving ai & speed', async () => {
    const harness = await startAppHarness()
    try {
      const stateRes = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(stateRes.status).toBe(200)

      const { probe, deviceId } = await pairProbe(harness, 'F4-02-Probe')
      const src = buildSource({ id: uniqueId('src_'), name: 'Local F4-02', local: true, paused: true })
      const grpWithAiAndAvail = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'AvailAndAi',
        qualityDeviceId: deviceId,
        members: [
          buildPoolMember({
            sourceIds: [src.id],
            quality: buildQualityCondition({ minAvailability: 0.5, aiAll: true }),
          }),
        ],
      })
      const grpAiOnly = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'AiOnlyCurrent',
        qualityDeviceId: deviceId,
        members: [
          buildPoolMember({
            sourceIds: [src.id],
            quality: buildQualityCondition({ aiAll: true }),
          }),
        ],
      })

      const draftRes = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: stateRes.data.revision,
        draft: buildDraft({ sources: [src], groups: [grpWithAiAndAvail, grpAiOnly] }),
        localNodes: { [src.id]: [buildProxyNode('🇯🇵 JP-Node-1', { server: 'f402.example.net', port: 10001 })] },
      })
      expect(draftRes.status).toBe(200)
      const nodeKey = `${src.id}/${draftRes.data.sources[src.id].good!.nodes[0].id}`

      // 1. Passing basic + bandwidth
      const q1 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [nodeKey],
        config: basicAndBandwidthConfig(),
      })
      expect(q1.status).toBe(200)
      const r1 = await probe.pollAndComplete(() => ({ latencyMs: 60, speedMbps: 80 }))
      expect(r1.completeResponse?.status).toBe(200)

      // 2. AI-only run
      const q2 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [nodeKey],
        config: aiOnlyConfig(),
      })
      expect(q2.status).toBe(200)
      const r2 = await probe.pollAndComplete(() => ({ ai: aiPresets.allGreen('JP') }))
      expect(r2.completeResponse?.status).toBe(200)

      // 3. Failed basic-only run
      const q3 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [nodeKey],
        config: basicOnlyConfig(),
      })
      expect(q3.status).toBe(200)
      const r3 = await probe.pollAndComplete(() => ({ available: false, error: 'no_response' }))
      expect(r3.completeResponse?.status).toBe(200)

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(latestRes.status).toBe(200)
      const records = unwrapLatestForDevice(latestRes.data, deviceId)
      const rec = records[nodeKey]
      expect(rec).toBeDefined()
      expect(rec.basic?.available).toBe(false)
      expect(rec.basic?.error).toBe('no_response')
      expect(rec.basic?.httpsMs).toBeNull()
      expect(rec.basic?.exit).toBeNull()
      expect(rec.speed).not.toBeNull()
      expect(rec.speed?.speedFailed).toBe(false)
      expect(rec.speed?.speedMbps).toBeCloseTo(80, 1)
      expect(rec.ai).not.toBeNull()
      assertThreeSurfaceAi(rec.ai?.results)
      expect(rec.ai?.results?.chatgptWeb.providerRegion).toBe('JP')
      expect(rec.ai?.results?.gemini.state).toBe('reachable')
      assertAvailabilityStats(rec.availability, 1, 2)

      // Verify group evaluation reflects updated basic availability (1/2) & preserved AI
      const checkRes = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(checkRes.status).toBe(200)
      const availGroup = checkRes.data.groups.find(g => g.id === grpWithAiAndAvail.id)
      const aiOnlyGroup = checkRes.data.groups.find(g => g.id === grpAiOnly.id)
      expect(availGroup?.members.map(m => m.key)).toEqual([nodeKey])
      expect(aiOnlyGroup?.members.map(m => m.key)).toEqual([])
    } finally {
      await harness.close()
    }
  })

  test('T2-F4-03 stale / duplicate complete does not corrupt or double-count', async () => {
    const harness = await startAppHarness()
    try {
      const stateRes = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(stateRes.status).toBe(200)

      const src = buildSource({ id: uniqueId('src_'), name: 'Local F4-03', local: true, paused: true })
      const draftRes = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: stateRes.data.revision,
        draft: buildDraft({ sources: [src] }),
        localNodes: { [src.id]: [buildProxyNode('🇺🇸 Node-Dup', { server: 'f403.example.net', port: 10001 })] },
      })
      expect(draftRes.status).toBe(200)
      const nodeKey = `${src.id}/${draftRes.data.sources[src.id].good!.nodes[0].id}`

      const { probe, deviceId } = await pairProbe(harness, 'F4-03-Probe')

      // 1. Complete job1, then replay exact same complete with same worker
      const q1 = await harness.apiPost<QualityJobDto>('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [nodeKey],
        config: basicOnlyConfig(),
      })
      expect(q1.status).toBe(200)
      const poll1 = await probe.poll()
      expect(poll1.status).toBe(200)
      const assignment1 = poll1.body
      expect(assignment1 && typeof assignment1 === 'object' && 'jobId' in assignment1).toBe(true)
      if (!assignment1 || typeof assignment1 !== 'object' || !('jobId' in assignment1)) return

      const report1 = buildAgentReport(assignment1, () => ({ latencyMs: 55 }))
      const worker1 = probe.getWorkerForJob(assignment1.jobId)
      const complete1 = await probe.complete(assignment1.jobId, report1, worker1)
      expect(complete1.status).toBe(200)

      const duplicateComplete = await probe.complete(assignment1.jobId, report1, worker1)
      expect(duplicateComplete.status).toBe(200)

      const wrongWorkerComplete = await probe.complete(assignment1.jobId, report1, credential())
      expect(wrongWorkerComplete.status).toBe(403)

      // 2. Poll job2, cancel on server, then attempt stale complete
      const q2 = await harness.apiPost<QualityJobDto>('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [nodeKey],
        config: basicOnlyConfig(),
      })
      expect(q2.status).toBe(200)
      const poll2 = await probe.poll()
      expect(poll2.status).toBe(200)
      const assignment2 = poll2.body
      expect(assignment2 && typeof assignment2 === 'object' && 'jobId' in assignment2).toBe(true)
      if (!assignment2 || typeof assignment2 !== 'object' || !('jobId' in assignment2)) return

      const cancel2 = await harness.apiPost('/api/quality/cancel', { id: q2.data.id })
      expect(cancel2.status).toBe(200)

      const completeCancelled = await probe.complete(
        assignment2.jobId,
        buildAgentReport(assignment2, () => ({ available: false })),
      )
      expect(completeCancelled.status).toBe(403)

      // 3. Poll job3, fail from agent, then attempt stale complete
      const q3 = await harness.apiPost<QualityJobDto>('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [nodeKey],
        config: basicOnlyConfig(),
      })
      expect(q3.status).toBe(200)
      const poll3 = await probe.poll()
      expect(poll3.status).toBe(200)
      const assignment3 = poll3.body
      expect(assignment3 && typeof assignment3 === 'object' && 'jobId' in assignment3).toBe(true)
      if (!assignment3 || typeof assignment3 !== 'object' || !('jobId' in assignment3)) return

      const fail3 = await probe.fail(assignment3.jobId)
      expect(fail3.status).toBe(200)
      const completeFailed = await probe.complete(
        assignment3.jobId,
        buildAgentReport(assignment3, () => ({ available: false })),
      )
      expect(completeFailed.status).toBe(403)

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(latestRes.status).toBe(200)
      const rec = unwrapLatestForDevice(latestRes.data, deviceId)[nodeKey]
      expect(rec).toBeDefined()
      assertAvailabilityStats(rec.availability, 1, 1)
    } finally {
      await harness.close()
    }
  })

  test('T2-F4-04 GET /api/quality/latest auth & deviceId boundaries', async () => {
    const harness = await startAppHarness()
    try {
      const unauthRes = await harness.apiGet('/api/quality/latest', { cookie: null })
      expect(unauthRes.status).toBe(401)

      const badUuidRes = await harness.apiGet('/api/quality/latest?deviceId=not-a-uuid')
      expect(badUuidRes.status).toBe(400)

      const missingUuidRes = await harness.apiGet(`/api/quality/latest?deviceId=${randomUUID()}`)
      expect(missingUuidRes.status).toBe(200)
      expect(missingUuidRes.data).toEqual({})

      const emptyAllRes = await harness.apiGet('/api/quality/latest')
      expect(emptyAllRes.status).toBe(200)
      expect(emptyAllRes.data).toEqual({})

      const badProfileRes = await harness.apiGet('/api/quality/latest', { profile: 'missing01' })
      expect(badProfileRes.status).toBe(404)
    } finally {
      await harness.close()
    }
  })

  test('T2-F4-05 multi-profile isolation, deleted source exclusion & deleted profile cleanup', async () => {
    const harness = await startAppHarness()
    try {
      const stateA0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(stateA0.status).toBe(200)
      const profileAId = stateA0.data.id

      const { probe: probeA, deviceId: deviceA } = await pairProbe(harness, 'F4-05-ProbeA', profileAId)

      const src1 = buildSource({ id: uniqueId('src_'), name: 'Source A1', local: true, paused: true })
      const src2 = buildSource({ id: uniqueId('src_'), name: 'Source A2', local: true, paused: true })
      const grpA = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'GroupA',
        qualityDeviceId: deviceA,
        members: [
          buildPoolMember({
            sourceIds: [],
            quality: buildQualityCondition({ alive: true }),
          }),
        ],
      })
      const draftA1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: stateA0.data.revision,
        draft: buildDraft({ sources: [src1, src2], groups: [grpA] }),
        localNodes: {
          [src1.id]: [buildProxyNode('🇺🇸 Node-A', { server: 'f405-a.example.net', port: 10001 })],
          [src2.id]: [buildProxyNode('🇯🇵 Node-B', { server: 'f405-b.example.net', port: 10002 })],
        },
      }, { profile: profileAId })
      expect(draftA1.status).toBe(200)
      const keyA = `${src1.id}/${draftA1.data.sources[src1.id].good!.nodes[0].id}`
      const keyB = `${src2.id}/${draftA1.data.sources[src2.id].good!.nodes[0].id}`

      const queueA = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceA,
        keys: [keyA, keyB],
        config: basicAndAiConfig(),
      }, { profile: profileAId })
      expect(queueA.status).toBe(200)
      const doneA = await probeA.pollAndComplete(() => ({ latencyMs: 45 }))
      expect(doneA.completeResponse?.status).toBe(200)

      // Create Profile B and verify empty isolated quality-latest
      const createB = await harness.apiPost<WorkspaceStateDto>('/api/profiles', {
        action: 'create',
        title: 'Profile B',
      })
      expect(createB.status).toBe(200)
      const profileBId = createB.data.id
      expect(profileBId).not.toBe(profileAId)

      const latestBEmpty = await harness.apiGet('/api/quality/latest', { profile: profileBId })
      expect(latestBEmpty.status).toBe(200)
      expect(latestBEmpty.data).toEqual({})

      // Delete src2 in Profile A; check/publish/YAML/selectQualityScope must exclude Node-B
      const draftA2 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: draftA1.data.revision,
        draft: buildDraft({ sources: [src1], groups: [grpA] }),
      }, { profile: profileAId })
      expect(draftA2.status).toBe(200)

      const checkA = await harness.apiPost<CheckResponseDto>('/api/check', {}, { profile: profileAId })
      expect(checkA.status).toBe(200)
      expect(checkA.data.groups.find(g => g.id === grpA.id)?.members.map(m => m.name)).toEqual(['🇺🇸 Node-A'])

      const pubA = await harness.apiPost<WorkspaceStateDto>('/api/publish', { revision: draftA2.data.revision }, { profile: profileAId })
      expect(pubA.status).toBe(200)
      const linkA = await harness.apiGet<{ url: string | null }>('/api/link', { profile: profileAId })
      expect(linkA.status).toBe(200)
      expect(linkA.data.url).toBeTruthy()
      const yamlRes = await harness.subGet(linkA.data.url!)
      expect(yamlRes.status).toBe(200)
      const parsedYaml = parseMihomoYaml(yamlRes.text)
      expect(getYamlGroupProxies(parsedYaml, 'GroupA')).toEqual(['🇺🇸 Node-A'])
      expect(parsedYaml.proxies.map(p => p.name)).toEqual(['🇺🇸 Node-A'])

      // Scheduled job on Profile A uses selectQualityScope -> must only contain keyA (not deleted keyB)
      const saveSchedA = await harness.apiPost('/api/quality/schedule', {
        targetDeviceId: deviceA,
        scope: 'kept',
        autoRefreshGroups: false,
        basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 2, bandwidth: false },
        ai: { enabled: false, intervalMinutes: 1440, concurrency: 2 },
      }, { profile: profileAId })
      expect(saveSchedA.status).toBe(200)
      const runSchedA = await harness.apiPost('/api/quality/schedule/run', { kind: 'basic' }, { profile: profileAId })
      expect(runSchedA.status).toBe(200)
      const schedPollA = await probeA.poll()
      expect(schedPollA.status).toBe(200)
      const schedAssignA = schedPollA.body
      expect(schedAssignA && typeof schedAssignA === 'object' && 'nodes' in schedAssignA).toBe(true)
      if (schedAssignA && typeof schedAssignA === 'object' && 'nodes' in schedAssignA) {
        expect(schedAssignA.nodes.map(n => n.key)).toEqual([keyA])
        await probeA.cancel(schedAssignA.jobId)
      }

      // Populate Profile B with its own probe & node, verify cross-profile isolation
      const { probe: probeB, deviceId: deviceB } = await pairProbe(harness, 'F4-05-ProbeB', profileBId)
      const srcB = buildSource({ id: uniqueId('src_'), name: 'Source B1', local: true, paused: true })
      const draftB = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: createB.data.revision,
        draft: buildDraft({ sources: [srcB] }),
        localNodes: { [srcB.id]: [buildProxyNode('🇸🇬 Node-C', { server: 'f405-c.example.net', port: 10003 })] },
      }, { profile: profileBId })
      expect(draftB.status).toBe(200)
      const keyC = `${srcB.id}/${draftB.data.sources[srcB.id].good!.nodes[0].id}`

      const queueB = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceB,
        keys: [keyC],
        config: basicOnlyConfig(),
      }, { profile: profileBId })
      expect(queueB.status).toBe(200)
      const doneB = await probeB.pollAndComplete(() => ({ latencyMs: 35 }))
      expect(doneB.completeResponse?.status).toBe(200)

      const latestB = await harness.apiGet(`/api/quality/latest?deviceId=${deviceB}`, { profile: profileBId })
      expect(latestB.status).toBe(200)
      const recsB = unwrapLatestForDevice(latestB.data, deviceB)
      expect(Object.keys(recsB)).toEqual([keyC])

      const latestA = await harness.apiGet(`/api/quality/latest?deviceId=${deviceA}`, { profile: profileAId })
      expect(latestA.status).toBe(200)
      const recsA = unwrapLatestForDevice(latestA.data, deviceA)
      expect(Object.hasOwn(recsA, keyC)).toBe(false)
      expect(Object.hasOwn(recsA, keyA)).toBe(true)

      // Delete Profile B -> SQLite quality-latest/${profileBId} and other quality-* spaces purged
      const delB = await harness.apiPost('/api/profiles', { action: 'delete' }, { profile: profileBId })
      expect(delB.status).toBe(200)

      expect(harness.listDbSpace(`quality-latest/${profileBId}`)).toEqual([])
      expect(harness.listDbSpace(`quality-devices/${profileBId}`)).toEqual([])
      expect(harness.listDbSpace(`quality-schedules/${profileBId}`)).toEqual([])
      expect(harness.listDbSpace(`quality-latest/${profileAId}`).length).toBeGreaterThan(0)
    } finally {
      await harness.close()
    }
  })
})
