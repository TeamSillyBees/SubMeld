import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { Impit } from 'impit'
import { applyExitRegionFallback, classify, googleRegion, inspectPlatforms, verifyGemini } from '../agent/ai.ts'
import { parseInvite } from '../agent/device.ts'
import { summarize } from '../agent/measure.ts'
import { countryCode } from '../agent/regions.ts'
import { exportBackup } from '../server/backup.ts'
import { createQualityService, qualitySpaces } from '../server/quality.ts'
import { openStore } from '../server/store.ts'
import { createWorkspace } from '../server/workspace.ts'
import { defaultFilter } from '../shared/catalog.ts'
import { poolCondition, resolvePool } from '../shared/group-filter.ts'
import { defaultQualityScheduleConfig, maxQualityNodes, qualityDefaults, surfaces, type AiResults, type Assignment, type QualityRow } from '../shared/quality.ts'
import type { MihomoConfig, Profile } from '../shared/model.ts'
import { compatibleProbe, minimumProbeVersion, probeProtocol, probeQueueLimit } from '../shared/quality-options.ts'
import { getAiDisplayStatus, inferredExitRegion, latestQualitySnapshot, qualitySnapshot } from '../shared/quality-snapshot.ts'

const capabilities = { agentVersion: minimumProbeVersion, protocolVersion: probeProtocol, localRegion: 'JP', localIsp: 'Test ISP', ipStack: 'dual', mihomoVersion: '1.0' }

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
  const request = { profileId: profile.id, worker, capabilities }
  const enrollment = { profileId: profile.id, name: 'Desk PC', platform: 'windows', secret, capabilities }
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
  const extra = Array.from({ length: probeQueueLimit - 1 }, () => queue(firstId))
  assert.throws(() => queue(firstId), /队列已满/)
  assert.equal(service.devices(profile.id).find(d => d.id === firstId)?.waiting, 5)
  for (const job of extra) service.cancel(profile.id, job.id)
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
  assert.equal(service.list(profile.id).find(j => j.id === first.id)!.failure, 'disconnected')
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
  assert.throws(() => queue(secondId), /离线/)
  assert.equal(service.agent('poll', otherSecret, request), null)
  const offline = queue(secondId)
  clock += 24 * 60 * 60_000
  assert.equal(service.list(profile.id).find(job => job.id === offline.id)?.status, 'expired')
  assert.equal(store.get(qualitySpaces(profile.id).inputs, offline.id), null)
})

test('compatibleProbe requires protocol v4 and agent v2.0.0+, rejecting legacy probes while preserving invite pairing', async t => {
  assert.equal(compatibleProbe({ protocolVersion: 4, agentVersion: '2.0.0' }), true)
  assert.equal(compatibleProbe({ protocolVersion: 4, agentVersion: '2.1.0' }), true)
  assert.equal(compatibleProbe({ protocolVersion: 3, agentVersion: '2.0.0' }), false)
  assert.equal(compatibleProbe({ protocolVersion: 2, agentVersion: '2.0.0' }), false)
  assert.equal(compatibleProbe({ protocolVersion: 4, agentVersion: '1.3.1' }), false)
  assert.equal(compatibleProbe({ protocolVersion: 4, agentVersion: '1.9.9' }), false)
  assert.equal(compatibleProbe({ protocolVersion: 4 }), false)
  assert.equal(compatibleProbe({ agentVersion: '2.0.0' }), false)

  const dir = await mkdtemp(join(tmpdir(), 'submeld-probe-compat-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const profile = { id: randomUUID() } as Profile
  const node = { key: profile.id + '/node0001', name: 'A', sourceName: 'S', connection: { type: 'http', server: 'localhost', port: 1 } }
  const service = createQualityService(store, () => [node])
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const ticket = parseInvite(service.invite(profile.id, 'https://submeld.test').pairing).ticket
  assert.ok(store.get(qualitySpaces(profile.id).device, 'invite'))
  service.agent('enroll', ticket, {
    profileId: profile.id, name: 'Legacy PC', platform: 'linux', secret,
    capabilities: { ...capabilities, protocolVersion: 3, agentVersion: '1.3.1' },
  })
  assert.equal(store.get(qualitySpaces(profile.id).device, 'invite'), null)
  const [device] = service.devices(profile.id)
  assert.throws(() => service.queue(profile, { keys: [node.key], config: qualityDefaults, targetDeviceId: device.id }), /2\.0\.0/)
  assert.equal(service.agent('poll', secret, { profileId: profile.id, worker, capabilities: { ...capabilities, protocolVersion: 3, agentVersion: '1.3.1' } }), null)
  assert.equal(service.agent('poll', secret, { profileId: profile.id, worker, capabilities }), null)
  const queued = service.queue(profile, { keys: [node.key], config: qualityDefaults, targetDeviceId: device.id })
  assert.equal((service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) as Assignment).jobId, queued.id)
})

test('long polls wake only the assigned device and atomic claims preserve FIFO across same-timestamp dispatches', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-queue-'))
  const store = openStore(dir)
  const profile = { id: randomUUID() } as Profile
  const node = { key: profile.id + '/node0001', name: 'A', sourceName: 'S', connection: {} }
  let clock = Date.now()
  const service = createQualityService(store, () => [node], () => clock)
  t.after(async () => { service.close(); store.close(); await rm(dir, { recursive: true, force: true }) })
  const token = () => randomBytes(32).toString('base64url')
  function enroll(name: string) {
    const secret = token()
    const ticket = parseInvite(service.invite(profile.id, 'https://submeld.test').pairing).ticket
    service.agent('enroll', ticket, { profileId: profile.id, platform: 'linux', name, secret, capabilities })
    return { secret, id: service.devices(profile.id).find(d => d.name === name)!.id }
  }
  const a = enroll('A'), b = enroll('B'), worker = token()
  const body = { worker, profileId: profile.id, capabilities }
  const queue = (targetDeviceId: string) => service.queue(profile, { config: qualityDefaults, keys: [node.key], targetDeviceId })
  const deadline = AbortSignal.timeout(2000)
  const waiting = service.agent('poll', a.secret, { ...body, wait: true }, deadline)
  const moved = queue(b.id)
  assert.equal(service.reassign(profile.id, moved.id, a.id).targetDeviceId, a.id)
  assert.equal(((await waiting) as Assignment).jobId, moved.id)
  const second = queue(a.id), third = queue(a.id)
  assert.equal(service.agent('poll', a.secret, { ...body, worker: token() }), null)
  assert.equal((service.agent('poll', a.secret, body) as Assignment).jobId, moved.id)
  service.cancel(profile.id, moved.id)
  assert.equal((service.agent('poll', a.secret, body) as Assignment).jobId, second.id)
  service.cancel(profile.id, second.id)
  assert.equal((service.agent('poll', a.secret, body) as Assignment).jobId, third.id)
  service.cancel(profile.id, third.id)
  const disconnect = new AbortController()
  const interrupted = service.agent('poll', a.secret, { ...body, wait: true }, disconnect.signal)
  disconnect.abort()
  const next = queue(a.id)
  assert.equal(await interrupted, null)
  assert.equal(service.list(profile.id).find(j => j.id === next.id)?.status, 'waiting')
  clock += 35_000
  assert.throws(() => queue(a.id), /离线/)
  assert.equal((service.agent('poll', a.secret, body) as Assignment).jobId, next.id)
  service.agent('offline', a.secret, body)
  assert.equal(service.devices(profile.id).find(d => d.id === a.id)?.status, 'offline')
  assert.equal(service.devices(profile.id).length, 2)
})

test('measurements distinguish warm handshake success, request loss and insufficient jitter samples', () => {
  const s = summarize([{ tlsMs: 4, httpsMs: 60 }, { tlsMs: 12, httpsMs: null }, { tlsMs: 6, httpsMs: 80 }, { tlsMs: 8, httpsMs: 70 }])
  assert.deepEqual(s, { available: true, tlsMedianMs: 7, httpsMedianMs: 70, jitterMs: 15, lossRate: .25 })
  assert.equal(summarize([{ tlsMs: null, httpsMs: null }]).jitterMs, null)
})
test('public platform evidence distinguishes challenge, region, IP ban, login and ambiguous responses', () => {
  const page = (status: number, body = '', location = '', challenge = false) => ({ status, body, location, challenge })
  assert.equal(classify('chatgptWeb', page(403, 'Access denied')).state, 'unknown')
  assert.equal(classify('chatgptWeb', page(403, 'Your IP address has been banned')).state, 'ip_blocked')
  assert.equal(classify('chatgptWeb', page(403, '', '', true)).state, 'challenge')
  assert.equal(classify('chatgptWeb', page(403, 'Not available in your country')).state, 'region_restricted')
  assert.equal(classify('chatgptWeb', page(429)).state, 'rate_limited')
  assert.equal(classify('chatgptWeb', page(403, '', '', true), null, 'RU').evidence, 'region_policy')
  assert.equal(classify('chatgptWeb', page(403, '', '', true), null, 'HK').state, 'region_restricted')
  assert.equal(classify('chatgptWeb', page(403, '', '', true), null, 'JP').state, 'degraded_challenge')
  assert.equal(classify('chatgptWeb', page(200, '{"cookie_consent_required":false,"country_code":"jp"}')).providerRegion, 'JP')
  assert.equal(classify('chatgptWeb', page(403, '{"error":"unsupported_country","country":"HK"}'), null, 'JP').providerRegion, 'HK')
  assert.equal(classify('chatgptWeb', page(200, '{"cookie_consent_required":false}')).state, 'reachable')
  assert.equal(classify('chatgptWeb', page(200, 'invalid JSON')).needsReview, true)
  assert.equal(classify('chatgptWeb', page(302, '', 'https://unknown.example/login')).state, 'unknown')
  assert.equal(classify('chatgptWeb', null).needsReview, false)
  assert.equal(classify('chatgptApp', page(404, 'Not Found')).state, 'unknown')
  for (const body of ['{"cf_details":"exit (1)"}', '{"cf_details":{"reason":"(2)"}}', '{"cf_details":"Disallowed ISP"}', '{"blocked_why_headline":"ISP"}']) {
    assert.equal(classify('chatgptApp', page(200, body)).state, 'unavailable')
  }
  const gateway = { cf_details: 'Request is not allowed. Please try again later.' }
  for (const status of [200, 403]) {
    assert.equal(classify('chatgptApp', page(status, JSON.stringify(gateway)), 'HK', 'JP').evidence, 'app_gateway')
    for (const message of ['blocked (1)', 'ISP (2)', 'disallowed ISP', 'VPN', 'proxy']) {
      assert.equal(classify('chatgptApp', page(status, JSON.stringify({ ...gateway, error: { message } }))).evidence, 'disallowed_isp')
    }
  }
  assert.equal(classify('chatgptApp', page(403, JSON.stringify(gateway)), 'JP', 'HK').state, 'region_restricted')
  assert.equal(classify('chatgptApp', page(403, JSON.stringify(gateway), '', true)).state, 'challenge')
  assert.equal(classify('chatgptApp', page(403, JSON.stringify({ ...gateway, error: 'unsupported_country' }))).evidence, 'region_denied')
  assert.equal(classify('chatgptApp', page(403, '{"cf_details":"another gateway error"}')).needsReview, true)
  for (const body of ['Forbidden', 'null', '{}', '{"cf_details":42}', JSON.stringify({ ...gateway, error: { message: 'denied' } })]) {
    assert.equal(classify('chatgptApp', page(403, body)).state, 'unavailable')
  }
  assert.equal(classify('chatgptApp', page(503, JSON.stringify(gateway))).state, 'unavailable')
  assert.equal(classify('chatgptApp', page(200, '{"cf_details":"","error":"bad response"}')).state, 'unknown')
  for (const message of ['VPN required', '{"vpn_detected":true}', 'something went wrong', 'unable to load site']) assert.equal(classify('chatgptApp', page(200, message)).state, 'unavailable')
  assert.equal(classify('gemini', page(403, '', '', true), 'JP').state, 'challenge')
  assert.equal(classify('gemini', page(403), 'HK').state, 'unavailable')
  assert.equal(classify('gemini', page(403), 'RU').state, 'unavailable')
  assert.equal(classify('gemini', page(302, '', 'https://www.google.com/sorry/index')).evidence, 'bot_challenge')
  assert.equal(classify('gemini', page(302, '', 'https://consent.google.com/m')).evidence, 'consent_redirect')
  assert.equal(classify('gemini', page(302, '', 'https://google.com.invalid/sorry/index')).state, 'unknown')
  assert.equal(classify('gemini', page(302, '', '/unsupported')).state, 'region_restricted')
  assert.equal(classify('gemini', page(200, '<title>gemini</title>')).evidence, 'region_unconfirmed')
  assert.equal(classify('gemini', page(200, '<title>Access denied | Gemini</title>', '')).needsReview, true)
  const gemini = classify('gemini', page(200, '<title>Gemini</title><script>x=[0,2,1,200,"JPN"]</script>'), 'JP')
  assert.equal(gemini.state, 'reachable')
  assert.equal(gemini.providerRegion, 'JP')
  assert.equal(googleRegion(',2,1,200,"XXX","K4Wwud":"HKG"'), 'HK')
  assert.equal(googleRegion('["K4WWud", "[\"USA\"]"]'.replaceAll('\\','')), 'US')
  assert.equal(verifyGemini(gemini, 'JP', 'US').evidence, 'region_disagrees')
  assert.equal(verifyGemini(gemini, 'JP', 'HK').state, 'reachable')
  assert.equal(verifyGemini(gemini, 'CN', 'CN').state, 'region_restricted')
  assert.deepEqual(classify('gemini', page(200, ',2,1,200,"RUS"'), 'HK'), {
    state: 'region_restricted', evidence: 'region_policy', httpStatus: 200, providerRegion: 'RU', needsReview: false,
  })
  assert.equal(verifyGemini(gemini, 'JP', null).state, 'unknown')
  assert.throws(() => parseInvite('http://public.example/#a'))
})

test('the browser-protocol probe collects separate surface evidence and verifies the Google region', async t => {
  const traces: string[] = []
  let complianceCalls = 0
  const edge = http.createServer((req, res) => {
    const [host, path] = new URL(req.url!, 'http://fixture.invalid').pathname.slice(1).split('/')
    if (path === 'cdn-cgi') { traces.push(host); res.end('ip=192.0.2.15\nloc=JP\n') }
    else if (host === 'gemini.google.com' && !path) res.writeHead(302, { location: '/app' }).end()
    else if (host === 'gemini.google.com' && path === 'app') res.end('<title>Gemini</title>,2,1,200,"USA"')
    else if (host === 'api.openai.com') res.end('{"cookie_consent_required":false,"region":"JP"}')
    else if (host === 'android.chat.openai.com') res.writeHead(403).end('{"error":{"code":"unsupported_country_region_territory"}}')
    else res.end('<title>Gemini</title>')
  })
  edge.listen(0, '127.0.0.1')
  await once(edge, 'listening')
  t.after(() => { edge.closeAllConnections(); return new Promise<void>(done => edge.close(() => done())) })
  // Retain the native browser client's actual streams, proxy handling, headers and cancellation.
  const fetch = Impit.prototype.fetch
  t.mock.method(Impit.prototype, 'fetch', function (this: Impit, input: string, init: Parameters<typeof fetch>[1]) {
    const u = new URL(input)
    if (u.hostname === 'api.openai.com' && complianceCalls++ === 0) return Promise.reject(new Error('ECONNRESET'))
    return fetch.call(this, 'http://fixture.invalid/' + u.hostname + u.pathname, init)
  })
  const ai = await inspectPlatforms({ port: (edge.address() as AddressInfo).port, password: 'fixture' }, 'JP', new AbortController().signal)
  assert.equal(ai.chatgptWeb.state, 'reachable')
  assert.equal(ai.chatgptApp.state, 'region_restricted')
  assert.equal(ai.gemini.state, 'reachable')
  assert.equal(ai.gemini.evidence, 'region_disagrees')
  assert.equal(ai.gemini.providerRegion, 'US')
  assert.deepEqual(traces.sort(), ['chatgpt.com'])
  assert.equal(complianceCalls, 2)
})

test('a missing provider trace needs an independent agreeing host before a 403 can use the exit region', () => {
  const base = Object.fromEntries(surfaces.map(s => [s, classify(s, null)])) as AiResults
  const denied = { status: 403, challenge: false, body: '', location: '' }
  base.chatgptWeb = classify('chatgptWeb', denied)
  base.chatgptApp = classify('chatgptApp', { ...denied, challenge: true })
  // Same-host agreement (chatgptWeb -> chatgpt.com) must NOT confirm chatgptApp.
  const sameHost = { ...base, chatgptWeb: classify('chatgptWeb', null, null, 'HK') }
  assert.equal(applyExitRegionFallback(sameHost, 'HK', ['HK']).chatgptApp.state, 'challenge')
  // An independent host (gemini.google.com) agreeing with exitRegion confirms both ChatGPT surfaces.
  base.gemini = classify('gemini', { status: 200, challenge: false, body: '<title>Gemini</title>,2,1,200,"HKG"', location: '' }, 'HK')
  const hk = applyExitRegionFallback(base, 'HK', ['HK'])
  assert.deepEqual(hk.chatgptWeb, { state: 'region_restricted', evidence: 'exit_region_fallback', providerRegion: null, httpStatus: 403, needsReview: false })
  assert.deepEqual(hk.chatgptApp, { state: 'region_restricted', evidence: 'exit_region_fallback', providerRegion: null, httpStatus: 403, needsReview: false })
  assert.equal(base.chatgptWeb.state, 'unknown')
  assert.equal(applyExitRegionFallback(base, 'HK', ['HK', 'JP']), base)
  base.gemini = classify('gemini', { status: 200, challenge: false, body: '<title>Gemini</title>,2,1,200,"USA"', location: '' }, 'HK')
  assert.equal(applyExitRegionFallback(base, 'HK', ['HK']), base)
  base.gemini = classify('gemini', { status: 200, challenge: false, body: '<title>Gemini</title>,2,1,200,"SGP"', location: '' }, 'SG')
  const sg = applyExitRegionFallback(base, 'SG', ['SG'])
  assert.equal(sg.chatgptApp.state, 'degraded_challenge')
  assert.equal(sg.chatgptApp.evidence, 'exit_region_fallback')
  assert.equal(sg.chatgptApp.providerRegion, null)
  assert.equal(sg.chatgptWeb.state, 'unknown')
})

test('Gemini stops on fragmented page markers and follows at most one same-origin app redirect', async t => {
  const redirects: string[] = []
  let follow = '/app', appLocation = '', closed = false, traceCalls = 0
  const chunks = ['<ti', 'tle>Ge', 'mi', 'ni</ti', 'tle>', 'x'.repeat(24 * 1024), '"K4', 'Ww', 'ud"', ':"', 'HK', '"']
  t.mock.method(Impit.prototype, 'fetch', async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/cdn-cgi/trace') {
      if (url.hostname === 'chatgpt.com' && ++traceCalls === 1) throw new Error('ECONNRESET')
      return new Response('loc=HK\n')
    }
    if (url.hostname === 'gemini.google.com') {
      redirects.push(url.pathname)
      if (url.pathname === '/') return new Response(null, { status: 302, headers: { location: follow } })
      if (appLocation) return new Response(null, { status: 302, headers: { location: appLocation } })
      let i = 0
      return new Response(new ReadableStream({
        pull(controller) {
          assert.ok(i < chunks.length, 'the rest of the product page must not be read')
          controller.enqueue(Buffer.from(chunks[i++]))
        },
        cancel() { closed = true },
      }, { highWaterMark: 0 }))
    }
    assert.ok(['api.openai.com', 'android.chat.openai.com'].includes(url.hostname))
    return new Response(null, { status: 429 })
  })
  const inspect = () => inspectPlatforms({ port: 1, password: 'fixture' }, 'HK', AbortSignal.timeout(3000))
  const { gemini, chatgptWeb } = await inspect()
  assert.deepEqual(redirects.splice(0), ['/', '/app'])
  assert.equal(gemini.state, 'reachable')
  assert.equal(gemini.providerRegion, 'HK')
  assert.ok(closed)
  assert.equal(traceCalls, 2)
  assert.equal(chatgptWeb.state, 'rate_limited')
  appLocation = '/app'
  assert.equal((await inspect()).gemini.state, 'unknown')
  assert.deepEqual(redirects.splice(0), ['/', '/app'])
  for (const url of ['https://consent.google.com/m', 'https://foreign.invalid/app', 'http://gemini.google.com/app']) {
    follow = url
    assert.equal((await inspect()).gemini.state, 'unknown')
    assert.deepEqual(redirects.splice(0), ['/'])
  }
})

test('M2 3-surface classification, countryCode trimming, 2-host fallback, and display badges handle edge cases', () => {
  const page = (status: number, body = '', location = '', challenge = false) => ({ status, body, location, challenge })

  assert.equal(countryCode(' jp '), 'JP')
  assert.equal(countryCode(' jpn '), 'JP')
  assert.equal(countryCode('  '), null)
  assert.equal(classify('chatgptWeb', page(200, '{"cookie_consent_required":false,"countryCode":" us "}')).providerRegion, 'US')

  // Strict restriction -> red '受限'
  const restrictedWeb = classify('chatgptWeb', page(403, 'Not available in your country'))
  assert.deepEqual(getAiDisplayStatus(restrictedWeb, 'HK'), { tone: 'danger', label: '受限' })
  for (const body of ['Forbidden', '{}', JSON.stringify({ error: { message: 'denied' } })]) {
    const appDenied = classify('chatgptApp', page(403, body))
    assert.equal(appDenied.state, 'unavailable')
    assert.equal(appDenied.needsReview, false)
    assert.deepEqual(getAiDisplayStatus(appDenied), { tone: 'danger', label: '受限' })
  }

  // chatgptApp 403 HTML WAF -> unknown (needsReview: true -> yellow '未知') & eligible for 2-host fallback
  const appHtml403 = classify('chatgptApp', page(403, '<html><head><title>Attention Required! | Cloudflare</title></head><body>Blocked</body></html>'))
  assert.equal(appHtml403.state, 'unknown')
  assert.equal(appHtml403.needsReview, true)
  assert.deepEqual(getAiDisplayStatus(appHtml403), { tone: 'warning', label: '未知' })

  // chatgptApp 5xx -> unavailable with needsReview: true -> yellow '未知'
  const app503 = classify('chatgptApp', page(503, '{"cf_details":"Request is not allowed. Please try again later."}'))
  assert.equal(app503.state, 'unavailable')
  assert.equal(app503.needsReview, true)
  assert.deepEqual(getAiDisplayStatus(app503), { tone: 'warning', label: '未知' })

  // Localized / Turnstile CF challenge -> challenge / degraded_challenge -> yellow '未知'
  const cfTurnstile = classify('chatgptApp', page(403, '<html><title>请稍候…</title><div class="cf-turnstile" data-src="/cdn-cgi/challenge-platform/h/b"></div></html>'))
  assert.equal(cfTurnstile.state, 'challenge')
  assert.equal(cfTurnstile.needsReview, true)
  assert.deepEqual(getAiDisplayStatus(cfTurnstile), { tone: 'warning', label: '未知' })

  // Gemini inline /sorry CAPTCHA body -> degraded_challenge -> yellow '未知'
  for (const body of [
    'Our systems have detected unusual traffic from your computer network.',
    '<div class="g-recaptcha"></div>',
    '<form action="/sorry/index">I am not a robot</form>',
  ]) {
    const gemCaptcha = classify('gemini', page(403, body))
    assert.equal(gemCaptcha.state, 'degraded_challenge')
    assert.equal(gemCaptcha.evidence, 'bot_challenge')
    assert.equal(gemCaptcha.needsReview, false)
    assert.deepEqual(getAiDisplayStatus(gemCaptcha), { tone: 'warning', label: '未知' })
  }

  // 2-host applyExitRegionFallback resolves chatgptApp 403 HTML when Gemini corroborates restricted exitRegion
  const fallbackInput: AiResults = {
    chatgptWeb: classify('chatgptWeb', page(403, 'Access denied')),
    chatgptApp: appHtml403,
    gemini: classify('gemini', page(200, '<title>Gemini</title>,2,1,200,"HKG"'), 'HK'),
  }
  const resolved = applyExitRegionFallback(fallbackInput, 'HK', ['HK'])
  assert.equal(resolved.chatgptApp.state, 'region_restricted')
  assert.equal(resolved.chatgptApp.evidence, 'exit_region_fallback')
  assert.equal(resolved.chatgptApp.needsReview, false)
  assert.deepEqual(getAiDisplayStatus(resolved.chatgptApp), { tone: 'danger', label: '受限' })

  // inferredExitRegion works on basic: false rows (samples: [], error: null, even when available: false)
  const aiOnlyRow: QualityRow = {
    key: 'src00001/node0001',
    available: false,
    error: null,
    samples: [],
    tlsMedianMs: null,
    httpsMedianMs: null,
    jitterMs: null,
    lossRate: null,
    exit: null,
    speed: null,
    ai: {
      chatgptWeb: classify('chatgptWeb', page(200, '{"cookie_consent_required":false,"countryCode":"JP"}')),
      chatgptApp: classify('chatgptApp', page(200, '{"cf_details":"Request is not allowed. Please try again later."}'), null, 'JP'),
      gemini: classify('gemini', null),
    },
  }
  assert.equal(inferredExitRegion(aiOnlyRow), 'JP')
})

test('server quality service normalizes basic: false jobs, validates completion rows, and preserves snapshot compatibility', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-basic-false-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const profile = { id: randomUUID() } as Profile
  const nodes = Array.from({ length: 5 }, (_, i) => ({
    key: profile.id + '/node000' + i,
    name: i === 4 ? '剩余流量：100 GB' : '节点 ' + i,
    sourceName: '测试源',
    connection: { type: 'http', server: 'localhost', port: 1 },
  }))
  const service = createQualityService(store, (_, keys) => nodes.filter(n => keys.has(n.key)))
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const ticket = parseInvite(service.invite(profile.id, 'https://submeld.test').pairing).ticket
  service.agent('enroll', ticket, { profileId: profile.id, name: 'AI PC', platform: 'linux', secret, capabilities })
  const deviceId = service.devices(profile.id)[0].id

  // queue() masks bandwidth to false when basic is false
  const queued = service.queue(profile, {
    targetDeviceId: deviceId,
    keys: nodes.map(n => n.key),
    config: { ...qualityDefaults, basic: false, bandwidth: true, ai: true },
  })
  assert.equal(queued.config.basic, false)
  assert.equal(queued.config.bandwidth, false)
  assert.equal(queued.config.ai, true)

  const assignment = service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) as Assignment
  assert.equal(assignment.jobId, queued.id)
  assert.equal(assignment.config.bandwidth, false)

  const okAi: AiResults = {
    chatgptWeb: classify('chatgptWeb', { status: 200, body: '{"cookie_consent_required":false,"country":"JP"}', location: '', challenge: false }),
    chatgptApp: classify('chatgptApp', { status: 200, body: '{"cf_details":"Request is not allowed. Please try again later."}', location: '', challenge: false }, 'JP', 'JP'),
    gemini: classify('gemini', { status: 200, body: '<title>Gemini</title>,2,1,200,"JPN"', location: '', challenge: false }, 'JP'),
  }
  const downAi: AiResults = Object.fromEntries(surfaces.map(s => [s, classify(s, null)])) as AiResults

  const validResults: QualityRow[] = [
    { key: nodes[0].key, available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: okAi },
    { key: nodes[1].key, available: false, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: downAi },
    { key: nodes[2].key, available: false, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: null, aiSkipped: 'missing_exit' },
    { key: nodes[3].key, available: false, error: 'invalid_node', samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: null },
    { key: nodes[4].key, available: false, error: 'info_node', samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: null },
  ]
  const completeBody = (results: QualityRow[]) => ({
    profileId: profile.id,
    jobId: queued.id,
    report: { schemaVersion: 1, jobId: queued.id, startedAt: queued.createdAt, finishedAt: queued.createdAt, results },
  })

  // Tampered payloads must be rejected with 422
  const mutate = (idx: number, patch: Partial<QualityRow>) => validResults.map((r, i) => i === idx ? { ...r, ...patch } : r)
  const invalidCases: QualityRow[][] = [
    mutate(0, { samples: [{ tlsMs: 5, httpsMs: 10 }] }),
    mutate(0, { tlsMedianMs: 5 }),
    mutate(0, { httpsMedianMs: 10 }),
    mutate(0, { jitterMs: 1 }),
    mutate(0, { lossRate: 0 }),
    mutate(0, { speed: { bytes: 10, elapsedMs: 10, averageBps: 1000, peakBps: 1000, perSecondBps: [1000], stop: 'end' } }),
    mutate(1, { error: 'no_response', ai: null }),
    mutate(3, { available: true }),
    mutate(3, { ai: downAi }),
    mutate(2, { aiSkipped: 'weak_connection' }),
    mutate(2, { exit: { ip: '192.0.2.1', region: 'JP' } }),
    mutate(2, { ai: okAi }),
    mutate(2, { available: true }),
    mutate(0, { ai: null }),
    mutate(0, { available: false }),
    mutate(1, { available: true }),
  ]
  for (const bad of invalidCases) {
    assert.throws(() => service.agent('complete', worker, completeBody(bad)), /结果超出本次检测配置/)
  }

  // Valid basic: false completion & snapshot compatibility
  assert.deepEqual(service.agent('complete', worker, completeBody(validResults)), { ok: true })
  const stored = service.report(profile.id, queued.id)
  const snap = qualitySnapshot(stored)
  assert.deepEqual(snap.config, { bandwidth: false, ai: true })
  assert.equal(snap.rows[nodes[0].key].available, true)
  assert.equal(snap.rows[nodes[0].key].exitRegion, 'JP')
  assert.equal(snap.rows[nodes[0].key].exitRegionInferred, true)
  assert.equal(snap.rows[nodes[1].key].available, false)
  assert.equal(snap.rows[nodes[4].key].infoNode, true)
  const pooled = resolvePool(
    poolCondition({ quality: { aiAll: true } }),
    nodes.map(n => ({ ...n, kept: true, sourceId: profile.id, region: 'JP' })),
    snap,
  )
  assert.deepEqual(pooled.matches.map(m => m.key), [nodes[0].key])
})

test('quality-latest performs incremental field-level merge across basic/bandwidth/ai modes and maintains rolling 20-check availability', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-quality-latest-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const profile = { id: randomUUID() } as Profile
  const nodes = [
    { key: profile.id + '/node0001', name: 'JP 01', sourceName: 'S', connection: { type: 'http', server: 'localhost', port: 1 } },
    { key: profile.id + '/node0002', name: 'US 01', sourceName: 'S', connection: { type: 'http', server: 'localhost', port: 2 } },
    { key: profile.id + '/node0003', name: '剩余流量 100G', sourceName: 'S', connection: { type: 'http', server: 'localhost', port: 3 } },
  ]
  let clock = Date.parse('2026-11-24T00:00:00.000Z')
  const service = createQualityService(store, (_, keys) => nodes.filter(n => keys.has(n.key)), () => clock)
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const ticket = parseInvite(service.invite(profile.id, 'https://submeld.test').pairing).ticket
  service.agent('enroll', ticket, { profileId: profile.id, name: 'Probe A', platform: 'linux', secret, capabilities })
  const deviceId = service.devices(profile.id)[0].id

  const okAi: AiResults = {
    chatgptWeb: classify('chatgptWeb', { status: 200, body: '{"cookie_consent_required":false,"country":"JP"}', location: '', challenge: false }),
    chatgptApp: classify('chatgptApp', { status: 200, body: '{"cf_details":"Request is not allowed. Please try again later."}', location: '', challenge: false }, 'JP', 'JP'),
    gemini: classify('gemini', { status: 200, body: '<title>Gemini</title>,2,1,200,"JPN"', location: '', challenge: false }, 'JP'),
  }
  const downAi: AiResults = Object.fromEntries(surfaces.map(s => [s, classify(s, null)])) as AiResults

  async function runJob(keys: string[], config: typeof qualityDefaults, buildRow: (key: string) => QualityRow) {
    clock += 1000
    const queued = service.queue(profile, { targetDeviceId: deviceId, keys, config })
    const assigned = service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) as Assignment
    assert.equal(assigned.jobId, queued.id)
    const results = keys.map(buildRow)
    const payload = {
      profileId: profile.id,
      jobId: queued.id,
      report: { schemaVersion: 1, jobId: queued.id, startedAt: queued.createdAt, finishedAt: new Date(clock).toISOString(), results },
    }
    assert.deepEqual(service.agent('complete', worker, payload), { ok: true })
    // Duplicate completion must remain idempotent and NOT append twice to availability.window
    assert.deepEqual(service.agent('complete', worker, payload), { ok: true })
    return queued
  }

  // Order 1: node0001 gets basic+bandwidth first, then ai-only, then basic-only (preserving speed & ai)
  const samplesOk = [{ tlsMs: 12, httpsMs: 48 }, { tlsMs: 14, httpsMs: 52 }]
  await runJob([nodes[0].key], { ...qualityDefaults, basic: true, bandwidth: true, ai: false, rounds: 2 }, key => ({
    key, available: true, error: null, samples: samplesOk, tlsMedianMs: 13, httpsMedianMs: 50, jitterMs: 4, lossRate: 0,
    exit: { ip: '192.0.2.10', region: 'JP' },
    speed: { bytes: 2_000_000, elapsedMs: 1000, averageBps: 2_000_000, peakBps: 2_500_000, perSecondBps: [2_000_000], stop: 'end' },
    ai: null,
  }))
  let rec1 = service.getLatestQuality(profile.id, deviceId)[nodes[0].key]
  assert.equal(rec1.basic?.httpsMs, 50)
  assert.equal(rec1.speed?.speedMbps, 16)
  assert.equal(rec1.ai, null)
  assert.deepEqual(rec1.availability?.window, [true])
  assert.equal(rec1.availability?.rate, 1)

  await runJob([nodes[0].key], { ...qualityDefaults, basic: false, bandwidth: false, ai: true }, key => ({
    key, available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null,
    exit: null, speed: null, ai: okAi,
  }))
  rec1 = service.getLatestQuality(profile.id, deviceId)[nodes[0].key]
  assert.equal(rec1.basic?.httpsMs, 50)
  assert.equal(rec1.speed?.speedMbps, 16)
  assert.deepEqual(rec1.ai?.results, okAi)
  // AI-only run must NOT mutate availability window
  assert.deepEqual(rec1.availability?.window, [true])

  // Basic-only without bandwidth preserves both speed and ai while updating basic & availability
  await runJob([nodes[0].key], { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 }, key => ({
    key, available: false, error: 'no_response',
    samples: [{ tlsMs: null, httpsMs: null }, { tlsMs: null, httpsMs: null }],
    tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: 1,
    exit: null, speed: null, ai: null,
  }))
  rec1 = service.getLatestQuality(profile.id, deviceId)[nodes[0].key]
  assert.equal(rec1.basic?.available, false)
  assert.equal(rec1.speed?.speedMbps, 16)
  assert.deepEqual(rec1.ai?.results, okAi)
  assert.deepEqual(rec1.availability?.window, [true, false])
  assert.equal(rec1.availability?.total, 2)
  assert.equal(rec1.availability?.success, 1)
  assert.equal(rec1.availability?.rate, 0.5)

  // Order 2: node0002 gets ai-only first (availability MUST remain null), then basic-only (initializes availability and keeps ai)
  await runJob([nodes[1].key], { ...qualityDefaults, basic: false, bandwidth: false, ai: true }, key => ({
    key, available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null,
    exit: null, speed: null, ai: okAi,
  }))
  let rec2 = service.getLatestQuality(profile.id, deviceId)[nodes[1].key]
  assert.equal(rec2.basic, null)
  assert.equal(rec2.speed, null)
  assert.equal(rec2.availability, null)
  assert.deepEqual(rec2.ai?.results, okAi)

  // Another AI-only run with failed network keeps availability === null
  await runJob([nodes[1].key], { ...qualityDefaults, basic: false, bandwidth: false, ai: true }, key => ({
    key, available: false, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null,
    exit: null, speed: null, ai: downAi,
  }))
  rec2 = service.getLatestQuality(profile.id, deviceId)[nodes[1].key]
  assert.equal(rec2.availability, null)
  assert.deepEqual(rec2.ai?.results, downAi)

  // Restore okAi then run basic-only
  await runJob([nodes[1].key], { ...qualityDefaults, basic: false, bandwidth: false, ai: true }, key => ({
    key, available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null,
    exit: null, speed: null, ai: okAi,
  }))
  await runJob([nodes[1].key], { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 }, key => ({
    key, available: true, error: null, samples: samplesOk, tlsMedianMs: 15, httpsMedianMs: 60, jitterMs: 2, lossRate: 0,
    exit: { ip: '192.0.2.20', region: 'US' }, speed: null, ai: null,
  }))
  rec2 = service.getLatestQuality(profile.id, deviceId)[nodes[1].key]
  assert.equal(rec2.basic?.httpsMs, 60)
  assert.deepEqual(rec2.ai?.results, okAi)
  assert.deepEqual(rec2.availability?.window, [true])

  // Verify rolling 20-check cap on node0001 (currently [true, false] = 2 checks; run 23 more alternating checks)
  const expectedTail: boolean[] = [true, false]
  for (let i = 0; i < 23; i++) {
    const ok = i % 3 !== 0
    expectedTail.push(ok)
    await runJob([nodes[0].key], { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 }, key => ({
      key,
      available: ok,
      error: ok ? null : 'no_response',
      samples: ok ? samplesOk : [{ tlsMs: null, httpsMs: null }, { tlsMs: null, httpsMs: null }],
      tlsMedianMs: ok ? 10 : null,
      httpsMedianMs: ok ? 45 : null,
      jitterMs: ok ? 1 : null,
      lossRate: ok ? 0 : 1,
      exit: ok ? { ip: '192.0.2.10', region: 'JP' } : null,
      speed: null,
      ai: null,
    }))
  }
  const latestNode1 = service.getLatestQuality(profile.id, deviceId)[nodes[0].key]
  const expectedWindow = expectedTail.slice(-20)
  const expectedSuccess = expectedWindow.filter(Boolean).length
  assert.equal(latestNode1.availability?.window.length, 20)
  assert.deepEqual(latestNode1.availability?.window, expectedWindow)
  assert.equal(latestNode1.availability?.total, 20)
  assert.equal(latestNode1.availability?.success, expectedSuccess)
  assert.equal(latestNode1.availability?.rate, expectedSuccess / 20)

  // Info node in basic: true does not pollute availability
  await runJob([nodes[2].key], { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 }, key => ({
    key, available: false, error: 'info_node', samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null,
    exit: null, speed: null, ai: null,
  }))
  const rec3 = service.getLatestQuality(profile.id, deviceId)[nodes[2].key]
  assert.equal(rec3.basic?.infoNode, true)
  assert.equal(rec3.availability, null)

  // Dynamic group resolution against latest combined state (aiAll + minBandwidthMbps + minAvailability)
  const poolNodes = [
    { key: nodes[0].key, name: nodes[0].name, kept: true, sourceId: profile.id, region: 'JP' },
    { key: nodes[1].key, name: nodes[1].name, kept: true, sourceId: profile.id, region: 'US' },
  ]
  const latestForDevice = service.latest(profile.id, deviceId)
  assert.deepEqual(Object.keys(service.latest(profile.id)), [deviceId])
  const combinedMatch = resolvePool(
    poolCondition({ quality: { aiAll: true, minBandwidthMbps: 10, minAvailability: 0.5 } }),
    poolNodes,
    latestForDevice,
  )
  assert.deepEqual(combinedMatch.matches.map(m => m.key), [nodes[0].key])
  assert.deepEqual(combinedMatch.reasons, { untested: 1 })

  // deleteLatestQuality removes single record or device records
  service.deleteLatestQuality(profile.id, { deviceId, nodeKey: nodes[2].key })
  assert.equal(service.getLatestQuality(profile.id, deviceId)[nodes[2].key], undefined)
  service.deleteLatestQuality(profile.id, { deviceId })
  assert.deepEqual(service.latest(profile.id), {})
})

test('quality schedule persistence, profile deletion cleanup, backup exclusion, and revoke cleanup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-quality-schedule-crud-'))
  let store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })

  let clock = Date.parse('2026-11-24T00:00:00.000Z')
  const work = createWorkspace({ store, verify: async () => null, remote: { allowPrivate: true }, tickMs: 0 })
  const firstProfile = work.state()
  const secondProfile = await work.profiles(firstProfile.id, { action: 'create', title: 'Secondary' })
  const service = createQualityService(store, work.selectQualityNodes, () => clock, work.selectQualityScope)

  assert.deepEqual(service.getSchedule(secondProfile.id), defaultQualityScheduleConfig)
  assert.throws(() => service.saveSchedule(secondProfile.id, { ...defaultQualityScheduleConfig, targetDeviceId: randomUUID() }), /所选探针已解除配对/)
  assert.throws(() => service.saveSchedule(secondProfile.id, { ...defaultQualityScheduleConfig, basic: { ...defaultQualityScheduleConfig.basic, intervalMinutes: 0 } }))

  const secret = randomBytes(32).toString('base64url')
  const ticket = parseInvite(service.invite(secondProfile.id, 'https://submeld.test').pairing).ticket
  service.agent('enroll', ticket, { profileId: secondProfile.id, name: 'Schedule Probe', platform: 'linux', secret, capabilities })
  const deviceId = service.devices(secondProfile.id)[0].id

  const saved = service.saveSchedule(secondProfile.id, {
    targetDeviceId: deviceId,
    scope: 'all',
    autoRefreshGroups: false,
    basic: { enabled: true, intervalMinutes: 60, rounds: 4, concurrency: 8, bandwidth: true, lastRunAt: '2020-01-01T00:00:00.000Z', lastJobId: randomUUID() },
    ai: { enabled: true, intervalMinutes: 180, concurrency: 4, lastRunAt: '2020-01-01T00:00:00.000Z', lastJobId: randomUUID() },
  })
  assert.equal(saved.targetDeviceId, deviceId)
  assert.equal(saved.scope, 'all')
  assert.equal(saved.autoRefreshGroups, false)
  // Server-owned timestamps/job IDs cannot be spoofed via saveSchedule
  assert.equal(saved.basic.lastRunAt, null)
  assert.equal(saved.basic.lastJobId, null)
  assert.equal(saved.ai.lastRunAt, null)
  assert.equal(saved.ai.lastJobId, null)

  // Reopen store and verify persistence
  await work.stop()
  store.close()
  store = openStore(dir)
  const reopenedWork = createWorkspace({ store, verify: async () => null, remote: { allowPrivate: true }, tickMs: 0 })
  const reopenedService = createQualityService(store, reopenedWork.selectQualityNodes, () => clock, reopenedWork.selectQualityScope)
  assert.deepEqual(reopenedService.getSchedule(secondProfile.id), saved)

  // Export backup excludes quality-schedules/*
  const backup = exportBackup(store, 'backup secret passphrase')
  assert.equal(JSON.stringify(backup).includes('quality-schedules'), false)

  // Revoking paired target device clears schedule.targetDeviceId
  reopenedService.revoke(secondProfile.id, deviceId)
  assert.equal(reopenedService.getSchedule(secondProfile.id).targetDeviceId, null)

  // Deleting profile clears quality-schedules/${profileId}
  await reopenedWork.profiles(secondProfile.id, { action: 'delete' })
  assert.deepEqual(store.list(qualitySpaces(secondProfile.id).schedules), [])
  await reopenedWork.stop()
})

test('quality scheduler tick dispatches basic & ai independently, deduplicates active jobs, and skips offline/incompatible probes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-quality-scheduler-tick-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })

  let clock = Date.parse('2026-11-24T00:00:00.000Z')
  const profile = { id: randomUUID() } as Profile
  const nodes = [
    { key: profile.id + '/node0001', name: 'JP 01', sourceName: 'S', connection: { type: 'http', server: 'localhost', port: 1 } },
  ]
  const service = createQualityService(
    store,
    (_, keys) => nodes.filter(n => keys.has(n.key)),
    () => clock,
    () => nodes,
  )
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const ticket = parseInvite(service.invite(profile.id, 'https://submeld.test').pairing).ticket
  service.agent('enroll', ticket, { profileId: profile.id, name: 'Tick Probe', platform: 'linux', secret, capabilities })
  const deviceId = service.devices(profile.id)[0].id

  service.saveSchedule(profile.id, {
    targetDeviceId: deviceId,
    scope: 'kept',
    autoRefreshGroups: true,
    basic: { enabled: true, intervalMinutes: 60, rounds: 3, concurrency: 6, bandwidth: false },
    ai: { enabled: true, intervalMinutes: 180, concurrency: 4 },
  })

  // Need profile in store for tick() iteration
  store.set('profiles', profile.id, {
    id: profile.id, title: 'Tick', revision: 1, publishedRevision: null, active: null, token: null, revoked: false, readThrough: null,
    draft: { sources: [], groups: [], services: [], rules: [], base: {} as never },
  })

  // T0: Both basic (never run) and ai (never run) are due
  service.tick(clock)
  let jobs = service.list(profile.id)
  assert.equal(jobs.length, 2)
  const basicJob1 = jobs.find(j => j.config.basic && !j.config.ai)!
  const aiJob1 = jobs.find(j => !j.config.basic && j.config.ai)!
  assert.equal(basicJob1.trigger, 'schedule')
  assert.equal(basicJob1.scheduleKind, 'basic')
  assert.equal(aiJob1.trigger, 'schedule')
  assert.equal(aiJob1.scheduleKind, 'ai')

  let sched = service.getSchedule(profile.id)
  assert.equal(sched.basic.lastJobId, basicJob1.id)
  assert.equal(sched.basic.lastRunAt, new Date(clock).toISOString())
  assert.equal(sched.ai.lastJobId, aiJob1.id)
  assert.equal(sched.ai.lastRunAt, new Date(clock).toISOString())

  // T0 + 190m: waiting job deduplication (before poll claims)
  clock += 190 * 60_000
  service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) // refresh lastSeenAt & claim basicJob1 (lease until T0+192m)
  // Wait: poll claimed basicJob1, so basicJob1 is running and aiJob1 is waiting; tick must NOT queue duplicates for either!
  clock += 30_000
  service.agent('progress', worker, { profileId: profile.id, jobId: basicJob1.id, progress: { stage: 'latency', done: 1, total: 1 } })
  service.tick(clock)
  assert.equal(service.list(profile.id).length, 2)

  // Complete basicJob1 at T0 (reset clock back to T0 to verify independent 60m vs 180m intervals)
  clock = Date.parse('2026-11-24T00:00:00.000Z')
  const t0 = clock
  // Reset schedule lastRunAt cleanly via fresh tick progression
  service.agent('complete', worker, {
    profileId: profile.id, jobId: basicJob1.id,
    report: {
      schemaVersion: 1, jobId: basicJob1.id, startedAt: basicJob1.createdAt, finishedAt: new Date(t0 + 1000).toISOString(),
      results: [{ key: nodes[0].key, available: true, error: null, samples: [{ tlsMs: 10, httpsMs: 40 }, { tlsMs: 12, httpsMs: 42 }, { tlsMs: 11, httpsMs: 41 }], tlsMedianMs: 11, httpsMedianMs: 41, jitterMs: 2, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, speed: null, ai: null }],
    },
  })
  const claimedAi = service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) as Assignment
  assert.equal(claimedAi.jobId, aiJob1.id)
  const okAi: AiResults = Object.fromEntries(surfaces.map(s => [s, { state: 'reachable', evidence: 'web_entry', httpStatus: 200, needsReview: false, providerRegion: 'JP' }])) as AiResults
  service.agent('complete', worker, {
    profileId: profile.id, jobId: aiJob1.id,
    report: {
      schemaVersion: 1, jobId: aiJob1.id, startedAt: aiJob1.createdAt, finishedAt: new Date(t0 + 2000).toISOString(),
      results: [{ key: nodes[0].key, available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: okAi }],
    },
  })

  // At T0 + 60m: only basic is due (60m), AI (180m) is NOT due
  clock = t0 + 60 * 60_000
  service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) // refresh lastSeenAt
  service.tick(clock)
  jobs = service.list(profile.id)
  assert.equal(jobs.length, 3)
  const basicJob2 = jobs[0]
  assert.equal(basicJob2.scheduleKind, 'basic')
  assert.equal(basicJob2.config.basic, true)
  assert.equal(basicJob2.config.ai, false)

  // Complete basicJob2, then advance to T0 + 180m -> both basic (60m since T0+60m -> 120m >= 60m) and ai (180m >= 180m) are due
  const c2 = service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) as Assignment
  assert.equal(c2.jobId, basicJob2.id)
  service.agent('complete', worker, {
    profileId: profile.id, jobId: basicJob2.id,
    report: {
      schemaVersion: 1, jobId: basicJob2.id, startedAt: basicJob2.createdAt, finishedAt: new Date(clock + 1000).toISOString(),
      results: [{ key: nodes[0].key, available: true, error: null, samples: [{ tlsMs: 10, httpsMs: 40 }, { tlsMs: 12, httpsMs: 42 }, { tlsMs: 11, httpsMs: 41 }], tlsMedianMs: 11, httpsMedianMs: 41, jitterMs: 2, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, speed: null, ai: null }],
    },
  })

  // Offline probe skip
  clock = t0 + 180 * 60_000 // > 35s since lastSeenAt -> offline
  service.tick(clock)
  assert.equal(service.list(profile.id).length, 3)

  // Bring probe back online with incompatible protocol -> still skipped
  service.agent('poll', secret, { profileId: profile.id, worker, capabilities: { ...capabilities, protocolVersion: 3, agentVersion: '1.3.1' } })
  service.tick(clock)
  assert.equal(service.list(profile.id).length, 3)

  // Bring probe back with v4 capabilities -> AI (and basic) queued
  service.agent('poll', secret, { profileId: profile.id, worker, capabilities })
  service.tick(clock)
  jobs = service.list(profile.id)
  assert.equal(jobs.length, 5)
  assert.equal(jobs.filter(j => j.status === 'waiting' && j.scheduleKind === 'ai').length, 1)

  // Explicit run throws 409 when already active
  assert.throws(() => service.runSchedule(profile, { kind: 'ai' }), /已有相同类型的检测任务/)
})

test('quality scheduler scope selection (kept vs all, notice exclusion), >1024 chunking, and refreshQuality autoRefreshGroups linkage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-quality-scope-linkage-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })

  let clock = Date.parse('2026-11-24T00:00:00.000Z')
  const work = createWorkspace({ store, verify: async () => null, remote: { allowPrivate: true }, tickMs: 0 })
  t.after(async () => { await work.stop() })
  const service = createQualityService(store, work.selectQualityNodes, () => clock, work.selectQualityScope)
  const initial = work.state()

  const source = {
    id: 'src-scope-1', local: true, name: 'Mixed Source', tag: '', url: '', enabled: true, paused: false, minutes: 60,
    filter: { ...defaultFilter, keep: ['JP'] },
  }
  const localNodes = [
    { name: 'JP Fast 1', server: 'proxy.example.net', port: 9001, type: 'ss', cipher: 'aes-128-gcm', password: 'pw' },
    { name: 'JP Fast 2', server: 'proxy.example.net', port: 9002, type: 'ss', cipher: 'aes-128-gcm', password: 'pw' },
    { name: 'US Excluded', server: 'proxy.example.net', port: 9003, type: 'ss', cipher: 'aes-128-gcm', password: 'pw' },
    { name: '剩余流量：100 GB', server: 'proxy.example.net', port: 9004, type: 'ss', cipher: 'aes-128-gcm', password: 'pw' },
  ]
  const saved = await work.saveDraft(initial.id, 'fixture', {
    revision: initial.revision,
    draft: { ...initial.draft, sources: [source] },
    localNodes: { [source.id]: localNodes },
  })

  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const ticket = parseInvite(service.invite(saved.id, 'https://submeld.test').pairing).ticket
  service.agent('enroll', ticket, { profileId: saved.id, name: 'Scope Probe', platform: 'linux', secret, capabilities })
  const deviceId = service.devices(saved.id)[0].id

  const profile = work.profileFor(saved.id)
  service.saveSchedule(saved.id, {
    targetDeviceId: deviceId,
    scope: 'kept',
    autoRefreshGroups: true,
    basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 6, bandwidth: false },
    ai: { enabled: false, intervalMinutes: 1440, concurrency: 6 },
  })

  // scope: 'kept' -> 2 kept JP nodes (excludes US Excluded and info notice)
  const keptRun = service.runSchedule(profile, { kind: 'basic' })
  assert.equal(keptRun.jobs.length, 1)
  assert.equal(keptRun.jobs[0].total, 2)
  const keptAssignment = service.agent('poll', secret, { profileId: saved.id, worker, capabilities }) as Assignment
  assert.deepEqual(keptAssignment.nodes.map(n => n.name).sort(), ['JP Fast 1', 'JP Fast 2'])
  service.cancel(saved.id, keptRun.jobs[0].id)

  // scope: 'all' -> 3 nodes (2 JP + 1 US, still excluding info notice)
  service.saveSchedule(saved.id, {
    targetDeviceId: deviceId,
    scope: 'all',
    autoRefreshGroups: true,
    basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 6, bandwidth: false },
    ai: { enabled: false, intervalMinutes: 1440, concurrency: 6 },
  })
  const allRun = service.runSchedule(profile, { kind: 'basic' })
  assert.equal(allRun.jobs.length, 1)
  assert.equal(allRun.jobs[0].total, 3)
  const allAssignment = service.agent('poll', secret, { profileId: saved.id, worker, capabilities }) as Assignment
  assert.deepEqual(allAssignment.nodes.map(n => n.name).sort(), ['JP Fast 1', 'JP Fast 2', 'US Excluded'])
  service.cancel(saved.id, allRun.jobs[0].id)

  // >1024 node chunking: 1025 valid nodes split into 2 jobs (1024 + 1) in a single run without self-deduplication
  const bulkSource = {
    id: 'src-bulk-1', local: true, name: 'Bulk Source', tag: '', url: '', enabled: true, paused: false, minutes: 60,
    filter: defaultFilter,
  }
  const bulkNodes = Array.from({ length: maxQualityNodes + 1 }, (_, i) => ({
    name: `JP Bulk ${i}`, server: 'proxy.example.net', port: 10000 + i, type: 'ss', cipher: 'aes-128-gcm', password: 'pw',
  }))
  const withBulk = await work.saveDraft(saved.id, 'fixture', {
    revision: saved.revision,
    draft: { ...saved.draft, sources: [bulkSource] },
    localNodes: { [bulkSource.id]: bulkNodes },
  })
  const bulkRun = service.runSchedule(work.profileFor(withBulk.id), { kind: 'basic' })
  assert.equal(bulkRun.jobs.length, 2)
  assert.equal(bulkRun.jobs[0].total, maxQualityNodes)
  assert.equal(bulkRun.jobs[1].total, 1)
  for (const j of bulkRun.jobs) service.cancel(withBulk.id, j.id)

  // refreshQuality autoRefreshGroups linkage: false skips schedule trigger, true/manual still auto-publishes
  const smallSource = {
    id: 'src-small-1', local: true, name: 'Small', tag: '', url: '', enabled: true, paused: false, minutes: 60,
    filter: defaultFilter,
  }
  const smallSaved = await work.saveDraft(withBulk.id, 'fixture', {
    revision: withBulk.revision,
    draft: {
      ...withBulk.draft,
      sources: [smallSource],
      groups: [{
        id: 'grp-dyn-1', name: 'Low Latency', type: 'select', enabled: true, qualityDeviceId: deviceId,
        members: [poolCondition({ quality: { maxLatencyMs: 200, untestedPolicy: 'include' } })],
      }],
    },
    localNodes: {
      [smallSource.id]: [
        { name: 'Node-1', server: 'proxy.example.net', port: 8011, type: 'ss', cipher: 'aes-128-gcm', password: 'pw' },
        { name: 'Node-2', server: 'proxy.example.net', port: 8012, type: 'ss', cipher: 'aes-128-gcm', password: 'pw' },
      ],
    },
  })
  const published = await work.publish(smallSaved.id, smallSaved.revision)
  const linkInfo = await work.link(smallSaved.id, 'rotate')
  const nodeKeys = smallSaved.sources[smallSource.id].good!.nodes.map(n => smallSource.id + '/' + n.id)
  const seq0 = published.current!.seq

  // Update latest record so Node-2 is slow (300ms) and Node-1 is fast (50ms)
  const nowIso = new Date(clock).toISOString()
  service.setLatestQuality(smallSaved.id, {
    nodeKey: nodeKeys[0], deviceId,
    basic: { available: true, httpsMs: 50, tlsMs: 10, jitterMs: 1, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, infoNode: false, error: null, updatedAt: nowIso },
    speed: null, ai: null, availability: { window: [true], total: 1, success: 1, rate: 1, updatedAt: nowIso },
  })
  service.setLatestQuality(smallSaved.id, {
    nodeKey: nodeKeys[1], deviceId,
    basic: { available: true, httpsMs: 300, tlsMs: 10, jitterMs: 1, lossRate: 0, exit: { ip: '192.0.2.2', region: 'JP' }, infoNode: false, error: null, updatedAt: nowIso },
    speed: null, ai: null, availability: { window: [true], total: 1, success: 1, rate: 1, updatedAt: nowIso },
  })

  // Schedule has autoRefreshGroups: false -> refreshQuality({ trigger: 'schedule' }) must NOT auto-publish
  service.saveSchedule(smallSaved.id, {
    targetDeviceId: deviceId, scope: 'kept', autoRefreshGroups: false,
    basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 6, bandwidth: false },
    ai: { enabled: false, intervalMinutes: 1440, concurrency: 6 },
  })
  await work.refreshQuality(smallSaved.id, { trigger: 'schedule' })
  assert.equal(work.activeVersion(work.profileFor(smallSaved.id))!.seq, seq0)

  // Manual trigger still refreshes even when autoRefreshGroups is false
  await work.refreshQuality(smallSaved.id, { trigger: 'manual' })
  assert.equal(work.activeVersion(work.profileFor(smallSaved.id))!.seq, seq0 + 1)
  assert.deepEqual((parse(work.subscription(linkInfo.token!)!) as MihomoConfig)['proxy-groups'][0].proxies, ['Node-1'])

  // Flip latencies and enable autoRefreshGroups: true -> schedule trigger auto-publishes
  service.saveSchedule(smallSaved.id, {
    targetDeviceId: deviceId, scope: 'kept', autoRefreshGroups: true,
    basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 6, bandwidth: false },
    ai: { enabled: false, intervalMinutes: 1440, concurrency: 6 },
  })
  service.setLatestQuality(smallSaved.id, {
    nodeKey: nodeKeys[0], deviceId,
    basic: { available: true, httpsMs: 400, tlsMs: 10, jitterMs: 1, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, infoNode: false, error: null, updatedAt: nowIso },
    speed: null, ai: null, availability: { window: [true], total: 1, success: 1, rate: 1, updatedAt: nowIso },
  })
  service.setLatestQuality(smallSaved.id, {
    nodeKey: nodeKeys[1], deviceId,
    basic: { available: true, httpsMs: 60, tlsMs: 10, jitterMs: 1, lossRate: 0, exit: { ip: '192.0.2.2', region: 'JP' }, infoNode: false, error: null, updatedAt: nowIso },
    speed: null, ai: null, availability: { window: [true], total: 1, success: 1, rate: 1, updatedAt: nowIso },
  })
  await work.refreshQuality(smallSaved.id, { trigger: 'schedule' })
  assert.equal(work.activeVersion(work.profileFor(smallSaved.id))!.seq, seq0 + 2)
  assert.deepEqual((parse(work.subscription(linkInfo.token!)!) as MihomoConfig)['proxy-groups'][0].proxies, ['Node-2'])
})

test('basic: false ai: true preserves row.exit in quality-latest matching qualitySnapshot without mutating basic or availability', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-ai-only-exit-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })

  const profile = { id: randomUUID() } as Profile
  const nodes = [
    { key: profile.id + '/node0001', name: 'JP Denied', sourceName: 'S', connection: { type: 'http', server: 'localhost', port: 1 } },
    { key: profile.id + '/node0002', name: 'JP NetErr', sourceName: 'S', connection: { type: 'http', server: 'localhost', port: 2 } },
  ]
  const clock = Date.parse('2026-11-24T00:00:00.000Z')
  const service = createQualityService(store, (_, keys) => nodes.filter(n => keys.has(n.key)), () => clock)
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const ticket = parseInvite(service.invite(profile.id, 'https://submeld.test').pairing).ticket
  service.agent('enroll', ticket, { profileId: profile.id, name: 'AI Exit Probe', platform: 'linux', secret, capabilities })
  const deviceId = service.devices(profile.id)[0].id

  const queued = service.queue(profile, {
    targetDeviceId: deviceId,
    keys: nodes.map(n => n.key),
    config: { ...qualityDefaults, basic: false, bandwidth: false, ai: true },
  })
  const assignment = service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) as Assignment
  assert.equal(assignment.jobId, queued.id)

  const denied403: AiResults = Object.fromEntries(surfaces.map(s => [s, {
    state: 'region_restricted', evidence: 'region_denied', httpStatus: 403, needsReview: false, providerRegion: null,
  }])) as AiResults
  const netErr: AiResults = Object.fromEntries(surfaces.map(s => [s, classify(s, null)])) as AiResults

  const results: QualityRow[] = [
    {
      key: nodes[0].key, available: true, error: null, samples: [],
      tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null,
      exit: { ip: '192.0.2.55', region: 'JP' }, speed: null, ai: denied403,
    },
    {
      key: nodes[1].key, available: true, error: null, samples: [],
      tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null,
      exit: { ip: '2001:db8::55', region: 'JP' }, speed: null, ai: netErr,
    },
  ]

  assert.deepEqual(service.agent('complete', worker, {
    profileId: profile.id,
    jobId: queued.id,
    report: { schemaVersion: 1, jobId: queued.id, startedAt: queued.createdAt, finishedAt: new Date(clock).toISOString(), results },
  }), { ok: true })

  const reportSnap = qualitySnapshot(service.report(profile.id, queued.id))
  const latestMap = service.latest(profile.id, deviceId)
  assert.equal(latestMap[nodes[0].key].basic, null)
  assert.equal(latestMap[nodes[0].key].availability, null)
  assert.deepEqual(latestMap[nodes[0].key].ai?.exit, { ip: '192.0.2.55', region: 'JP' })

  const latestSnap = latestQualitySnapshot(latestMap, deviceId)
  assert.equal(latestSnap.rows[nodes[0].key].exitRegion, reportSnap.rows[nodes[0].key].exitRegion)
  assert.equal(latestSnap.rows[nodes[0].key].ipStack, 'ipv4')
  assert.equal(latestSnap.rows[nodes[0].key].available, true)
  assert.equal(latestSnap.rows[nodes[1].key].exitRegion, 'JP')
  assert.equal(latestSnap.rows[nodes[1].key].ipStack, 'ipv6')
  assert.equal(latestSnap.rows[nodes[1].key].available, reportSnap.rows[nodes[1].key].available)
  assert.equal(latestSnap.rows[nodes[1].key].available, true)
})

test('executeSchedule / tick(nowMs) uses tickNow consistently for offline(), createdAt, enqueuedAt, and lastRunAt without mocking Date', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-tick-now-consistency-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })

  const t0 = Date.parse('2026-11-24T00:00:00.000Z')
  let clock = t0
  const profile = { id: randomUUID() } as Profile
  const nodes = [
    { key: profile.id + '/node0001', name: 'JP 01', sourceName: 'S', connection: { type: 'http', server: 'localhost', port: 1 } },
  ]
  const service = createQualityService(store, (_, keys) => nodes.filter(n => keys.has(n.key)), () => clock, () => nodes)
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const ticket = parseInvite(service.invite(profile.id, 'https://submeld.test').pairing).ticket
  service.agent('enroll', ticket, { profileId: profile.id, name: 'Tick Offset Probe', platform: 'linux', secret, capabilities })
  const deviceId = service.devices(profile.id)[0].id

  service.saveSchedule(profile.id, {
    targetDeviceId: deviceId,
    scope: 'kept',
    autoRefreshGroups: true,
    basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 6, bandwidth: false },
    ai: { enabled: false, intervalMinutes: 180, concurrency: 4 },
  })
  store.set('profiles', profile.id, {
    id: profile.id, title: 'TickOffset', revision: 1, publishedRevision: null, active: null, token: null, revoked: false, readThrough: null,
    draft: { sources: [], groups: [], services: [], rules: [], base: {} as never },
  })

  // Probe lastSeenAt is t0 while now() is still t0; tick(t0 + 2h) must judge probe offline relative to tickNow (t0 + 2h), NOT wall-clock t0
  service.tick(t0 + 2 * 60 * 60_000)
  assert.equal(service.list(profile.id).length, 0)

  // Refresh probe lastSeenAt at t0 + 2h - 5s, keep now() at t0 + 2h - 5s, and call tick(t0 + 2h) (explicit +5s offset from now())
  clock = t0 + 2 * 60 * 60_000 - 5_000
  service.agent('poll', secret, { profileId: profile.id, worker, capabilities })
  const firstTickNow = t0 + 2 * 60 * 60_000
  service.tick(firstTickNow)

  let jobs = service.list(profile.id)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].createdAt, new Date(firstTickNow).toISOString())
  assert.equal(jobs[0].enqueuedAt, new Date(firstTickNow).toISOString())
  assert.equal(service.getSchedule(profile.id).basic.lastRunAt, new Date(firstTickNow).toISOString())

  // Complete job and advance to firstTickNow + 61m; verify next job is dispatched and timestamps match tickNow
  const a1 = service.agent('poll', secret, { profileId: profile.id, worker, capabilities }) as Assignment
  service.agent('complete', worker, {
    profileId: profile.id, jobId: a1.jobId,
    report: {
      schemaVersion: 1, jobId: a1.jobId, startedAt: a1.createdAt, finishedAt: new Date(clock + 1000).toISOString(),
      results: [{ key: nodes[0].key, available: true, error: null, samples: [{ tlsMs: 10, httpsMs: 40 }, { tlsMs: 12, httpsMs: 42 }], tlsMedianMs: 11, httpsMedianMs: 41, jitterMs: 2, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, speed: null, ai: null }],
    },
  })
  clock = firstTickNow + 60 * 60_000 + 50_000
  service.agent('poll', secret, { profileId: profile.id, worker, capabilities })
  const secondTickNow = firstTickNow + 61 * 60_000
  service.tick(secondTickNow)

  jobs = service.list(profile.id)
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].createdAt, new Date(secondTickNow).toISOString())
  assert.equal(service.getSchedule(profile.id).basic.lastRunAt, new Date(secondTickNow).toISOString())
})
