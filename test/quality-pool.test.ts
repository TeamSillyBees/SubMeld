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
import { poolCondition, qualityPresets, qualityReason, resolvePool } from '../shared/group-filter.ts'
import { compareQuality, inferredExitRegion, platformVerdict, qualitySnapshot, qualityValue, type NodeQuality, type QualitySnapshot } from '../shared/quality-snapshot.ts'
import { qualityDefaults, surfaces, type AiReading, type AiResults, type QualityReport } from '../shared/quality.ts'
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
  assert.equal(qualityValue({ ...reading, platforms: { ChatGPT: null, Claude: null, Grok: 'blocked_or_unreachable', Gemini: null } }, 'ai'), -1)
  assert.ok(compareQuality(reading, snapshot.rows.slow, 'loss') < 0)
  assert.ok(compareQuality(reading, snapshot.rows.partial, 'speed') < 0)
  assert.ok(compareQuality(snapshot.rows.failed, undefined, 'tls') > 0)
  assert.equal(compareQuality(reading, { ...reading, reachable: null }, 'Grok'), 0)
})

test('fixed buckets, cascade ties, capability guards and two-tier fallbacks also apply to ranked group output', () => {
  const node = (key: string) => ({ key, name: key, kept: true, region: 'TW', sourceId: 'source01' })
  const snapshot: QualitySnapshot = { reportId: randomUUID(), config: { ai: true, bandwidth: false }, rows: {
    fast: { ...reading, jitterMs: 2, exitRegion: 'HK', surfaceIssues: { chatgptApp: 'degraded_challenge' }, platforms: { ChatGPT: 'degraded_challenge', Claude: null, Grok: null, Gemini: 'unlocked' } },
    smooth: { ...reading, jitterMs: 1, exitRegion: 'TW', platforms: { ChatGPT: 'partial_unlock', Claude: 'unlocked', Grok: null, Gemini: null } },
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
  const guarded = run({ platforms: ['grok'], minBandwidthMbps: 5000 }, { ...snapshot, config: { ai: false, bandwidth: false } })
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
  for (const [web, api, expected] of cases) {
    assert.equal(platformVerdict({ ...ai, claudeWeb: readingFor(web), claudeApi: readingFor(api) }, 'Claude'), expected)
    assert.equal(platformVerdict({ ...ai, claudeWeb: readingFor(api), claudeApi: readingFor(web) }, 'Claude'), expected)
  }
  const challenge: NodeQuality = { ...reading, platforms: { ChatGPT: 'degraded_challenge', Claude: 'degraded_challenge', Grok: 'degraded_challenge', Gemini: 'degraded_challenge' } }
  const usable: NodeQuality = { ...reading, platforms: { ChatGPT: 'unlocked', Claude: 'region_restricted', Grok: 'region_restricted', Gemini: 'region_restricted' } }
  const offline: NodeQuality = { ...usable, platforms: { ...usable.platforms!, Grok: 'blocked_or_unreachable' } }
  assert.equal(qualityValue(usable, 'ai'), 3)
  assert.equal(qualityValue(challenge, 'ai'), 4)
  assert.ok(compareQuality(usable, challenge, 'ai') < 0)
  assert.ok(compareQuality(usable, challenge, 'ai', true) > 0)
  assert.ok(compareQuality(usable, offline, 'Grok') < 0)
  const conflicting: NodeQuality = { ...reading, reachable: ['claudeApi'], platforms: null, surfaceIssues: { claudeWeb: 'region_restricted' } }
  assert.equal(qualityReason({ aiPlatforms: ['Claude'], minUnlockLevel: 1, untestedPolicy: 'include' }, conflicting), 'platform')
  assert.equal(qualityReason({ platforms: ['claudeApi'] }, conflicting), null)
})

test('exit region inference requires at least four agreeing surface measurements and never invents an IP', () => {
  const base: AiReading = { state: 'reachable', evidence: 'web_entry', needsReview: false, httpStatus: 200, providerRegion: null }
  const ai = Object.fromEntries(surfaces.map((s, index) => [s, { ...base, providerRegion: index < 4 ? 'SG' : null }])) as AiResults
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
  assert.equal(inferredExitRegion({ ...row, ai: { ...ai, grok: { ...base, providerRegion: 'TW' } } }), null)
  assert.equal(inferredExitRegion({ ...row, ai: { ...ai, chatgptWeb: base } }), null)
  assert.equal(inferredExitRegion({ ...row, ai: { ...ai, chatgptWeb: { ...ai.chatgptWeb, evidence: 'exit_region_fallback' } } }), null)
})

test('previews and releases bind the specified report, remain isolated by profile, and restore pinned results after pruning', async t => {
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
  const group = { id: 'quality01', name: '质量池', type: 'select' as const, enabled: true, members: [poolCondition({ quality: { maxLatencyMs: 200 } })] }
  await work.probe(initial.id, 'test', { id: source.id, kind: 'source', url })
  const state = await work.saveDraft(initial.id, 'test', { revision: initial.revision, draft: { ...initial.draft, sources: [source], groups: [group] } })
  const keys = state.sources[source.id].good!.nodes.map(n => source.id + '/' + n.id)
  const profile = work.profileFor(state.id)
  const space = qualitySpaces(profile.id)
  const regionalAi = Object.fromEntries(surfaces.map(s => [s, {
    state: 'network_error', evidence: 'network', httpStatus: null, providerRegion: s === 'gemini' ? null : 'SG', needsReview: false,
  }])) as AiResults
  function report(delays: number[]): QualityReport {
    const date = new Date().toISOString()
    return { schemaVersion: 1, jobId: randomUUID(), createdAt: date, startedAt: date, finishedAt: date, config: qualityDefaults,
      results: delays.map((delay, i) => ({ key: keys[i], name: String(i), sourceName: source.name, available: true, error: null,
        httpsMedianMs: delay, tlsMedianMs: 20, lossRate: 0, jitterMs: null, speed: null, ai: i === 0 ? regionalAi : null, samples: [], exit: null })) }
  }
  const one = report([100, 350]), two = report([300, 50])
  store.set(space.reports, one.jobId, one)
  const first = await work.publish(state.id, state.revision, one.jobId)
  assert.equal(first.current!.qualityReportId, one.jobId)
  const frozen = work.activeVersion(work.profileFor(state.id))!
  assert.deepEqual(frozen.view.groups[0].members.map(m => m.name), ['A'])
  store.set(space.reports, two.jobId, two)
  assert.deepEqual((await work.check(state.id, two.jobId)).groups[0].members.map(m => m.name), ['B'])
  assert.equal(work.activeVersion(work.profileFor(state.id))!.yaml, frozen.yaml)
  const other = await work.profiles(state.id, { action: 'create', title: '其他' })
  assert.throws(() => work.check(other.id, two.jobId), /移出历史/)
  store.set(space.jobs, two.jobId, { id: two.jobId, targetDeviceId: null, createdAt: two.createdAt, expiresAt: two.finishedAt, finishedAt: two.finishedAt, status: 'completed',
    total: 2, available: 2, failure: null, config: two.config, progress: { stage: 'uploading', done: 2, total: 2 }, labels: [], ticketHash: null, workerHash: null })
  store.remove(space.reports, one.jobId)
  names.push('C')
  await work.refresh(state.id, { kind: 'source', id: source.id })
  for (let i = 0; i < 100 && work.state(state.id).current?.seq === frozen.seq; i++) await wait(20)
  const refreshed = work.activeVersion(work.profileFor(state.id))!
  assert.equal(refreshed.kind, 'auto')
  assert.equal(refreshed.qualityReportId, one.jobId)
  assert.deepEqual(refreshed.view.groups[0].members.map(n => n.name), ['A'])
  const second = await work.publish(state.id, state.revision, two.jobId)
  assert.equal(second.current!.qualityReportId, two.jobId)
  store.remove(space.reports, one.jobId)
  await work.rollback(state.id, frozen.seq)
  const restored = work.activeVersion(work.profileFor(state.id))!
  assert.equal(restored.qualityReportId, one.jobId)
  assert.deepEqual(work.snapshotFor(work.profileFor(state.id), one.jobId), qualitySnapshot(one))
  assert.equal(restored.yaml, frozen.yaml)
  assert.ok(!('qualitySnapshot' in work.history(state.id, 0)[0]))
  const strict = await work.check(state.id, null)
  assert.ok(strict.issues.some(i => i.code === 'pool-quality-empty' && i.severity === 'warning'))
  assert.ok(strict.issues.some(i => i.code === 'group-empty' && i.severity === 'error'))
  const device = randomUUID()
  const currentJob = store.get(space.jobs, two.jobId)!
  const publishReading = (from: string, delays: number[], time: number) => {
    const data = { ...report(delays), targetDeviceId: from, targetDeviceName: '测试机', finishedAt: new Date(time).toISOString() }
    store.set(space.reports, data.jobId, data)
    store.set(space.jobs, data.jobId, { ...currentJob, targetDeviceId: from, id: data.jobId, finishedAt: data.finishedAt })
    return data
  }
  const now = Date.now()
  const followed = publishReading(device, [230, 75], now)
  const scoped = await work.saveDraft(state.id, 'test', { revision: state.revision, draft: { ...state.draft, qualityBaselinePolicy: { mode: 'device', deviceId: device } } })
  assert.equal(work.snapshotFor(work.profileFor(state.id))!.reportId, followed.jobId)
  publishReading(randomUUID(), [10, 400], now + 100)
  assert.throws(() => work.check(state.id, undefined, two.jobId), /基准已更新/)
  await work.publish(state.id, scoped.revision, undefined, followed.jobId)
  const newest = publishReading(device, [100, 450], now + 200)
  await work.refreshQuality(state.id)
  const active = work.activeVersion(work.profileFor(state.id))!
  assert.equal(active.qualityReportId, newest.jobId)
  assert.deepEqual(active.view.groups[0].members.map(m => m.name), ['A'])
  assert.equal(work.subscription(work.profileFor(state.id).token!), active.yaml)
  publishReading(device, [950, 950], now + 300)
  await work.refreshQuality(state.id)
  assert.equal(work.activeVersion(work.profileFor(state.id))!.seq, active.seq)
  const pinned = await work.saveDraft(state.id, 'test', { revision: scoped.revision, draft: { ...scoped.draft, qualityBaselinePolicy: { mode: 'fixed', reportId: followed.jobId } } })
  assert.deepEqual((await work.check(state.id)).groups[0].members.map(m => m.name), ['B'])
  await work.publish(state.id, pinned.revision)
  await work.refreshQuality(state.id)
  assert.equal(work.activeVersion(work.profileFor(state.id))!.qualityReportId, followed.jobId)
  await work.rollback(state.id, active.seq)
  const password = 'quality fixture passphrase'
  await restoreBackup(work, exportBackup(store, password), password, async () => null)
  assert.deepEqual(work.snapshotFor(work.profileFor(state.id), undefined), qualitySnapshot(followed))
  assert.equal(work.snapshotFor(work.profileFor(state.id))!.rows[keys[0]].exitRegionInferred, true)
  assert.deepEqual(work.snapshotFor(work.profileFor(state.id), newest.jobId), qualitySnapshot(newest))
})
