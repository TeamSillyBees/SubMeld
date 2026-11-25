import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as wait } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { defaultFilter } from '../shared/catalog.ts'
import { evaluate } from '../shared/config.ts'
import { poolCondition, qualityPresets, qualityReason, resolvePool } from '../shared/group-filter.ts'
import { compareQuality, inferredExitRegion, platformVerdict, qualitySnapshot, qualityValue, type LatestQualityMap, type NodeQuality, type QualitySnapshot } from '../shared/quality-snapshot.ts'
import { qualityDefaults, surfaces, type AiReading, type AiResults, type LatestNodeQuality, type QualityReport } from '../shared/quality.ts'
import { exportBackup, restoreBackup } from '../server/backup.ts'
import { qualitySpaces } from '../server/quality.ts'
import { openStore } from '../server/store.ts'
import { createWorkspace } from '../server/workspace.ts'

const reading: NodeQuality = { available: true, httpsMs: 80, tlsMs: 20, lossRate: 0, speedMbps: 30, speedFailed: false, reachable: ['chatgptWeb', 'gemini'] }
test('quality ordering and pool diagnostics handle missing, failed, tied and partially measured nodes', () => {
  const row = (key: string) => ({ key, name: key, region: 'JP', sourceId: 'source01', kept: true })
  const candidates = ['fast', 'slow', 'partial', 'failed', 'missing'].map(row)
  const snapshot = { reportId: randomUUID(), rows: { fast: reading, slow: { ...reading, httpsMs: 600 }, partial: { ...reading, speedMbps: null, reachable: null }, failed: { ...reading, available: false } } }
  const condition = poolCondition({ quality: { alive: true, maxLatencyMs: 250, minBandwidthMbps: 10, platforms: ['chatgptWeb'] } })
  const result = resolvePool(condition, candidates, snapshot)
  assert.deepEqual(result.matches.map(n => n.key), ['fast'])
  assert.deepEqual(result.reasons, { latency: 1, untested: 2, unavailable: 1 })
  assert.deepEqual(result.untested, ['partial', 'missing'])
  assert.deepEqual(resolvePool({ ...condition, quality: { ...condition.quality, untestedPolicy: 'include' } }, candidates, snapshot).matches.map(n => n.key), ['fast', 'partial', 'missing'])
  const fallback = resolvePool({ ...condition, regions: ['JP'], quality: { minBandwidthMbps: 99, fallbackWhenEmpty: true } }, candidates, snapshot)
  assert.equal(fallback.fallback, true)
  assert.deepEqual(fallback.matches, candidates)
  assert.deepEqual(resolvePool({ ...condition, regions: ['US'] }, candidates, snapshot).matches, [])
  assert.equal(qualityValue(reading, 'ai'), 5)
  assert.equal(qualityValue(reading, 'ChatGPT'), 2)
  assert.equal(qualityValue({ ...reading, platforms: { ChatGPT: null, Gemini: 'blocked_or_unreachable', Antigravity: null } }, 'ai'), -1)
  assert.ok(compareQuality(reading, snapshot.rows.slow, 'loss') < 0)
  assert.ok(compareQuality(reading, snapshot.rows.partial, 'speed') < 0)
  assert.ok(compareQuality(snapshot.rows.failed, undefined, 'tls') > 0)
  assert.equal(compareQuality({ ...reading, reachable: ['chatgptWeb'] }, { ...reading, reachable: null }, 'Gemini'), 0)
  assert.equal(qualityReason({ aiSurfaces: ['antigravity'] }, { ...reading, reachable: ['chatgptWeb', 'gemini', 'antigravity'] }), null)
  assert.equal(qualityReason({ aiSurfaces: ['antigravity'] }, reading), 'platform')
  assert.ok(compareQuality({ ...reading, reachable: ['antigravity'] }, { ...reading, reachable: ['gemini'] }, 'Antigravity') < 0)
})

test('fixed buckets, cascade ties, capability guards and two-tier fallbacks also apply to ranked group output', () => {
  const node = (key: string) => ({ key, name: key, kept: true, region: 'TW', sourceId: 'source01' })
  const snapshot: QualitySnapshot = { reportId: randomUUID(), config: { ai: true, bandwidth: false }, rows: {
    fast: { ...reading, jitterMs: 2, exitRegion: 'HK', surfaceIssues: { chatgptApp: 'degraded_challenge' }, platforms: { ChatGPT: 'degraded_challenge', Gemini: 'unlocked', Antigravity: 'region_restricted' } },
    smooth: { ...reading, jitterMs: 1, exitRegion: 'TW', platforms: { ChatGPT: 'partial_unlock', Gemini: 'unlocked', Antigravity: 'unlocked' } },
    unstable: { ...reading, httpsMs: 250, lossRate: .2, jitterMs: 80, exitRegion: 'TW', platforms: null },
    missing: { ...reading, lossRate: null }, dead: { ...reading, available: false }, notice: { ...reading, available: false, infoNode: true },
  } }
  const keys = ['notice', 'dead', 'untested', 'missing', 'fast', 'unstable', 'smooth']
  const nodes = keys.map(node)
  for (const reverse of [false, true]) {
    const sorted = [...keys].sort((a, b) => compareQuality(snapshot.rows[a], snapshot.rows[b], 'loss', reverse))
    assert.deepEqual(sorted, [...(reverse ? ['unstable', 'smooth', 'fast'] : ['smooth', 'fast', 'unstable']), 'missing', 'untested', 'dead', 'notice'])
  }
  const q = { alive: true, exitRegions: ['TW'], aiPlatforms: ['ChatGPT' as const], minUnlockLevel: 2 as const,
    maxJitterMs: 10, minBandwidthMbps: 5000, sortBy: 'ai' as const, topN: 1 }
  const run = (quality: NonNullable<ReturnType<typeof poolCondition>['quality']>, s = snapshot) => resolvePool(poolCondition({ quality }), nodes, s)
  assert.deepEqual(run(q).matches.map(n => n.key), ['smooth'])
  const relaxed = run({ ...q, exitRegions: ['HK'], maxLatencyMs: 1, relaxWhenEmpty: true, fallbackWhenEmpty: true })
  assert.equal(relaxed.relaxed, true)
  assert.equal(relaxed.relaxation, 'challenge')
  assert.equal(relaxed.fallback, false)
  assert.deepEqual(relaxed.matches.map(n => n.key), ['fast'])
  const latencyOnly = run({ aiPlatforms: ['ChatGPT'], maxLatencyMs: 1, maxLossRate: .3, relaxWhenEmpty: true })
  assert.equal(latencyOnly.relaxation, 'latency')
  assert.deepEqual(latencyOnly.matches.map(n => n.key), ['smooth'])
  assert.equal(qualityReason(qualityPresets.ai.condition, { ...reading, lossRate: 2 / 3 }), 'loss')
  assert.deepEqual(run({ platforms: ['chatgptApp'], relaxWhenEmpty: true }).matches.map(n => n.key), ['fast'])
  const excluded = resolvePool(poolCondition({ quality: { alive: true } }), [...nodes, { ...node('omitted'), kept: false }], snapshot)
  assert.equal(excluded.stageCounts.source, nodes.length + 1)
  assert.equal(excluded.stageCounts.name, nodes.length)
  assert.equal(excluded.removed.find(r => r.node.key === 'omitted')?.reason, 'source')
  const fallback = run({ ...q, exitRegions: ['US'], relaxWhenEmpty: true, fallbackWhenEmpty: true })
  assert.equal(fallback.fallback, true)
  assert.equal(fallback.matches.length, 1)
  const guarded = run({ platforms: ['gemini'], minBandwidthMbps: 5000 }, { ...snapshot, config: { ai: false, bandwidth: false } })
  assert.deepEqual(guarded.matches, nodes)
  const ranked = run({ alive: true, sortBy: 'ChatGPT', topN: 1 })
  assert.deepEqual(ranked.matches.map(n => n.key), ['smooth'])
  assert.equal(ranked.stageCounts.limit, 1)
  assert.equal(ranked.removed.filter(r => r.reason === 'limit').length, ranked.passed.length - 1)
})

test('platform verdicts preserve confirmed entry evidence and rank usable platforms ahead of challenges', () => {
  const readingFor = (state: AiReading['state']): AiReading => ({
    state, evidence: 'unrecognized', httpStatus: null, needsReview: state === 'unknown' || state === 'challenge', providerRegion: null,
  })
  const ai = Object.fromEntries(surfaces.map(s => [s, readingFor('degraded_challenge')])) as AiResults
  const cases = [
    ['reachable', 'reachable', 'unlocked'], ['degraded_challenge', 'reachable', 'partial_unlock'],
    ['challenge', 'reachable', 'partial_unlock'], ['degraded_challenge', 'region_restricted', 'region_restricted'],
    ['unknown', 'region_restricted', 'region_restricted'], ['region_restricted', 'reachable', null],
    ['unknown', 'network_error', null], ['rate_limited', 'unavailable', null],
    ['ip_blocked', 'network_error', 'blocked_or_unreachable'],
  ] as const
  for (const [web, app, expected] of cases) {
    assert.equal(platformVerdict({ ...ai, chatgptWeb: readingFor(web), chatgptApp: readingFor(app) }, 'ChatGPT'), expected)
    assert.equal(platformVerdict({ ...ai, chatgptWeb: readingFor(app), chatgptApp: readingFor(web) }, 'ChatGPT'), expected)
  }
  const challenge: NodeQuality = { ...reading, platforms: { ChatGPT: 'degraded_challenge', Gemini: 'degraded_challenge', Antigravity: null } }
  const usable: NodeQuality = { ...reading, platforms: { ChatGPT: 'unlocked', Gemini: 'region_restricted', Antigravity: null } }
  const offline: NodeQuality = { ...usable, platforms: { ...usable.platforms!, Gemini: 'blocked_or_unreachable' } }
  assert.equal(qualityValue(usable, 'ai'), 3)
  assert.equal(qualityValue(challenge, 'ai'), 2)
  assert.ok(compareQuality(usable, challenge, 'ai') < 0)
  assert.ok(compareQuality(usable, challenge, 'ai', true) > 0)
  assert.ok(compareQuality(usable, offline, 'Gemini') < 0)
  const conflicting: NodeQuality = { ...reading, reachable: ['chatgptApp'], platforms: null, surfaceIssues: { chatgptWeb: 'region_restricted' } }
  assert.equal(qualityReason({ aiPlatforms: ['ChatGPT'], minUnlockLevel: 1, untestedPolicy: 'include' }, conflicting), 'platform')
  assert.equal(qualityReason({ platforms: ['chatgptApp'] }, conflicting), null)
})

test('exit region inference requires at least two agreeing surface measurements and never invents an IP', () => {
  const base: AiReading = { state: 'reachable', evidence: 'web_entry', needsReview: false, httpStatus: 200, providerRegion: null }
  const ai = Object.fromEntries(surfaces.map((s, index) => [s, { ...base, providerRegion: index < 2 ? 'SG' : null }])) as AiResults
  const row = { key: 'source01/quality01', name: 'A', sourceName: 'S', samples: [], available: true, error: null,
    tlsMedianMs: 20, httpsMedianMs: 150, jitterMs: 0, lossRate: 0, speed: null, ai, exit: null }
  const date = new Date().toISOString()
  const report: QualityReport = { jobId: randomUUID(), schemaVersion: 1, createdAt: date, startedAt: date, finishedAt: date, config: qualityDefaults, results: [row] }
  const snapshot = qualitySnapshot(report).rows[row.key]
  assert.equal(snapshot.exitRegion, 'SG')
  assert.equal(snapshot.exitRegionInferred, true)
  assert.equal(snapshot.ipStack, null)
  assert.equal(qualityReason({ exitRegions: ['SG'] }, snapshot), null)
  assert.equal(qualityReason({ exitRegions: ['SG'], excludeExitRegions: true }, snapshot), 'region')
  assert.equal(inferredExitRegion({ ...row, exit: { ip: '192.0.2.2', region: 'US' } }), null)
  assert.equal(inferredExitRegion({ ...row, lossRate: 2 / 3 }), null)
  assert.equal(inferredExitRegion({ ...row, ai: { ...ai, gemini: { ...base, providerRegion: 'TW' } } }), null)
  assert.equal(inferredExitRegion({ ...row, ai: { ...ai, chatgptWeb: base } }), null)
  assert.equal(inferredExitRegion({ ...row, ai: { ...ai, chatgptWeb: { ...ai.chatgptWeb, evidence: 'exit_region_fallback' } } }), null)
})

test('multi-check availability filters and availability sort handle Record<string, LatestNodeQuality> directly', () => {
  const deviceId = randomUUID()
  const now = new Date().toISOString()
  const mkLatest = (key: string, available: boolean, window: boolean[] | null): LatestNodeQuality => ({
    nodeKey: key,
    deviceId,
    basic: { available, httpsMs: available ? 40 : null, tlsMs: available ? 12 : null, jitterMs: 2, lossRate: available ? 0 : 1, exit: null, infoNode: false, error: available ? null : 'no_response', updatedAt: now },
    speed: null,
    ai: null,
    availability: window ? { window, total: window.length, success: window.filter(Boolean).length, rate: window.length ? window.filter(Boolean).length / window.length : 0, updatedAt: now } : null,
  })
  const latestMap: Record<string, LatestNodeQuality> = {
    's1/n_high_down': mkLatest('s1/n_high_down', false, [true, true, true, true, false, true, true, true, true, true]), // 0.9
    's1/n_mid_up': mkLatest('s1/n_mid_up', true, [true, true, true, true, false]), // 0.8
    's1/n_low_up': mkLatest('s1/n_low_up', true, [true, false, false, false]), // 0.25
    's1/n_untested': { nodeKey: 's1/n_untested', deviceId, basic: null, speed: null, ai: null, availability: null },
  }
  const nodes = Object.keys(latestMap).map(key => ({ key, name: key, region: 'JP', sourceId: 's1', kept: true }))

  const res = resolvePool(poolCondition({ quality: { minAvailability: 0.8, sortBy: 'availability' } }), nodes, latestMap)
  assert.deepEqual(res.matches.map(n => n.key), ['s1/n_high_down', 's1/n_mid_up'])
  assert.deepEqual(res.reasons, { availability: 1, untested: 1 })

  const rev = resolvePool(poolCondition({ quality: { minAvailability: 0.8, sortBy: 'availability', sortReverse: true } }), nodes, latestMap)
  assert.deepEqual(rev.matches.map(n => n.key), ['s1/n_mid_up', 's1/n_high_down'])

  const aliveRes = resolvePool(poolCondition({ quality: { alive: true, minAvailability: 0.8 } }), nodes, latestMap)
  assert.deepEqual(aliveRes.matches.map(n => n.key), ['s1/n_mid_up'])
  assert.equal(aliveRes.reasons.unavailable, 1)

  const availAndLatency = resolvePool(poolCondition({ quality: { minAvailability: 0.8, maxLatencyMs: 250, untestedPolicy: 'include' } }), nodes, latestMap)
  assert.deepEqual(availAndLatency.matches.map(n => n.key), ['s1/n_mid_up', 's1/n_untested'])
  assert.deepEqual(availAndLatency.untested, ['s1/n_untested'])
  assert.equal(availAndLatency.reasons.unavailable, 1)

  const relaxedAvailAndLatency = resolvePool(
    poolCondition({ quality: { minAvailability: 0.8, maxLatencyMs: 250, relaxWhenEmpty: true } }),
    [nodes[0], nodes[3]],
    latestMap,
  )
  assert.equal(relaxedAvailAndLatency.relaxation, 'latency')
  assert.deepEqual(relaxedAvailAndLatency.matches.map(n => n.key), ['s1/n_high_down'])
})

test('per-group qualityDeviceId isolation, refreshQuality auto-versioning, clone clearing, and backup exclusion work end-to-end', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-quality-release-'))
  const store = openStore(dir)
  const work = createWorkspace({ store, verify: async () => null, remote: { allowPrivate: true }, tickMs: 0 })
  t.after(async () => { await work.stop(); store.close(); await rm(dir, { recursive: true, force: true }) })
  const initial = work.state()
  const names = ['A', 'B']
  const upstream = createServer((_, res) => res.end(JSON.stringify({ proxies: names.map((name, i) => ({ name, type: 'http', server: 'node.example', port: 8000 + i })) })))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  const url = 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port + '/nodes'
  const source = { id: 'source01', name: '源', url, tag: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }
  const deviceA = randomUUID()
  const deviceB = randomUUID()
  const groupA = { id: 'qualityA', name: '探针A组', type: 'select' as const, enabled: true, qualityDeviceId: deviceA, members: [poolCondition({ quality: { maxLatencyMs: 200, minAvailability: 0.7 } })] }
  const groupB = { id: 'qualityB', name: '探针B组', type: 'select' as const, enabled: true, qualityDeviceId: deviceB, members: [poolCondition({ quality: { maxLatencyMs: 200, aiAll: true } })] }
  const groupUnbound = { id: 'qualityU', name: '未绑定组', type: 'select' as const, enabled: false, qualityDeviceId: null, members: [poolCondition({ quality: { maxLatencyMs: 200 } })] }
  await work.probe(initial.id, 'test', { id: source.id, kind: 'source', url })
  const state = await work.saveDraft(initial.id, 'test', { revision: initial.revision, draft: { ...initial.draft, sources: [source], groups: [groupA, groupB, groupUnbound] } })
  const keys = state.sources[source.id].good!.nodes.map(n => source.id + '/' + n.id)
  const profile = work.profileFor(state.id)
  const space = qualitySpaces(profile.id)
  const now = new Date().toISOString()
  const okAi = Object.fromEntries(surfaces.map(s => [s, {
    state: 'reachable', evidence: 'web_entry', httpStatus: 200, providerRegion: 'SG', needsReview: false,
  }])) as AiResults

  function seedLatest(deviceId: string, delays: number[], withAi: boolean[]) {
    for (const [i, delay] of delays.entries()) {
      const rec: LatestNodeQuality = {
        nodeKey: keys[i],
        deviceId,
        basic: { available: true, httpsMs: delay, tlsMs: 20, jitterMs: 1, lossRate: 0, exit: null, infoNode: false, error: null, updatedAt: now },
        speed: null,
        ai: withAi[i] ? { results: okAi, updatedAt: now } : null,
        availability: { window: [true, true, true, true], total: 4, success: 4, rate: 1, updatedAt: now },
      }
      store.set(space.latest, `${deviceId}/${keys[i]}`, rec)
    }
  }

  // Probe A favors node A (100ms vs 350ms), Probe B favors node B with AI (300ms vs 50ms)
  seedLatest(deviceA, [100, 350], [false, false])
  seedLatest(deviceB, [300, 50], [false, true])

  const checked = await work.check(state.id)
  assert.deepEqual(checked.groups.find(g => g.id === groupA.id)!.members.map(m => m.name), ['A'])
  assert.deepEqual(checked.groups.find(g => g.id === groupB.id)!.members.map(m => m.name), ['B'])
  // Disabled unbound group emits no group-quality-device warning
  assert.equal(checked.issues.some(i => i.code === 'group-quality-device'), false)

  // Enabling an unbound group emits non-blocking warning and treats all nodes as untested
  const unboundEnabledEval = evaluate(
    { ...state.draft, groups: state.draft.groups.map(g => g.id === groupUnbound.id ? { ...g, enabled: true } : g) },
    { [source.id]: state.sources[source.id].good },
    {},
    false,
    { [deviceA]: { [keys[0]]: store.get(space.latest, `${deviceA}/${keys[0]}`)! } } satisfies LatestQualityMap,
  )
  assert.ok(unboundEnabledEval.issues.some(i => i.severity === 'warning' && i.code === 'group-quality-device' && i.id === groupUnbound.id))
  assert.deepEqual(unboundEnabledEval.groups.find(g => g.id === groupUnbound.id)!.members, [])

  const published = await work.publish(state.id, state.revision)
  const v1 = work.activeVersion(work.profileFor(state.id))!
  assert.equal(v1.seq, 1)
  assert.deepEqual(v1.view.groups.find(g => g.id === groupA.id)!.members.map(m => m.name), ['A'])
  assert.deepEqual(v1.view.groups.find(g => g.id === groupB.id)!.members.map(m => m.name), ['B'])
  assert.equal(Object.hasOwn(published.current!, 'qualityReportId'), false)
  assert.equal(Object.hasOwn(published.current!, 'qualityDeviceId'), false)
  assert.ok(!('qualitySnapshot' in work.history(state.id, 0)[0]))

  // refreshQuality() is a no-op when new quality measurements produce identical YAML
  seedLatest(deviceA, [120, 350], [false, false])
  await work.refreshQuality(state.id)
  assert.equal(work.activeVersion(work.profileFor(state.id))!.seq, v1.seq)

  // refreshQuality() publishes 'auto' version (parent: v1.seq) when YAML changes and updates /sub/${token}
  seedLatest(deviceA, [320, 80], [false, false])
  await work.refreshQuality(state.id)
  const v2 = work.activeVersion(work.profileFor(state.id))!
  assert.equal(v2.kind, 'auto')
  assert.equal(v2.parent, v1.seq)
  assert.deepEqual(v2.view.groups.find(g => g.id === groupA.id)!.members.map(m => m.name), ['B'])
  assert.equal(work.subscription(work.profileFor(state.id).token!), v2.yaml)

  // Rollback skips refreshQuality() auto-updates
  await work.rollback(state.id, v1.seq)
  const vRollback = work.activeVersion(work.profileFor(state.id))!
  seedLatest(deviceA, [80, 320], [false, false])
  await work.refreshQuality(state.id)
  assert.equal(work.activeVersion(work.profileFor(state.id))!.seq, vRollback.seq)

  // Clone clears qualityDeviceId on cloned groups
  const cloned = await work.profiles(state.id, { action: 'clone', title: 'Clone' })
  assert.equal(cloned.draft.groups.every(g => g.qualityDeviceId == null), true)
  const otherCheck = await work.check(cloned.id)
  assert.ok(otherCheck.issues.some(i => i.code === 'group-quality-device'))

  // Backup export/import succeeds with populated quality-latest/* and preserves Group.qualityDeviceId & quality conditions
  const password = 'quality fixture passphrase'
  const exported = exportBackup(store, password)
  await restoreBackup(work, exported, password, async () => null)
  const restoredProfile = work.profileFor(state.id)
  assert.equal(restoredProfile.draft.groups[0].qualityDeviceId, deviceA)
  assert.equal((restoredProfile.draft.groups[0].members[0] as { quality?: { minAvailability?: number } }).quality?.minAvailability, 0.7)
  assert.equal(store.list(space.latest).length, 0)
})
