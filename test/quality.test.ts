import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Impit } from 'impit'
import { classify, googleRegion, inspectPlatforms, verifyGemini } from '../agent/ai.ts'
import { parseInvite } from '../agent/device.ts'
import { summarize } from '../agent/measure.ts'
import { createQualityService, qualitySpaces } from '../server/quality.ts'
import { openStore } from '../server/store.ts'
import { qualityDefaults, type Assignment, type QualityRow } from '../shared/quality.ts'
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
  // Upgrade fixture: one-shot assignments created before device targeting may finish with their original ticket.
  const spaces = qualitySpaces(profile.id)
  const make = () => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url')
    const job = { id, createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 900000).toISOString(),
      finishedAt: null, status: 'waiting' as const, total: nodes.length, config, progress: { stage: 'starting' as const, done: 0, total: nodes.length },
      available: null, failure: null, ticketHash: createHash('sha256').update(token).digest('hex'), workerHash: null, labels: nodes.map(({ key, name, sourceName }) => ({ key, name, sourceName })) }
    store.set(spaces.jobs, id, job)
    store.set(spaces.inputs, id, nodes)
    return { job, pairing: 'https://submeld.test/#' + profile.id + '.' + id + '.' + token }
  }
  const first = make()
  assert.equal(first.job.total, 211)
  const body = { profileId: profile.id, jobId: first.job.id, worker: randomBytes(32).toString('base64url') }
  const parsePairing = (link: string) => ({ ticket: new URL(link).hash.split('.').at(-1)! })
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
  assert.equal(service.list(profile.id).find(j => j.id === stale.job.id)?.failure, 'disconnected')
})
test('a paired PC claims queued jobs across disconnects and loses access immediately when unpaired', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-device-test-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const profile = { id: randomUUID() } as Profile
  const node = { key: profile.id + '/node0001', name: '测试节点', sourceName: '本地', connection: { type: 'http', server: 'localhost', port: 1 } }
  let clock = Date.now()
  const service = createQualityService(store, () => [node], () => clock)
  const credential = () => randomBytes(32).toString('base64url')
  const origin = 'https://submeld.test'
  const secret = credential()
  const worker = credential()
  const request = { profileId: profile.id, worker }
  const enrollment = { profileId: profile.id, name: 'Desk PC', platform: 'windows', secret }
  const invite = () => parseInvite(service.invite(profile.id, origin).pairing).ticket
  const queue = (id: string) => service.queue(profile, { keys: [node.key], config: qualityDefaults, targetDeviceId: id })
  assert.throws(() => service.invite(profile.id, 'http://submeld.test'), /HTTPS/)
  assert.throws(() => service.queue(profile, { keys: [node.key], config: qualityDefaults }))
  const expired = invite()
  clock += 16 * 60_000
  assert.equal(service.list(profile.id).length, 0)
  assert.throws(() => service.agent('enroll', expired, enrollment))
  const replaced = invite()
  const ticket = invite()
  assert.throws(() => service.agent('enroll', replaced, enrollment))
  assert.throws(() => service.agent('enroll', ticket, { ...enrollment, profileId: randomUUID() }))
  for (let i = 0; i < 2; i++) assert.deepEqual(service.agent('enroll', ticket, enrollment), { ok: true })
  assert.throws(() => service.agent('enroll', ticket, { ...enrollment, secret: credential() }))
  const firstId = service.devices(profile.id)[0].id
  const otherSecret = credential()
  service.agent('enroll', invite(), { ...enrollment, secret: otherSecret, name: 'Lab PC' })
  const secondId = service.devices(profile.id).find(d => d.id !== firstId)!.id
  service.rename(profile.id, firstId, 'Desk')
  const first = queue(firstId)
  assert.equal(first.targetDeviceName, 'Desk')
  assert.throws(() => queue(firstId))
  assert.throws(() => service.pair(profile.id, first.id, origin))
  assert.equal(service.agent('poll', otherSecret, request), null)
  service.reassign(profile.id, first.id, secondId)
  assert.equal(service.agent('poll', secret, request), null)
  service.reassign(profile.id, first.id, firstId)
  assert.throws(() => service.reassign(randomUUID(), first.id, firstId))
  assert.throws(() => service.agent('poll', secret, { ...request, profileId: randomUUID() }))
  assert.ok(!JSON.stringify(store.all()).includes(secret))
  assert.ok(!JSON.stringify(store.all()).includes(ticket))
  for (let i = 0; i < 2; i++) assert.equal((service.agent('poll', secret, request) as Assignment).jobId, first.id)
  assert.equal(service.agent('poll', secret, { ...request, worker: credential() }), null)
  assert.equal(service.devices(profile.id).find(d => d.id === firstId)?.status, 'busy')
  assert.throws(() => service.reassign(profile.id, first.id, secondId))
  const progress = { ...request, jobId: first.id, progress: { stage: 'starting', done: 0, total: 1 } }
  clock += 60_000
  service.agent('progress', worker, progress)
  assert.equal(store.get(qualitySpaces(profile.id).inputs, first.id), null)
  assert.equal(service.agent('poll', secret, request), null)
  assert.equal(service.devices(profile.id).find(d => d.id === firstId)?.lastSeenAt, new Date(clock).toISOString())
  clock += 125_000
  assert.equal(service.devices(profile.id).find(d => d.id === firstId)?.status, 'offline')
  assert.equal(service.list(profile.id)[0].failure, 'disconnected')
  assert.equal(service.agent('poll', secret, request), null)
  const next = queue(firstId)
  assert.throws(() => service.reassign(profile.id, next.id, secondId))
  assert.equal((service.agent('poll', secret, request) as Assignment).jobId, next.id)
  service.agent('leave', secret, request)
  assert.deepEqual(service.devices(profile.id).map(d => d.id), [secondId])
  assert.equal(service.list(profile.id)[0].status, 'cancelled')
  assert.throws(() => service.agent('poll', secret, request))
  assert.throws(() => service.agent('progress', worker, { ...progress, jobId: next.id }))
  assert.throws(() => service.agent('enroll', ticket, enrollment))
  const offline = queue(secondId)
  clock += 24 * 60 * 60_000
  assert.equal(service.list(profile.id).find(job => job.id === offline.id)?.status, 'expired')
  assert.equal(store.get(qualitySpaces(profile.id).inputs, offline.id), null)
})

test('upgraded devices keep their credentials and legacy waiting jobs require a deliberate assignment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-probe-migration-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const profileId = randomUUID(), id = randomUUID(), secret = randomBytes(32).toString('base64url')
  const spaces = qualitySpaces(profileId)
  const time = new Date().toISOString()
  const node = { key: profileId + '/node0001', name: 'A', sourceName: '旧方案', connection: { type: 'http', server: 'localhost', port: 1 } }
  store.set(spaces.device, 'registration', { name: '旧探针', platform: 'linux', lastSeen: time, secretHash: createHash('sha256').update(secret).digest('hex') })
  store.set(spaces.device, 'next', id)
  store.set(spaces.jobs, id, { id, createdAt: time, expiresAt: new Date(Date.now() + 60000).toISOString(), finishedAt: null,
    status: 'waiting', config: qualityDefaults, total: 1, progress: { stage: 'starting', done: 0, total: 1 }, available: null,
    failure: null, ticketHash: null, workerHash: null, labels: [{ key: node.key, name: node.name, sourceName: node.sourceName }] })
  store.set(spaces.inputs, id, [node])
  const service = createQualityService(store, () => [node])
  const body = { profileId, worker: randomBytes(32).toString('base64url') }
  assert.equal(service.agent('poll', secret, body), null)
  const [device] = service.devices(profileId)
  assert.equal(device.name, '旧探针')
  service.reassign(profileId, id, device.id)
  assert.equal((service.agent('poll', secret, body) as Assignment).jobId, id)
  assert.equal(service.devices(profileId).length, 1)
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
  assert.equal(classify('chatgptWeb', page(200, '{"cookie_consent_required":false,"country_code":"jp"}')).providerRegion, 'JP')
  assert.equal(classify('chatgptWeb', page(200, '{"cookie_consent_required":false}')).state, 'reachable')
  assert.equal(classify('chatgptWeb', page(200, 'invalid JSON')).needsReview, true)
  assert.equal(classify('grok', page(200, '<title>Access denied | Grok</title>')).needsReview, true)
  assert.equal(classify('chatgptApp', page(404, 'Not Found')).state, 'reachable')
  for (const message of ['VPN required', '{"vpn_detected":true}', 'something went wrong', 'unable to load site']) assert.equal(classify('chatgptApp', page(200, message)).state, 'unavailable')
  assert.equal(classify('claudeApi', null).needsReview, false)
  assert.equal(classify('gemini', page(403, '', '', true), 'JP').state, 'unavailable')
  assert.equal(classify('gemini', page(403), 'HK').state, 'unavailable')
  assert.equal(classify('gemini', page(403), 'RU').state, 'region_restricted')
  assert.equal(classify('claudeWeb', page(403), 'HK').state, 'region_restricted')
  assert.equal(classify('claudeWeb', page(302, '', '/login')).needsReview, false)
  assert.equal(classify('claudeWeb', page(302, '', 'https://www.claude.com/app-unavailable-in-region')).state, 'region_restricted')
  assert.equal(classify('claudeApi', page(401, '{"error":{"message":"x-api-key is required"}}')).state, 'reachable')
  assert.equal(classify('claudeWeb', page(302, '', 'https://unknown.example/login')).state, 'unknown')
  const gemini = classify('gemini', page(200, '<title>Gemini</title><script>x=[0,2,1,200,"JPN"]</script>'), 'JP')
  assert.equal(gemini.state, 'reachable')
  assert.equal(gemini.providerRegion, 'JP')
  assert.equal(googleRegion('["K4WWud", "[\"USA\"]"]'.replaceAll('\\','')), 'US')
  assert.equal(verifyGemini(gemini, 'JP', 'US').state, 'region_mismatch')
  assert.equal(verifyGemini(gemini, 'CN', 'CN').state, 'region_restricted')
  assert.deepEqual(classify('gemini', page(200, ',2,1,200,"RUS"'), 'HK'), {
    state: 'region_restricted', evidence: 'region_denied', httpStatus: 200, providerRegion: 'RU', needsReview: false,
  })
  assert.equal(verifyGemini(gemini, 'JP', null).state, 'unknown')
  assert.throws(() => parseInvite('http://public.example/#a'))
})

test('the browser-protocol probe collects separate surface evidence and verifies the Google region', async t => {
  const edge = http.createServer((req, res) => {
    const host = new URL(req.url!, 'http://fixture.invalid').pathname.slice(1)
    if (host === 'gemini.google.com') { assert.match(req.headers.cookie ?? '', /SOCS=/); res.end('<title>Gemini</title>,2,1,200,"USA"') }
    else if (host === 'api.openai.com') res.end('{"cookie_consent_required":false,"region":"JP"}')
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
  assert.equal(ai.gemini.providerRegion, 'US')
  assert.equal(ai.claudeWeb.evidence, 'login_redirect')
  assert.equal(ai.claudeApi.state, 'reachable')
  assert.equal(ai.grok.state, 'challenge')
})
