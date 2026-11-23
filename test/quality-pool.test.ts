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
import { poolCondition, resolvePool } from '../shared/group-filter.ts'
import { compareQuality, qualitySnapshot, qualityValue, type NodeQuality } from '../shared/quality-snapshot.ts'
import { qualityDefaults, type QualityReport } from '../shared/quality.ts'
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
  assert.equal(qualityValue(reading, 'ai'), 1.5)
  assert.equal(qualityValue(reading, 'ChatGPT'), .5)
  assert.ok(compareQuality(reading, snapshot.rows.slow, 'loss') < 0)
  assert.ok(compareQuality(reading, snapshot.rows.partial, 'speed') < 0)
  assert.ok(compareQuality(snapshot.rows.failed, undefined, 'tls') < 0)
  assert.ok(compareQuality(reading, { ...reading, reachable: null }, 'Grok') < 0)
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
  function report(delays: number[]): QualityReport {
    const date = new Date().toISOString()
    return { schemaVersion: 1, jobId: randomUUID(), createdAt: date, startedAt: date, finishedAt: date, config: qualityDefaults,
      results: delays.map((delay, i) => ({ key: keys[i], name: String(i), sourceName: source.name, available: true, error: null,
        httpsMedianMs: delay, tlsMedianMs: 20, lossRate: 0, jitterMs: null, speed: null, ai: null, samples: [], exit: null })) }
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
  const password = 'quality fixture passphrase'
  await restoreBackup(work, exportBackup(store, password), password, async () => null)
  assert.deepEqual(work.snapshotFor(work.profileFor(state.id), undefined), qualitySnapshot(one))
})
