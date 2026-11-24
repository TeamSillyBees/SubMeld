import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  basicAndAiConfig,
  basicOnlyConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildSource,
  getYamlGroupProxies,
  parseMihomoYaml,
  uniqueId,
  assertYamlGroupExactOrder,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  createMockProbe,
  parseInviteLink,
  type MockProbeAgent,
} from '../helpers/mock-probe.ts'
import {
  attachErrorCollectors,
  openGroupsPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface WorkspaceStateDto {
  id: string
  revision: number
  draft: Record<string, unknown>
  sources: Record<string, { good?: { nodes: Array<{ id: string; name: string }> } | null }>
  current: Record<string, unknown> | null
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

test.describe('Tier 2 — F6 Single-Probe Evaluation & No Report Pinning Boundaries', () => {
  test('T2-F6-01 qualityDeviceId: null with quality conditions evaluates gracefully', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const src = buildSource({ id: uniqueId('src_'), name: 'Local F6-01', local: true, paused: true })
      const grp1Id = uniqueId('grp_')
      const grp2Id = uniqueId('grp_')

      const invalidUuidDraft = await harness.apiPost('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grp1Id,
              name: 'UnboundWithDirect',
              qualityDeviceId: 'not-a-uuid',
              members: [{ kind: 'builtin', id: 'DIRECT' }],
            }),
          ],
        }),
        localNodes: { [src.id]: [buildProxyNode('🇺🇸 Node-1', { server: 'f601.example.net', port: 10001 })] },
      })
      expect(invalidUuidDraft.status).toBe(400)

      const grp1 = buildProxyGroup({
        id: grp1Id,
        name: 'UnboundWithDirect',
        qualityDeviceId: null,
        members: [
          buildPoolMember({ sourceIds: [src.id], quality: buildQualityCondition({ maxLatencyMs: 200 }) }),
          { kind: 'builtin', id: 'DIRECT' },
        ],
      })
      const grp2Disabled = buildProxyGroup({
        id: grp2Id,
        name: 'UnboundEmpty',
        enabled: false,
        qualityDeviceId: null,
        members: [
          buildPoolMember({ sourceIds: [src.id], quality: buildQualityCondition({ maxLatencyMs: 200 }) }),
        ],
      })

      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({ sources: [src], groups: [grp1, grp2Disabled] }),
        localNodes: { [src.id]: [buildProxyNode('🇺🇸 Node-1', { server: 'f601.example.net', port: 10001 })] },
      })
      expect(draft1.status).toBe(200)

      const check1 = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(check1.status).toBe(200)
      expect(check1.data.issues.some(i => i.severity === 'warning' && i.code === 'group-quality-device' && i.id === grp1Id)).toBe(true)
      expect(check1.data.groups.find(g => g.id === grp1Id)?.members.map(m => m.name)).toEqual(['DIRECT'])

      const pub1 = await harness.apiPost('/api/publish', { revision: draft1.data.revision })
      expect(pub1.status).toBe(200)

      // Enabling empty Group2 without DIRECT fallback fails check/publish cleanly with group-empty (422)
      const draft2 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: draft1.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [grp1, { ...grp2Disabled, enabled: true }],
        }),
      })
      expect(draft2.status).toBe(200)

      const check2 = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(check2.status).toBe(200)
      expect(check2.data.issues.some(i => i.severity === 'error' && i.code === 'group-empty' && i.id === grp2Id)).toBe(true)

      const pub2 = await harness.apiPost('/api/publish', { revision: draft2.data.revision })
      expect(pub2.status).toBe(422)
    } finally {
      await harness.close()
    }
  })

  test('T2-F6-02 revoking bound probe does not 500 or crash check, publish, /sub, or #/groups', async ({ page }) => {
    const harness = await startAppHarness()
    const errorCollector = attachErrorCollectors(page)
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const { probe, deviceId } = await pairProbe(harness, 'F6-02-Probe')
      const src = buildSource({ id: uniqueId('src_'), name: 'Local F6-02', local: true, paused: true })
      const grp = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'BoundGroup',
        qualityDeviceId: deviceId,
        members: [
          buildPoolMember({ sourceIds: [src.id], quality: buildQualityCondition({ maxLatencyMs: 200 }) }),
        ],
      })

      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({ sources: [src], groups: [grp] }),
        localNodes: { [src.id]: [buildProxyNode('🇺🇸 Node-Bound', { server: 'f602.example.net', port: 10001 })] },
      })
      expect(draft1.status).toBe(200)
      const nodeKey = `${src.id}/${draft1.data.sources[src.id].good!.nodes[0].id}`

      const qRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys: [nodeKey],
        config: basicOnlyConfig(),
      })
      expect(qRes.status).toBe(200)
      const done = await probe.pollAndComplete(() => ({ latencyMs: 50 }))
      expect(done.completeResponse?.status).toBe(200)

      const pub1 = await harness.apiPost('/api/publish', { revision: draft1.data.revision })
      expect(pub1.status).toBe(200)

      // Revoke the bound probe
      const revokeRes = await harness.apiPost('/api/quality/revoke', { id: deviceId })
      expect(revokeRes.status).toBe(200)

      const devicesAfter = await harness.apiGet<DeviceDto[]>('/api/quality/devices')
      expect(devicesAfter.status).toBe(200)
      expect(devicesAfter.data).toEqual([])

      const checkAfter = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(checkAfter.status).toBe(200)
      expect(checkAfter.data.groups.find(g => g.id === grp.id)?.members.map(m => m.name)).toEqual(['🇺🇸 Node-Bound'])

      const pubAfter = await harness.apiPost('/api/publish', { revision: draft1.data.revision })
      expect(pubAfter.status).toBe(200)

      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      expect(linkRes.status).toBe(200)
      expect(linkRes.data.url).toBeTruthy()
      const subRes = await harness.subGet(linkRes.data.url!)
      expect(subRes.status).toBe(200)
      expect(getYamlGroupProxies(parseMihomoYaml(subRes.text), 'BoundGroup')).toEqual(['🇺🇸 Node-Bound'])

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, grp.id)
      await expect(page.locator('#main-content')).toBeVisible()
      await expect(page.locator('#main-content').getByRole('link', { name: 'BoundGroup' })).toBeVisible()
      errorCollector.assertNoErrors()
    } finally {
      await harness.close()
    }
  })

  test('T2-F6-03 independent probes across Group1 (deviceA) and Group2 (deviceB) in same profile', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const { probe: probeA, deviceId: deviceA } = await pairProbe(harness, 'F6-03-ProbeA')
      const { probe: probeB, deviceId: deviceB } = await pairProbe(harness, 'F6-03-ProbeB')

      const src = buildSource({ id: uniqueId('src_'), name: 'Local F6-03', local: true, paused: true })
      const grp1 = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'Group1',
        qualityDeviceId: deviceA,
        members: [
          buildPoolMember({
            sourceIds: [src.id],
            regions: ['US'],
            quality: buildQualityCondition({ maxLatencyMs: 200 }),
          }),
          buildPoolMember({
            sourceIds: [src.id],
            regions: ['JP', 'US'],
            quality: buildQualityCondition({ aiAll: true, maxLatencyMs: 200 }),
          }),
        ],
      })
      const grp2 = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'Group2',
        qualityDeviceId: deviceB,
        members: [
          buildPoolMember({
            sourceIds: [src.id],
            quality: buildQualityCondition({ maxLatencyMs: 200, aiAll: true }),
          }),
        ],
      })

      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({ sources: [src], groups: [grp1, grp2] }),
        localNodes: {
          [src.id]: [
            buildProxyNode('🇺🇸 Node-1', { server: 'f603-1.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 Node-2', { server: 'f603-2.example.net', port: 10002 }),
          ],
        },
      })
      expect(draft1.status).toBe(200)
      const nodes = draft1.data.sources[src.id].good!.nodes
      const key1 = `${src.id}/${nodes.find(n => n.name === '🇺🇸 Node-1')!.id}`
      const key2 = `${src.id}/${nodes.find(n => n.name === '🇯🇵 Node-2')!.id}`

      // Probe A: Node-1 fast + allGreen; Node-2 failed
      const qA = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceA,
        keys: [key1, key2],
        config: basicAndAiConfig(),
      })
      expect(qA.status).toBe(200)
      const doneA = await probeA.pollAndComplete(node =>
        node.key === key1 ? { latencyMs: 40, ai: aiPresets.allGreen('US') } : { available: false },
      )
      expect(doneA.completeResponse?.status).toBe(200)

      // Probe B: Node-1 slow (600ms); Node-2 fast + allGreen
      const qB = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceB,
        keys: [key1, key2],
        config: basicAndAiConfig(),
      })
      expect(qB.status).toBe(200)
      const doneB = await probeB.pollAndComplete(node =>
        node.key === key1
          ? { latencyMs: 600, ai: aiPresets.allGreen('US') }
          : { latencyMs: 30, ai: aiPresets.allGreen('JP') },
      )
      expect(doneB.completeResponse?.status).toBe(200)

      const pubRes = await harness.apiPost('/api/publish', { revision: draft1.data.revision })
      expect(pubRes.status).toBe(200)

      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      expect(linkRes.data.url).toBeTruthy()
      const yamlRes = await harness.subGet(linkRes.data.url!)
      expect(yamlRes.status).toBe(200)
      const parsedYaml = parseMihomoYaml(yamlRes.text)
      assertYamlGroupExactOrder(parsedYaml, 'Group1', ['🇺🇸 Node-1'])
      assertYamlGroupExactOrder(parsedYaml, 'Group2', ['🇯🇵 Node-2'])
    } finally {
      await harness.close()
    }
  })

  test('T2-F6-04 POST /api/publish succeeds without expectedQualityReportId & strips qualityBaselinePolicy', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const src = buildSource({ id: uniqueId('src_'), name: 'Local F6-04', local: true, paused: true })
      const grp = buildProxyGroup({
        id: uniqueId('grp_'),
        name: 'CleanGroup',
        members: [buildPoolMember({ sourceIds: [src.id] })],
      })

      const draftWithLegacy = {
        ...buildDraft({ sources: [src], groups: [grp] }),
        qualityBaselinePolicy: { mode: 'fixed', reportId: randomUUID() },
      }
      const draftRes = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: draftWithLegacy,
        localNodes: { [src.id]: [buildProxyNode('🇺🇸 Node-Clean', { server: 'f604.example.net', port: 10001 })] },
      })
      expect(draftRes.status).toBe(200)
      expect(Object.hasOwn(draftRes.data.draft, 'qualityBaselinePolicy')).toBe(false)

      const pubRes = await harness.apiPost<WorkspaceStateDto>('/api/publish', {
        revision: draftRes.data.revision,
      })
      expect(pubRes.status).toBe(200)
      expect(pubRes.data.current).not.toBeNull()
      expect(Object.hasOwn(pubRes.data.current!, 'qualityReportId')).toBe(false)
      expect(Object.hasOwn(pubRes.data.current!, 'qualitySnapshot')).toBe(false)
      expect(Object.hasOwn(pubRes.data.current!, 'qualityDeviceId')).toBe(false)

      const historyRes = await harness.apiGet<Array<Record<string, unknown>>>('/api/history')
      expect(historyRes.status).toBe(200)
      expect(historyRes.data.length).toBe(1)
      expect(Object.hasOwn(historyRes.data[0], 'qualityReportId')).toBe(false)
      expect(Object.hasOwn(historyRes.data[0], 'qualitySnapshot')).toBe(false)
      expect(Object.hasOwn(historyRes.data[0], 'qualityDeviceId')).toBe(false)

      const dbVersions = harness.listDbSpace<Record<string, unknown>>(`versions/${draftRes.data.id}`)
      expect(dbVersions.length).toBe(1)
      expect(Object.hasOwn(dbVersions[0].data, 'qualityReportId')).toBe(false)
      expect(Object.hasOwn(dbVersions[0].data, 'qualitySnapshot')).toBe(false)
      expect(Object.hasOwn(dbVersions[0].data, 'qualityDeviceId')).toBe(false)
    } finally {
      await harness.close()
    }
  })

  test('T2-F6-05 clearing rules/conditions on bound group compiles cleanly', async () => {
    const harness = await startAppHarness()
    try {
      const state0 = await harness.apiGet<WorkspaceStateDto>('/api/state')
      expect(state0.status).toBe(200)

      const { probe, deviceId } = await pairProbe(harness, 'F6-05-Probe')
      const src = buildSource({ id: uniqueId('src_'), name: 'Local F6-05', local: true, paused: true })
      const grpId = uniqueId('grp_')

      const draft1 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: state0.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'ClearedGroup',
              qualityDeviceId: deviceId,
              members: [
                buildPoolMember({
                  sourceIds: [src.id],
                  quality: buildQualityCondition({ maxLatencyMs: 1 }),
                }),
              ],
            }),
          ],
        }),
        localNodes: {
          [src.id]: [
            buildProxyNode('🇺🇸 Node-1', { server: 'f605-1.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 Node-2', { server: 'f605-2.example.net', port: 10002 }),
          ],
        },
      })
      expect(draft1.status).toBe(200)
      const keys = draft1.data.sources[src.id].good!.nodes.map(n => `${src.id}/${n.id}`)

      const qRes = await harness.apiPost('/api/quality/queue', {
        targetDeviceId: deviceId,
        keys,
        config: basicOnlyConfig(),
      })
      expect(qRes.status).toBe(200)
      const done = await probe.pollAndComplete((_, idx) => ({ latencyMs: idx === 0 ? 50 : 300 }))
      expect(done.completeResponse?.status).toBe(200)

      const checkStrict = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(checkStrict.status).toBe(200)
      expect(checkStrict.data.issues.some(i => i.code === 'pool-quality-empty' && i.id === grpId)).toBe(true)
      expect(checkStrict.data.groups.find(g => g.id === grpId)?.members).toEqual([])

      // Clear quality condition while keeping qualityDeviceId bound
      const draft2 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: draft1.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'ClearedGroup',
              qualityDeviceId: deviceId,
              members: [buildPoolMember({ sourceIds: [src.id] })],
            }),
          ],
        }),
      })
      expect(draft2.status).toBe(200)

      const checkCleared = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(checkCleared.status).toBe(200)
      expect(checkCleared.data.issues.filter(i => i.code === 'group-quality-device' || i.code === 'pool-quality-empty')).toEqual([])
      expect(checkCleared.data.groups.find(g => g.id === grpId)?.members.map(m => m.name)).toEqual(['🇺🇸 Node-1', '🇯🇵 Node-2'])

      const pub2 = await harness.apiPost('/api/publish', { revision: draft2.data.revision })
      expect(pub2.status).toBe(200)

      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      expect(linkRes.data.url).toBeTruthy()
      const yamlRes = await harness.subGet(linkRes.data.url!)
      expect(yamlRes.status).toBe(200)
      assertYamlGroupExactOrder(parseMihomoYaml(yamlRes.text), 'ClearedGroup', ['🇺🇸 Node-1', '🇯🇵 Node-2'])

      // Also clear qualityDeviceId: null cleanly
      const draft3 = await harness.apiPost<WorkspaceStateDto>('/api/draft', {
        revision: draft2.data.revision,
        draft: buildDraft({
          sources: [src],
          groups: [
            buildProxyGroup({
              id: grpId,
              name: 'ClearedGroup',
              qualityDeviceId: null,
              members: [buildPoolMember({ sourceIds: [src.id] })],
            }),
          ],
        }),
      })
      expect(draft3.status).toBe(200)
      const checkUnbound = await harness.apiPost<CheckResponseDto>('/api/check', {})
      expect(checkUnbound.status).toBe(200)
      expect(checkUnbound.data.issues.filter(i => i.code === 'group-quality-device' || i.code === 'pool-quality-empty')).toEqual([])
      expect((await harness.apiPost('/api/publish', { revision: draft3.data.revision })).status).toBe(200)
    } finally {
      await harness.close()
    }
  })
})
