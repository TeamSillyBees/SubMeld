import assert from 'node:assert/strict'
import { test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  aiOnlyConfig,
  assertAvailabilityStats,
  assertThreeSurfaceAi,
  assertYamlGroupExactOrder,
  basicAndBandwidthConfig,
  basicOnlyConfig,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildSource,
  parseMihomoYaml,
  unwrapLatestForDevice,
  type LatestNodeQuality,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  createMockProbe,
  parseInviteLink,
  type AutoResponderHandle,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'

interface SourceNodesPayload {
  good: {
    nodes: Array<{ id: string; name: string }>
  } | null
}

interface WorkspaceStatePayload {
  id: string
  revision: number
  token: string | null
  draft: {
    sources: Array<Record<string, unknown>>
    groups: Array<Record<string, unknown>>
    services: unknown[]
    rules: unknown[]
    base: Record<string, unknown>
  }
}

test.describe('T3-P08 Modular Probe x Latest Store x Availability x Group Eval (F3, F4, F5, F6)', () => {
  test('T3-P08-01 (F3,F4) (F3,F5): modular basic+bandwidth, basic-only, and ai-only runs merge incrementally while preserving speed and isolating availability', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        feed: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
          ],
        },
      })
      harness = await startAppHarness()

      const stateRes = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const profileId = stateRes.data.id
      const source = buildSource({ name: 'Modular Feed', url: subServer.urlFor('feed') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })).status, 200)
      assert.equal(
        (await harness.apiPost('/api/draft', {
          revision: stateRes.data.revision,
          draft: { ...stateRes.data.draft, sources: [source] },
        })).status,
        200,
      )

      const nodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
      const nodes = nodesRes.data.good?.nodes ?? []
      const usKey = `${source.id}/${nodes.find(n => n.name.includes('US-LAX-01'))!.id}`
      const jpKey = `${source.id}/${nodes.find(n => n.name.includes('JP-TYO-01'))!.id}`
      const allKeys = [usKey, jpKey]

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const { ticket } = parseInviteLink(inviteRes.data.pairing)
      const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Modular-Probe' })
      assert.equal((await probe.enroll(ticket)).status, 200)
      const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
      const deviceId = devicesRes.data.find(d => d.name === 'Modular-Probe')!.id

      // Run 1: basic + bandwidth (US passes 120 Mbps, JP fails)
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceId,
          keys: allKeys,
          config: basicAndBandwidthConfig(),
        })).status,
        200,
      )
      const run1 = await probe.pollAndComplete(node => {
        if (node.key === usKey) {
          return { latencyMs: 60, speedMbps: 120, exit: { ip: '198.51.100.1', region: 'US' } }
        }
        return { available: false, error: 'no_response' }
      })
      assert.equal(run1.assignment?.config.basic, true)
      assert.equal(run1.assignment?.config.bandwidth, true)
      assert.equal(run1.assignment?.config.ai, false)
      assert.equal(run1.completeResponse?.status, 200)

      let latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)
      assert.equal(latestRes.status, 200)
      let latest = unwrapLatestForDevice(latestRes.data, deviceId)
      assert.equal(latest[usKey].basic?.available, true)
      assert.ok((latest[usKey].speed?.speedMbps ?? 0) > 100)
      assert.equal(latest[usKey].ai, null)
      assertAvailabilityStats(latest[usKey].availability, 1, 1)
      assert.equal(latest[jpKey].basic?.available, false)
      assert.equal(latest[jpKey].speed, null)
      assertAvailabilityStats(latest[jpKey].availability, 0, 1)

      // Run 2: basic-only (both pass -> US speed preserved, JP availability rises to 1/2) (F3, F4) (F3, F5)
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceId,
          keys: allKeys,
          config: basicOnlyConfig(),
        })).status,
        200,
      )
      const run2 = await probe.pollAndComplete(node => {
        if (node.key === usKey) return { latencyMs: 52, exit: { ip: '198.51.100.1', region: 'US' } }
        return { latencyMs: 74, exit: { ip: '198.51.100.2', region: 'JP' } }
      })
      assert.equal(run2.assignment?.config.basic, true)
      assert.equal(run2.assignment?.config.bandwidth, false)
      assert.equal(run2.assignment?.config.ai, false)
      assert.equal(run2.completeResponse?.status, 200)

      latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)
      latest = unwrapLatestForDevice(latestRes.data, deviceId)
      assert.equal(latest[usKey].basic?.httpsMs, 54)
      assert.ok((latest[usKey].speed?.speedMbps ?? 0) > 100, 'basic-only run must preserve previous speed')
      assert.equal(latest[usKey].ai, null)
      assertAvailabilityStats(latest[usKey].availability, 2, 2)
      assert.equal(latest[jpKey].basic?.available, true)
      assertAvailabilityStats(latest[jpKey].availability, 1, 2)

      // Run 3: ai-only (samples: [] -> basic, speed, and availability preserved unchanged!) (F3, F4) (F3, F5)
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceId,
          keys: allKeys,
          config: aiOnlyConfig(),
        })).status,
        200,
      )
      const run3 = await probe.pollAndComplete(node => {
        if (node.key === usKey) return { exit: { ip: '198.51.100.1', region: 'US' }, ai: aiPresets.allGreen('US') }
        return { exit: { ip: '198.51.100.2', region: 'JP' }, ai: aiPresets.allGreen('JP') }
      })
      assert.equal(run3.assignment?.config.basic, false)
      assert.equal(run3.assignment?.config.ai, true)
      assert.ok(run3.report?.results.every(row => row.samples.length === 0))
      assert.equal(run3.completeResponse?.status, 200)

      latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(deviceId)}`)
      latest = unwrapLatestForDevice(latestRes.data, deviceId)
      assert.equal(latest[usKey].basic?.httpsMs, 54)
      assert.ok((latest[usKey].speed?.speedMbps ?? 0) > 100)
      assertThreeSurfaceAi(latest[usKey].ai?.results)
      assertAvailabilityStats(latest[usKey].availability, 2, 2)

      assert.equal(latest[jpKey].basic?.available, true)
      assert.equal(latest[jpKey].basic?.httpsMs, 76)
      assertThreeSurfaceAi(latest[jpKey].ai?.results)
      assertAvailabilityStats(latest[jpKey].availability, 1, 2)

      // Verify SQLite persistence in quality-latest/<profileId>
      const dbDoc = harness.readDbDoc<LatestNodeQuality>(`quality-latest/${profileId}`, `${deviceId}/${usKey}`)
      assert.ok(dbDoc)
      assertAvailabilityStats(dbDoc.availability, 2, 2)
      assertThreeSurfaceAi(dbDoc.ai?.results)
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T3-P08-02 (F3,F6) (F4,F6): single-probe group evaluation reads modularly merged quality-latest isolated per Group.qualityDeviceId', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        feed: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
            buildProxyNode('🇸🇬 SG-SIN-01', { server: 'sg-sin-01.example.net', port: 10003 }),
          ],
        },
      })
      harness = await startAppHarness()

      const initialState = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const profileId = initialState.data.id
      const source = buildSource({ name: 'MultiProbe Feed', url: subServer.urlFor('feed') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })).status, 200)
      assert.equal(
        (await harness.apiPost('/api/draft', {
          revision: initialState.data.revision,
          draft: { ...initialState.data.draft, sources: [source] },
        })).status,
        200,
      )

      const nodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
      const nodes = nodesRes.data.good?.nodes ?? []
      const usKey = `${source.id}/${nodes.find(n => n.name.includes('US-LAX-01'))!.id}`
      const jpKey = `${source.id}/${nodes.find(n => n.name.includes('JP-TYO-01'))!.id}`
      const sgKey = `${source.id}/${nodes.find(n => n.name.includes('SG-SIN-01'))!.id}`
      const allKeys = [usKey, jpKey, sgKey]

      // Pair Probe-A and Probe-B
      const inviteA = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const probeA = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Probe-A' })
      assert.equal((await probeA.enroll(parseInviteLink(inviteA.data.pairing).ticket)).status, 200)

      const inviteB = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const probeB = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Probe-B' })
      assert.equal((await probeB.enroll(parseInviteLink(inviteB.data.pairing).ticket)).status, 200)

      const devices = (await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')).data
      const deviceAId = devices.find(d => d.name === 'Probe-A')!.id
      const deviceBId = devices.find(d => d.name === 'Probe-B')!.id

      // Probe-A: basic+bandwidth -> ai-only. Only US-LAX-01 meets bandwidth>=50 + aiAll + minAvailability>=0.8
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceAId,
          keys: allKeys,
          config: basicAndBandwidthConfig(),
        })).status,
        200,
      )
      assert.equal(
        (await probeA.pollAndComplete(node => {
          if (node.key === usKey) return { latencyMs: 50, speedMbps: 150, exit: { ip: '198.51.100.1', region: 'US' } }
          if (node.key === jpKey) return { latencyMs: 70, speedMbps: 20, exit: { ip: '198.51.100.2', region: 'JP' } }
          return { available: false, error: 'no_response' }
        })).completeResponse?.status,
        200,
      )

      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceAId,
          keys: allKeys,
          config: aiOnlyConfig(),
        })).status,
        200,
      )
      assert.equal(
        (await probeA.pollAndComplete(node => {
          if (node.key === usKey) return { exit: { ip: '198.51.100.1', region: 'US' }, ai: aiPresets.allGreen('US') }
          if (node.key === jpKey) return { exit: { ip: '198.51.100.2', region: 'JP' }, ai: aiPresets.allGreen('JP') }
          return { exit: null, ai: aiPresets.allRestricted('HK') }
        })).completeResponse?.status,
        200,
      )

      // Probe-B: basic+bandwidth -> ai-only. Only SG-SIN-01 meets bandwidth>=50 + aiAll + minAvailability>=0.8
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceBId,
          keys: allKeys,
          config: basicAndBandwidthConfig(),
        })).status,
        200,
      )
      assert.equal(
        (await probeB.pollAndComplete(node => {
          if (node.key === sgKey) return { latencyMs: 35, speedMbps: 200, exit: { ip: '198.51.100.3', region: 'SG' } }
          return { available: false, error: 'no_response' }
        })).completeResponse?.status,
        200,
      )

      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceBId,
          keys: allKeys,
          config: aiOnlyConfig(),
        })).status,
        200,
      )
      assert.equal(
        (await probeB.pollAndComplete(node => {
          if (node.key === sgKey) return { exit: { ip: '198.51.100.3', region: 'SG' }, ai: aiPresets.allGreen('SG') }
          return { exit: null, ai: aiPresets.allRestricted('HK') }
        })).completeResponse?.status,
        200,
      )

      // Bind Group-A to Probe-A, Group-B to Probe-B, and Group-Unbound to null (with DIRECT fallback)
      const latestState = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const condition = buildQualityCondition({ minBandwidthMbps: 50, aiAll: true, minAvailability: 0.8 })
      const groupA = buildProxyGroup({
        name: 'Group-A',
        qualityDeviceId: deviceAId,
        members: [buildPoolMember({ sourceIds: [source.id], quality: condition })],
      })
      const groupB = buildProxyGroup({
        name: 'Group-B',
        qualityDeviceId: deviceBId,
        members: [buildPoolMember({ sourceIds: [source.id], quality: condition })],
      })
      const groupUnbound = buildProxyGroup({
        name: 'Group-Unbound',
        qualityDeviceId: null,
        members: [
          buildPoolMember({ sourceIds: [source.id], quality: condition }),
          { kind: 'builtin', id: 'DIRECT' },
        ],
      })

      const saveRes = await harness.apiPost<WorkspaceStatePayload>('/api/draft', {
        revision: latestState.data.revision,
        draft: { ...latestState.data.draft, groups: [groupA, groupB, groupUnbound] },
      })
      assert.equal(saveRes.status, 200)

      // Verify /api/check warns for unbound group without leaking Probe-A/B results
      const checkRes = await harness.apiPost<{ issues: Array<{ code: string; id: string | null }> }>('/api/check', {})
      assert.equal(checkRes.status, 200)
      assert.ok(checkRes.data.issues.some(i => i.code === 'group-quality-device' && i.id === groupUnbound.id))

      // Publish without report pinning and verify compiled Mihomo YAML per group (F3, F6) (F4, F6)
      const pubRes = await harness.apiPost<WorkspaceStatePayload>('/api/publish', { revision: saveRes.data.revision })
      assert.equal(pubRes.status, 200)
      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.equal(linkRes.status, 200)
      assert.ok(linkRes.data.url)

      const subRes = await harness.subGet(linkRes.data.url)
      assert.equal(subRes.status, 200)
      const yamlObj = parseMihomoYaml(subRes.text)
      assertYamlGroupExactOrder(yamlObj, 'Group-A', ['🇺🇸 US-LAX-01'])
      assertYamlGroupExactOrder(yamlObj, 'Group-B', ['🇸🇬 SG-SIN-01'])
      assertYamlGroupExactOrder(yamlObj, 'Group-Unbound', ['DIRECT'])
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
