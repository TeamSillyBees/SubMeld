import assert from 'node:assert/strict'
import { test } from '@playwright/test'
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
  assertThreeSurfaceAi,
  basicAndAiConfig,
  basicAndBandwidthConfig,
  basicOnlyConfig,
  buildDraft,
  buildProxyNode,
  buildSource,
  uniqueId,
  unwrapLatestForDevice,
  type LatestNodeQuality,
} from '../helpers/fixtures.ts'

interface DraftStateResponse {
  id: string
  revision: number
  sources: Record<string, { good?: { nodes?: Array<{ id: string; name: string }> } }>
}

async function enrollProbe(
  harness: AppHarness,
  name: string,
): Promise<{ probe: MockProbeAgent; deviceId: string }> {
  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  assert.equal(inviteRes.status, 200)
  const { profileId, ticket } = parseInviteLink(inviteRes.data.pairing)

  const probe = createMockProbe({ origin: harness.baseUrl, profileId, name })
  const enrollRes = await probe.enroll(ticket)
  assert.equal(enrollRes.status, 200)

  const devicesRes = await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')
  assert.equal(devicesRes.status, 200)
  const device = devicesRes.data.find(d => d.name === name)
  assert.ok(device)
  return { probe, deviceId: device.id }
}

async function setupLatestStoreContext() {
  const nodes = [
    buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10301 }),
    buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10302 }),
  ]
  const subServer = await startMockSubServer({ feed1: { format: 'yaml', nodes } })
  const harness = await startAppHarness({ useRealCore: false })

  const state0 = await harness.apiGet<DraftStateResponse>('/api/state')
  assert.equal(state0.status, 200)

  const source = buildSource({ id: uniqueId('src_'), name: '增量合并订阅', url: subServer.urlFor('feed1') })
  const probeSrc = await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })
  assert.equal(probeSrc.status, 200)

  const draftRes = await harness.apiPost<DraftStateResponse>('/api/draft', {
    revision: state0.data.revision,
    draft: buildDraft({ sources: [source] }),
  })
  assert.equal(draftRes.status, 200)

  const nodeKeys = (draftRes.data.sources[source.id]?.good?.nodes ?? []).map(n => ({
    key: `${source.id}/${n.id}`,
    name: n.name,
  }))
  assert.equal(nodeKeys.length, 2)

  const { probe, deviceId } = await enrollProbe(harness, 'Probe-Store-A')
  return { subServer, harness, nodeKeys, probe, deviceId }
}

test.describe('Tier 1 — F4: Per-Probe Latest Quality Store & Incremental Merge', () => {
  test('T1-F4-01 GET /api/quality/latest returns basic, speed, ai, and availability per node', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupLatestStoreContext()
      subServer = ctx.subServer
      harness = ctx.harness

      const q1 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: basicAndBandwidthConfig(),
      })
      assert.equal(q1.status, 200)
      const c1 = await ctx.probe.pollAndComplete(() => ({ latencyMs: 55, speedMbps: 110 }))
      assert.equal(c1.completeResponse?.status, 200)

      const q2 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: ctx.nodeKeys.map(n => n.key),
        config: aiOnlyConfig(),
      })
      assert.equal(q2.status, 200)
      const c2 = await ctx.probe.pollAndComplete(() => ({ exit: null, ai: aiPresets.allGreen('US') }))
      assert.equal(c2.completeResponse?.status, 200)

      const unfiltered = await harness.apiGet('/api/quality/latest')
      assert.equal(unfiltered.status, 200)
      const filtered = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      assert.equal(filtered.status, 200)

      const mapFromAll = unwrapLatestForDevice(unfiltered.data, ctx.deviceId)
      const mapFromFiltered = unwrapLatestForDevice(filtered.data, ctx.deviceId)
      assert.deepEqual(mapFromFiltered, mapFromAll)

      for (const { key } of ctx.nodeKeys) {
        const rec = mapFromFiltered[key]
        assert.ok(rec)
        assert.equal(rec.nodeKey, key)
        assert.equal(rec.deviceId, ctx.deviceId)
        assert.ok(rec.basic?.available)
        assert.equal(rec.speed?.speedMbps, 110)
        assertThreeSurfaceAi(rec.ai?.results)
        assertAvailabilityStats(rec.availability, 1, 1)
      }
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F4-02 Basic-then-AI incremental merge preserves basic and availability while updating AI', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupLatestStoreContext()
      subServer = ctx.subServer
      harness = ctx.harness

      const targetKey = ctx.nodeKeys[0].key
      const q1 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [targetKey],
        config: basicOnlyConfig({ rounds: 3 }),
      })
      assert.equal(q1.status, 200)
      const c1 = await ctx.probe.pollAndComplete(() => ({
        latencyMs: 65,
        tlsMs: 20,
        exit: { ip: '198.51.100.10', region: 'JP' },
      }))
      assert.equal(c1.completeResponse?.status, 200)

      const afterBasicRes = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`,
      )
      const beforeRec = unwrapLatestForDevice(afterBasicRes.data, ctx.deviceId)[targetKey]
      assert.ok(beforeRec?.basic)
      assert.equal(beforeRec.basic.httpsMs, 67)
      assert.equal(beforeRec.basic.exit?.region, 'JP')
      assertAvailabilityStats(beforeRec.availability, 1, 1)

      const q2 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [targetKey],
        config: aiOnlyConfig(),
      })
      assert.equal(q2.status, 200)
      const expectedAi = aiPresets.allGreen('JP')
      const c2 = await ctx.probe.pollAndComplete(() => ({
        exit: { ip: '198.51.100.99', region: 'JP' },
        ai: expectedAi,
      }))
      assert.equal(c2.completeResponse?.status, 200)

      const afterAiRes = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`,
      )
      const afterRec = unwrapLatestForDevice(afterAiRes.data, ctx.deviceId)[targetKey]
      assert.deepEqual(afterRec.basic, beforeRec.basic)
      assertAvailabilityStats(afterRec.availability, 1, 1)
      assert.deepEqual(afterRec.ai?.results, expectedAi)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F4-03 AI-then-basic incremental merge preserves AI while populating basic and availability', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupLatestStoreContext()
      subServer = ctx.subServer
      harness = ctx.harness

      const targetKey = ctx.nodeKeys[0].key
      const expectedAi = aiPresets.mixed('US')

      const q1 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [targetKey],
        config: aiOnlyConfig(),
      })
      assert.equal(q1.status, 200)
      const c1 = await ctx.probe.pollAndComplete(() => ({ exit: null, ai: expectedAi }))
      assert.equal(c1.completeResponse?.status, 200)

      const afterAiRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      const rec1 = unwrapLatestForDevice(afterAiRes.data, ctx.deviceId)[targetKey]
      assert.equal(rec1.basic, null)
      assert.equal(rec1.availability, null)
      assert.deepEqual(rec1.ai?.results, expectedAi)

      const q2 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [targetKey],
        config: basicOnlyConfig({ rounds: 3 }),
      })
      assert.equal(q2.status, 200)
      const c2 = await ctx.probe.pollAndComplete(() => ({ latencyMs: 95 }))
      assert.equal(c2.completeResponse?.status, 200)

      const afterBasicRes = await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)
      const rec2 = unwrapLatestForDevice(afterBasicRes.data, ctx.deviceId)[targetKey]
      assert.deepEqual(rec2.ai?.results, expectedAi)
      assert.equal(rec2.basic?.httpsMs, 97)
      assertAvailabilityStats(rec2.availability, 1, 1)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F4-04 Basic-only run preserves speed while basic+bandwidth updates speed', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupLatestStoreContext()
      subServer = ctx.subServer
      harness = ctx.harness

      const targetKey = ctx.nodeKeys[0].key

      const q1 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [targetKey],
        config: basicAndBandwidthConfig(),
      })
      assert.equal(q1.status, 200)
      await ctx.probe.pollAndComplete(() => ({ latencyMs: 50, speedMbps: 120 }))

      let latest = unwrapLatestForDevice(
        (await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)).data,
        ctx.deviceId,
      )[targetKey]
      assert.equal(latest.speed?.speedMbps, 120)
      assertAvailabilityStats(latest.availability, 1, 1)

      const q2 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [targetKey],
        config: basicOnlyConfig(),
      })
      assert.equal(q2.status, 200)
      await ctx.probe.pollAndComplete(() => ({ latencyMs: 70 }))

      latest = unwrapLatestForDevice(
        (await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)).data,
        ctx.deviceId,
      )[targetKey]
      assert.equal(latest.basic?.httpsMs, 72)
      assert.equal(latest.speed?.speedMbps, 120)
      assertAvailabilityStats(latest.availability, 2, 2)

      const q3 = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [targetKey],
        config: basicAndBandwidthConfig(),
      })
      assert.equal(q3.status, 200)
      await ctx.probe.pollAndComplete(() => ({ latencyMs: 45, speedMbps: 240 }))

      latest = unwrapLatestForDevice(
        (await harness.apiGet(`/api/quality/latest?deviceId=${encodeURIComponent(ctx.deviceId)}`)).data,
        ctx.deviceId,
      )[targetKey]
      assert.equal(latest.basic?.httpsMs, 47)
      assert.equal(latest.speed?.speedMbps, 240)
      assertAvailabilityStats(latest.availability, 3, 3)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T1-F4-05 Per-probe isolation keeps deviceA and deviceB records strictly separated', async () => {
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      const ctx = await setupLatestStoreContext()
      subServer = ctx.subServer
      harness = ctx.harness

      const { probe: probeB, deviceId: deviceB } = await enrollProbe(harness, 'Probe-Store-B')
      const targetKey = ctx.nodeKeys[0].key

      const qA = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: ctx.deviceId,
        keys: [targetKey],
        config: basicAndAiConfig(),
      })
      assert.equal(qA.status, 200)
      await ctx.probe.pollAndComplete(() => ({ latencyMs: 40, ai: aiPresets.allGreen('US') }))

      const qB = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceB,
        keys: [targetKey],
        config: basicOnlyConfig(),
      })
      assert.equal(qB.status, 200)
      await probeB.pollAndComplete(() => ({ available: false, error: 'no_response' }))

      const allRes = await harness.apiGet<Record<string, Record<string, LatestNodeQuality>>>('/api/quality/latest')
      assert.equal(allRes.status, 200)
      assert.ok(ctx.deviceId in allRes.data)
      assert.ok(deviceB in allRes.data)

      const recA = unwrapLatestForDevice(allRes.data, ctx.deviceId)[targetKey]
      const recB = unwrapLatestForDevice(allRes.data, deviceB)[targetKey]

      assert.equal(recA.basic?.available, true)
      assert.equal(recA.basic?.httpsMs, 42)
      assertThreeSurfaceAi(recA.ai?.results)
      assertAvailabilityStats(recA.availability, 1, 1)

      assert.equal(recB.basic?.available, false)
      assert.equal(recB.ai, null)
      assertAvailabilityStats(recB.availability, 0, 1)
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
