import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  aiOnlyConfig,
  assertAvailabilityStats,
  basicOnlyConfig,
  buildDraft,
  buildInfoProxy,
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
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
  type QualityNode,
  type RowSpecOverride,
} from '../helpers/mock-probe.ts'

interface WorkspaceStateDto {
  id: string
  revision: number
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
}

async function pairProbe(
  harness: AppHarness,
  name: string,
): Promise<{ probe: MockProbeAgent; deviceId: string }> {
  const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
  expect(inviteRes.status).toBe(200)
  const parsed = parseInviteLink(inviteRes.data.pairing)
  const probe = createMockProbe({
    origin: parsed.origin,
    profileId: parsed.profileId,
    name,
  })
  expect((await probe.enroll(parsed.ticket)).status).toBe(200)
  expect((await probe.poll()).status).toBe(200)
  const devicesRes = await harness.apiGet<DeviceDto[]>('/api/quality/devices')
  expect(devicesRes.status).toBe(200)
  const device = devicesRes.data.find(d => d.name === probe.name)
  expect(device).toBeDefined()
  return { probe, deviceId: device!.id }
}

async function runBasicCheck(
  harness: AppHarness,
  probe: MockProbeAgent,
  deviceId: string,
  keys: string[],
  perNode: (node: QualityNode, index: number) => RowSpecOverride,
): Promise<void> {
  const qRes = await harness.apiPost('/api/quality/queue', {
    targetDeviceId: deviceId,
    keys,
    config: basicOnlyConfig({ rounds: 2 }),
  })
  expect(qRes.status).toBe(200)
  const done = await probe.pollAndComplete(perNode)
  expect(done.completeResponse?.status).toBe(200)
}

test.describe('Tier 2 — F5 Multi-Check Availability Boundaries', () => {
  test('T2-F5-01 rolling 20-cap window evicts oldest 5 fails (20/20 = 1.0)', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const src = buildSource({ id: uniqueId('src_'), name: 'Local F5-01', local: true, paused: true })
      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({ sources: [src] }),
        localNodes: { [src.id]: [buildProxyNode('🇺🇸 Node-Cap', { server: 'f501.example.net', port: 10001 })] },
      })
      expect(draft1.status).toBe(200)
      const nodeKey = `${src.id}/${draft1.data.sources[src.id].good!.nodes[0].id}`

      const { probe, deviceId } = await pairProbe(harness, 'F5-01-Probe')

      for (let i = 0; i < 5; i++) {
        await runBasicCheck(harness, probe, deviceId, [nodeKey], () => ({ available: false }))
      }
      const midLatest = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(midLatest.status).toBe(200)
      assertAvailabilityStats(unwrapLatestForDevice(midLatest.data, deviceId)[nodeKey]?.availability, 0, 5)

      for (let i = 0; i < 20; i++) {
        await runBasicCheck(harness, probe, deviceId, [nodeKey], () => ({ latencyMs: 50 }))
      }
      const finalLatest = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(finalLatest.status).toBe(200)
      const finalRec = unwrapLatestForDevice(finalLatest.data, deviceId)[nodeKey]
      assertAvailabilityStats(finalRec?.availability, 20, 20)
      expect(finalRec?.availability?.window).toEqual(Array.from({ length: 20 }, () => true))
    } finally {
      await harness.close()
    }
  })

  test('T2-F5-02 rolling 20-cap reverse evicts oldest 5 passes (15/20 = 0.75)', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const { probe, deviceId } = await pairProbe(harness, 'F5-02-Probe')
      const src = buildSource({ id: uniqueId('src_'), name: 'Local F5-02', local: true, paused: true })
      const grpId = uniqueId('grp_')
      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'Avail75',
              qualityDeviceId: deviceId,
              members: [
                buildPoolMember({
                  sourceIds: [src.id],
                  quality: buildQualityCondition({ minAvailability: 0.8 }),
                }),
              ],
            }),
          ],
        }),
        localNodes: { [src.id]: [buildProxyNode('🇯🇵 Node-Rev', { server: 'f502.example.net', port: 10001 })] },
      })
      expect(draft1.status).toBe(200)
      const nodeKey = `${src.id}/${draft1.data.sources[src.id].good!.nodes[0].id}`

      for (let i = 0; i < 20; i++) {
        await runBasicCheck(harness, probe, deviceId, [nodeKey], () => ({ latencyMs: 55 }))
      }
      for (let i = 0; i < 5; i++) {
        await runBasicCheck(harness, probe, deviceId, [nodeKey], () => ({ available: false }))
      }

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(latestRes.status).toBe(200)
      const rec = unwrapLatestForDevice(latestRes.data, deviceId)[nodeKey]
      assertAvailabilityStats(rec?.availability, 15, 20)
      expect(rec?.availability?.window.slice(0, 15).every(Boolean)).toBe(true)
      expect(rec?.availability?.window.slice(15).every(v => !v)).toBe(true)

      const check80 = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(check80.status).toBe(200)
      expect(check80.data.groups.find(g => g.id === grpId)?.members).toEqual([])

      const draft2 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: draft1.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'Avail75',
              qualityDeviceId: deviceId,
              members: [
                buildPoolMember({
                  sourceIds: [src.id],
                  quality: buildQualityCondition({ minAvailability: 0.75 }),
                }),
              ],
            }),
          ],
        }),
      })
      expect(draft2.status).toBe(200)

      const check75 = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(check75.status).toBe(200)
      expect(check75.data.groups.find(g => g.id === grpId)?.members.map(m => m.key)).toEqual([nodeKey])
    } finally {
      await harness.close()
    }
  })

  test('T2-F5-03 zero basic checks (availability: null) + untestedPolicy include vs exclude', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const { probe, deviceId } = await pairProbe(harness, 'F5-03-Probe')
      const src = buildSource({ id: uniqueId('src_'), name: 'Local F5-03', local: true, paused: true })
      const grpId = uniqueId('grp_')

      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'UntestedAvail',
              qualityDeviceId: deviceId,
              members: [
                buildPoolMember({
                  sourceIds: [src.id],
                  quality: buildQualityCondition({ minAvailability: 0, untestedPolicy: 'exclude' }),
                }),
              ],
            }),
          ],
        }),
        localNodes: { [src.id]: [buildProxyNode('🇺🇸 Node-AiOnly', { server: 'f503.example.net', port: 10001 })] },
      })
      expect(draft1.status).toBe(200)
      const nodeKey = `${src.id}/${draft1.data.sources[src.id].good!.nodes[0].id}`

      const qAi = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [nodeKey],
        config: aiOnlyConfig(),
      })
      expect(qAi.status).toBe(200)
      const doneAi = await probe.pollAndComplete(() => ({ ai: aiPresets.allGreen('US') }))
      expect(doneAi.completeResponse?.status).toBe(200)

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(latestRes.status).toBe(200)
      const rec = unwrapLatestForDevice(latestRes.data, deviceId)[nodeKey]
      expect(rec).toBeDefined()
      expect(rec.basic).toBeNull()
      expect(rec.availability).toBeNull()
      expect(rec.ai).not.toBeNull()

      // Even with minAvailability: 0, untestedPolicy: 'exclude' excludes null availability
      const checkExclude = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(checkExclude.status).toBe(200)
      expect(checkExclude.data.groups.find(g => g.id === grpId)?.members).toEqual([])

      // untestedPolicy: 'include' includes node with null availability even when minAvailability is 0.8
      const draft2 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: draft1.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'UntestedAvail',
              qualityDeviceId: deviceId,
              members: [
                buildPoolMember({
                  sourceIds: [src.id],
                  quality: buildQualityCondition({ minAvailability: 0.8, untestedPolicy: 'include' }),
                }),
              ],
            }),
          ],
        }),
      })
      expect(draft2.status).toBe(200)

      const checkInclude = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(checkInclude.status).toBe(200)
      expect(checkInclude.data.groups.find(g => g.id === grpId)?.members.map(m => m.key)).toEqual([nodeKey])
    } finally {
      await harness.close()
    }
  })

  test('T2-F5-04 minAvailability boundaries 0, 1, 0.7999, 0.8, 0.8001 & schema rejections', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const { probe, deviceId } = await pairProbe(harness, 'F5-04-Probe')
      const src = buildSource({ id: uniqueId('src_'), name: 'Local F5-04', local: true, paused: true })
      const grpId = uniqueId('grp_')

      const invalidNeg = await harness.apiPost('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'Thresh',
              qualityDeviceId: deviceId,
              members: [buildPoolMember({ sourceIds: [src.id], quality: buildQualityCondition({ minAvailability: -0.01 }) })],
            }),
          ],
        }),
        localNodes: {
          [src.id]: [
            buildProxyNode('🇺🇸 N_100', { server: 'n100.example.net', port: 10001 }),
            buildProxyNode('🇺🇸 N_080', { server: 'n080.example.net', port: 10002 }),
            buildProxyNode('🇺🇸 N_789', { server: 'n789.example.net', port: 10003 }),
            buildProxyNode('🇺🇸 N_000', { server: 'n000.example.net', port: 10004 }),
          ],
        },
      })
      expect(invalidNeg.status).toBe(400)

      const invalidOver = await harness.apiPost('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'Thresh',
              qualityDeviceId: deviceId,
              members: [buildPoolMember({ sourceIds: [src.id], quality: buildQualityCondition({ minAvailability: 1.01 }) })],
            }),
          ],
        }),
      })
      expect(invalidOver.status).toBe(400)

      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'Thresh',
              qualityDeviceId: deviceId,
              members: [buildPoolMember({ sourceIds: [src.id], quality: buildQualityCondition({ minAvailability: 0 }) })],
            }),
          ],
        }),
        localNodes: {
          [src.id]: [
            buildProxyNode('🇺🇸 N_100', { server: 'n100.example.net', port: 10001 }),
            buildProxyNode('🇺🇸 N_080', { server: 'n080.example.net', port: 10002 }),
            buildProxyNode('🇺🇸 N_789', { server: 'n789.example.net', port: 10003 }),
            buildProxyNode('🇺🇸 N_000', { server: 'n000.example.net', port: 10004 }),
          ],
        },
      })
      expect(draft1.status).toBe(200)
      const savedNodes = draft1.data.sources[src.id].good!.nodes
      const keyByName = new Map(savedNodes.map(n => [n.name, `${src.id}/${n.id}`]))
      const k100 = keyByName.get('🇺🇸 N_100')!
      const k080 = keyByName.get('🇺🇸 N_080')!
      const k789 = keyByName.get('🇺🇸 N_789')!
      const k000 = keyByName.get('🇺🇸 N_000')!

      // Batched runs 1..19 across all 4 nodes
      for (let run = 1; run <= 19; run++) {
        await runBasicCheck(harness, probe, deviceId, [k100, k080, k789, k000], node => {
          if (node.key === k100) return { latencyMs: 40 }
          if (node.key === k080 || node.key === k789) return run <= 15 ? { latencyMs: 50 } : { available: false }
          return { available: false }
        })
      }
      // Run 20 omits N_789 so N_789 stays at 15/19 (~0.7895), N_080 reaches 16/20 (0.8), N_100 is 20/20 (1.0), N_000 is 0/20 (0.0)
      await runBasicCheck(harness, probe, deviceId, [k100, k080, k000], node => {
        if (node.key === k100 || node.key === k080) return { latencyMs: 45 }
        return { available: false }
      })

      const latestRes = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(latestRes.status).toBe(200)
      const records = unwrapLatestForDevice(latestRes.data, deviceId)
      assertAvailabilityStats(records[k100]?.availability, 20, 20)
      assertAvailabilityStats(records[k080]?.availability, 16, 20)
      assertAvailabilityStats(records[k789]?.availability, 15, 19)
      assertAvailabilityStats(records[k000]?.availability, 0, 20)

      const thresholds: Array<{ minAvailability: number; expectedNames: string[] }> = [
        { minAvailability: 0, expectedNames: ['🇺🇸 N_100', '🇺🇸 N_080', '🇺🇸 N_789', '🇺🇸 N_000'] },
        { minAvailability: 1, expectedNames: ['🇺🇸 N_100'] },
        { minAvailability: 0.7999, expectedNames: ['🇺🇸 N_100', '🇺🇸 N_080'] },
        { minAvailability: 0.8, expectedNames: ['🇺🇸 N_100', '🇺🇸 N_080'] },
        { minAvailability: 0.8001, expectedNames: ['🇺🇸 N_100'] },
      ]

      let currentRev = draft1.data.revision
      for (const tc of thresholds) {
        const updateRes = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
          revision: currentRev,
          draft: buildDraft({
            sources: [src],
            groups: [
              buildProxyGroup({
                id: grpId,
                name: 'Thresh',
                qualityDeviceId: deviceId,
                members: [
                  buildPoolMember({
                    sourceIds: [src.id],
                    quality: buildQualityCondition({ minAvailability: tc.minAvailability }),
                  }),
                ],
              }),
            ],
          }),
        })
        expect(updateRes.status).toBe(200)
        currentRev = updateRes.data.revision

        const checkRes = await harness.apiPost<CheckResponseDto>('/api/check', {})
        expect(checkRes.status).toBe(200)
        const matchedNames = checkRes.data.groups.find(g => g.id === grpId)?.members.map(m => m.name) ?? []
        expect(matchedNames, `minAvailability=${tc.minAvailability}`).toEqual(tc.expectedNames)
      }

      // Publish at 0.8 and verify compiled YAML matches [N_100, N_080]
      const draft80 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: currentRev,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'Thresh',
              qualityDeviceId: deviceId,
              members: [
                buildPoolMember({
                  sourceIds: [src.id],
                  quality: buildQualityCondition({ minAvailability: 0.8 }),
                }),
              ],
            }),
          ],
        }),
      })
      expect(draft80.status).toBe(200)
      const pubRes = await harness.apiPost('/api/publish', { revision: draft80.data.revision })
      expect(pubRes.status).toBe(200)
      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      expect(linkRes.data.url).toBeTruthy()
      const yamlRes = await harness.subGet(linkRes.data.url!)
      expect(yamlRes.status).toBe(200)
      expect(getYamlGroupProxies(parseMihomoYaml(yamlRes.text), 'Thresh')).toEqual(['🇺🇸 N_100', '🇺🇸 N_080'])
    } finally {
      await harness.close()
    }
  })

  test('T2-F5-05 info_node & invalid_node excluded from availability stats', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const src = buildSource({
        id: uniqueId('src_'),
        name: 'Local F5-05',
        local: true,
        paused: true,
        filter: { keep: [], exclude: [], keywords: [], manual: [], unknown: 'keep' },
      })
      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({ sources: [src] }),
        localNodes: {
          [src.id]: [
            buildProxyNode('🇺🇸 Node-Valid', { server: 'f505-valid.example.net', port: 10001 }),
            buildProxyNode('🇺🇸 Node-Invalid', { server: 'f505-invalid.example.net', port: 10002 }),
            buildInfoProxy('剩余流量：500 GB'),
          ],
        },
      })
      expect(draft1.status).toBe(200)
      const nodes = draft1.data.sources[src.id].good!.nodes
      const validKey = `${src.id}/${nodes.find(n => n.name === '🇺🇸 Node-Valid')!.id}`
      const invalidKey = `${src.id}/${nodes.find(n => n.name === '🇺🇸 Node-Invalid')!.id}`
      const infoKey = `${src.id}/${nodes.find(n => n.name.includes('剩余流量'))!.id}`

      const { probe, deviceId } = await pairProbe(harness, 'F5-05-Probe')

      await runBasicCheck(harness, probe, deviceId, [validKey, invalidKey, infoKey], node => {
        if (node.key === invalidKey) return { error: 'invalid_node' }
        if (node.key === validKey) return { latencyMs: 50 }
        return {}
      })

      const latest1 = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(latest1.status).toBe(200)
      const recs1 = unwrapLatestForDevice(latest1.data, deviceId)
      expect(recs1[infoKey]?.basic?.infoNode).toBe(true)
      expect(recs1[infoKey]?.basic?.error).toBe('info_node')
      expect(recs1[infoKey]?.availability).toBeNull()

      expect(recs1[invalidKey]?.basic?.error).toBe('invalid_node')
      expect(recs1[invalidKey]?.availability).toBeNull()

      assertAvailabilityStats(recs1[validKey]?.availability, 1, 1)

      // Subsequent invalid_node check on Node-Valid must NOT mutate or degrade its prior 1/1 availability
      await runBasicCheck(harness, probe, deviceId, [validKey], () => ({ error: 'invalid_node' }))
      const latest2 = await harness.apiGet(`/api/quality/latest?deviceId=${deviceId}`)
      expect(latest2.status).toBe(200)
      const recs2 = unwrapLatestForDevice(latest2.data, deviceId)
      expect(recs2[validKey]?.basic?.error).toBe('invalid_node')
      assertAvailabilityStats(recs2[validKey]?.availability, 1, 1)
    } finally {
      await harness.close()
    }
  })
})
