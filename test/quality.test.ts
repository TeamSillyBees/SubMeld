import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Impit } from 'impit'
import { classify, googleRegion, inspectPlatforms, verifyGemini } from '../agent/ai.ts'
import { parsePairing } from '../agent/client.ts'
import { summarize } from '../agent/measure.ts'
import { createQualityService, qualitySpaces } from '../server/quality.ts'
import { openStore } from '../server/store.ts'
import { qualityDefaults, type QualityRow } from '../shared/quality.ts'
import type { Profile } from '../shared/model.ts'

test('quality jobs bind a single worker to an immutable selection, expire safely and preserve idempotent completion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-quality-test-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const profile = { id: randomUUID() } as Profile
  const nodes = Array.from({ length: 211 }, (_, i) => ({
    key: profile.id + '/' + String(i).padStart(8, '0'), name: '节点 ' + i, sourceName: '测试源',
    connection: { type: 'http', server: 'localhost', port: 1, password: 'private-fixture-password' },
  }))
  let clock = Date.now()
  const service = createQualityService(store, (_, keys) => nodes.filter(n => keys.has(n.key)), () => clock)
  const config = { ...qualityDefaults, ai: false }
  const make = () => service.create(profile, { keys: nodes.map(n => n.key), config }, 'https://submeld.test')
  assert.throws(() => service.create(profile, { keys: [nodes[0].key], config }, 'http://public.example'), /HTTPS/)
  const first = make()
  assert.equal(first.job.total, 211)
  assert.throws(make)
  assert.throws(() => service.create(profile, { keys: [], config }, 'https://submeld.test'))
  assert.throws(() => service.create(profile, { keys: [nodes[0].key], config: { ...config, concurrency: 1000 } }, 'https://submeld.test'))
  const body = { profileId: profile.id, jobId: first.job.id, worker: randomBytes(32).toString('base64url') }
  const token = parsePairing(service.pair(profile.id, first.job.id, 'https://submeld.test').pairing).ticket
  assert.throws(() => service.agent('claim', parsePairing(first.pairing).ticket, body))
  assert.equal(JSON.stringify(store.all()).includes(token), false)
  assert.deepEqual(service.agent('claim', token, body), { schemaVersion: 1, jobId: first.job.id, createdAt: first.job.createdAt, config, nodes })
  assert.ok(service.agent('claim', token, body))
  assert.throws(() => service.agent('claim', token, { ...body, worker: randomBytes(32).toString('base64url') }))
  assert.ok(!JSON.stringify(service.list(profile.id)).includes('private-fixture-password'))
  service.agent('progress', body.worker, { ...body, progress: { stage: 'latency', done: 8, total: 211 } })
  assert.equal(store.get(qualitySpaces(profile.id).inputs, first.job.id), null)
  assert.throws(() => service.agent('claim', token, body))
  assert.throws(() => service.agent('complete', token, body))
  const samples = Array.from({ length: config.rounds }, () => ({ tlsMs: 10, httpsMs: 50 }))
  const results: QualityRow[] = nodes.map(({ key }) => ({ key, samples, ...summarize(samples), error: null, exit: { ip: '192.0.2.2', region: 'JP' }, speed: null, ai: null }))
  const report = { schemaVersion: 1, jobId: body.jobId, startedAt: first.job.createdAt, finishedAt: first.job.createdAt, results }
  assert.throws(() => service.agent('complete', body.worker, { ...body, report: { ...report, results: results.slice(1) } }))
  assert.throws(() => service.agent('complete', body.worker, { ...body, report: { ...report, results: [...results.slice(1), results[1]] } }))
  for (let i = 0; i < 2; i++) assert.deepEqual(service.agent('complete', body.worker, { ...body, report }), { ok: true })
  assert.equal(service.list(profile.id)[0].available, 211)
  assert.equal(service.report(profile.id, first.job.id).results[210].name, nodes[210].name)
  assert.throws(() => service.report(randomUUID(), first.job.id))
  clock += 1000
  const cancelled = make()
  service.cancel(profile.id, cancelled.job.id)
  assert.throws(() => service.agent('claim', parsePairing(cancelled.pairing).ticket, { ...body, jobId: cancelled.job.id }))
  const abandoned = make()
  clock += 15 * 60_000
  assert.equal(service.list(profile.id).find(j => j.id === abandoned.job.id)?.status, 'expired')
  assert.equal(store.get(qualitySpaces(profile.id).inputs, abandoned.job.id), null)
  const stale = make()
  service.agent('claim', parsePairing(stale.pairing).ticket, { ...body, jobId: stale.job.id })
  clock += 120_001
  assert.equal(service.list(profile.id)[0].failure, 'disconnected')
})
test('measurements distinguish warm handshake success, request loss and insufficient jitter samples', () => {
  const s = summarize([{ tlsMs: 4, httpsMs: 60 }, { tlsMs: 12, httpsMs: null }, { tlsMs: 6, httpsMs: 80 }, { tlsMs: 8, httpsMs: 70 }])
  assert.deepEqual(s, { available: true, tlsMedianMs: 7, httpsMedianMs: 70, jitterMs: 15, lossRate: .25 })
  assert.equal(summarize([{ tlsMs: null, httpsMs: null }]).jitterMs, null)
})
test('public platform evidence distinguishes challenge, region, IP ban, login and ambiguous responses', () => {
  const page = (status: number, body = '', location = '', challenge = false) => ({ status, body, location, challenge })
  assert.equal(classify('grok', page(403, 'Access denied')).state, 'unknown')
  assert.equal(classify('grok', page(403, 'Your IP address has been banned')).state, 'ip_blocked')
  assert.equal(classify('grok', page(403, '', '', true)).state, 'challenge')
  assert.equal(classify('grok', page(403, 'Not available in your country')).state, 'region_restricted')
  assert.equal(classify('grok', page(429)).state, 'rate_limited')
  assert.equal(classify('chatgptWeb', page(200, '<title>ChatGPT</title><script>const message="not available in your country"</script>')).state, 'reachable')
  assert.equal(classify('grok', page(200, '<title>Access denied | Grok</title>')).needsReview, true)
  assert.equal(classify('chatgptApp', page(404)).needsReview, true)
  assert.equal(classify('claudeApi', page(401, '{"error":{"type":"authentication_error"}}')).state, 'authentication')
  assert.equal(classify('claudeWeb', page(302, '', 'https://unknown.example/login')).state, 'unknown')
  const gemini = classify('gemini', page(200, '<title>Gemini</title>'))
  const country = googleRegion('{"INNERTUBE_CONTEXT":{"client":{"hl":"en","gl":"CN"}}}')
  assert.equal(verifyGemini(gemini, 'JP', country).state, 'region_mismatch')
  assert.equal(verifyGemini(gemini, 'CN', 'CN').needsReview, true)
  assert.equal(verifyGemini(gemini, 'JP', null).state, 'unknown')
  assert.equal(verifyGemini(gemini, 'HK', 'HK').state, 'reachable')
  assert.throws(() => parsePairing('http://public.example/#a'))
})

test('the browser-protocol probe collects separate surface evidence and verifies the Google region', async t => {
  const edge = http.createServer((req, res) => {
    const host = new URL(req.url!, 'http://fixture.invalid').pathname.slice(1)
    if (host === 'www.youtube.com') res.end('{"INNERTUBE_CONTEXT_GL":"CN"}')
    else if (host === 'grok.com') res.writeHead(403, { 'cf-mitigated': 'challenge' }).end('challenge')
    else if (host === 'api.anthropic.com') res.writeHead(401).end('{"error":{"type":"authentication_error"}}')
    else if (host === 'android.chat.openai.com') res.writeHead(403).end('{"error":{"code":"unsupported_country_region_territory"}}')
    else if (host === 'claude.ai') res.writeHead(302, { location: '/login' }).end()
    else res.end('<title>' + (host === 'chatgpt.com' ? 'ChatGPT' : 'Gemini') + '</title>')
  })
  edge.listen(0, '127.0.0.1')
  await once(edge, 'listening')
  t.after(() => { edge.closeAllConnections(); return new Promise<void>(done => edge.close(() => done())) })
  // Retain the native browser client's actual streams, proxy handling, headers and cancellation.
  const fetch = Impit.prototype.fetch
  t.mock.method(Impit.prototype, 'fetch', function (this: Impit, input: string, init: Parameters<typeof fetch>[1]) {
    return fetch.call(this, 'http://fixture.invalid/' + new URL(input).hostname, init)
  })
  const ai = await inspectPlatforms({ port: (edge.address() as AddressInfo).port, password: 'fixture' }, 'JP', new AbortController().signal)
  assert.equal(ai.chatgptWeb.state, 'reachable')
  assert.equal(ai.chatgptApp.state, 'region_restricted')
  assert.equal(ai.gemini.state, 'region_mismatch')
  assert.equal(ai.gemini.providerRegion, 'CN')
  assert.equal(ai.claudeWeb.evidence, 'login_redirect')
  assert.equal(ai.claudeApi.state, 'authentication')
  assert.equal(ai.grok.state, 'challenge')
})
