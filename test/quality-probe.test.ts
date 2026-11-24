import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import dns from 'node:dns/promises'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import tls from 'node:tls'
import { classify, inspectPlatforms } from '../agent/ai.ts'
import { withCore } from '../agent/core.ts'
import { measureLatency, measureSpeed } from '../agent/measure.ts'
import { run } from '../agent/run.ts'
import { qualityDefaults, reportSchema, surfaces, type AiResults, type Assignment, type Progress } from '../shared/quality.ts'

const binary = process.env.SUBMELD_MIHOMO_BIN ?? resolve('bin', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo')
const openssl = process.env.SUBMELD_TEST_OPENSSL ?? (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl')
const skip = !existsSync(binary) ? '需要 Mihomo 核心' : !tls.setDefaultCACertificates || process.platform === 'win32' && !existsSync(openssl) ? '需要测试证书工具' : false
async function listen(server: net.Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}
function cleanupServer(server: net.Server) {
  const sockets = new Set<net.Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  return () => {
    for (const socket of sockets) socket.destroy()
    return new Promise<void>(done => server.close(() => done()))
  }
}

test('real Mihomo isolates 205 nodes, discards invalid configurations and enforces stream budgets', { skip, timeout: 90_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-probe-fixture-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = join(dir, 'openssl.cnf')
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n[dn]\nCN=fixture.invalid\n[ext]\nbasicConstraints=critical,CA:true\nsubjectAltName=DNS:fixture.invalid\n')
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', config,
    '-keyout', join(dir, 'key'), '-out', join(dir, 'cert')], { windowsHide: true, stdio: 'ignore' })
  const cert = await readFile(join(dir, 'cert'))
  const key = await readFile(join(dir, 'key'))
  const previousTrust = tls.getCACertificates()
  tls.setDefaultCACertificates([...previousTrust, cert])
  t.after(() => tls.setDefaultCACertificates(previousTrust))
  const counts = { sample: 0, downloads: 0, retryExit: 0 }
  async function origin(ip: string, weak = false) {
    let rounds = 0
    const origin = https.createServer({ cert, key }, (req, res) => {
      const url = new URL(req.url!, 'https://fixture.invalid')
      if (url.pathname === '/latency') { counts.sample++; res.writeHead(weak && ++rounds % 2 === 0 ? 503 : 204).end() }
      else if (url.pathname === '/landing') res.writeHead(302, { location: '/login' }).end()
      else if (url.pathname === '/closed') res.destroy()
      else if (url.pathname === '/exit') res.end('ip=' + ip + '\nloc=JP\n')
      else if (url.pathname === '/retry-exit') {
        if (++counts.retryExit === 1) res.destroy()
        else res.end('ip=' + ip + '\nloc=JP\n')
      }
      else if (url.pathname === '/empty-exit') res.writeHead(503).end()
      else if (url.pathname === '/fallback-exit') res.end(JSON.stringify({ ip, country: 'JP' }))
      else if (url.pathname === '/download') { counts.downloads++; res.end(Buffer.alloc(Number(url.searchParams.get('bytes')))) }
      else {
        const timer = setInterval(() => { res.write(Buffer.alloc(256)) }, 100)
        res.on('close', () => clearInterval(timer))
      }
    })
    const port = await listen(origin)
    t.after(cleanupServer(origin))
    return port
  }
  const ports = [await origin('192.0.2.10'), await origin('192.0.2.11'), await origin('192.0.2.10', true)]
  // Observe the AI client's protocol offer locally. Its normal certificate validation rejects this fixture.
  const offered = new Set<string>()
  const aiEndpoint = tls.createServer({ cert, key, ALPNCallback({ protocols }) {
    for (const protocol of protocols) offered.add(protocol)
    return protocols.includes('h2') ? 'h2' : undefined
  } }, socket => socket.end())
  const aiPort = await listen(aiEndpoint)
  t.after(cleanupServer(aiEndpoint))
  const outbound = http.createServer()
  const auths = new Set<string>()
  const aiHosts = new Set<string>()
  outbound.on('connect', (req, client) => {
    const auth = Buffer.from((req.headers['proxy-authorization'] ?? '').slice(6), 'base64').toString()
    auths.add(auth)
    if (auth.startsWith('down:')) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return
    }
    const aiRequest = req.url !== 'fixture.invalid:443'
    if (aiRequest) aiHosts.add(req.url!)
    const originPort = ports[auth.startsWith('weak:') ? 2 : auth.startsWith('b:') ? 1 : 0]
    const upstream = net.connect(aiRequest ? aiPort : originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n')
      client.pipe(upstream).pipe(client)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  })
  const port = await listen(outbound)
  t.after(cleanupServer(outbound))
  const configBase = { ...qualityDefaults, rounds: 2, concurrency: 10, seconds: 2, mebibytes: 1 }
  const nodes = Array.from({ length: 205 }, (_, i) => ({
    key: 'quality-src/' + String(i).padStart(8, '0'), name: '节点 ' + i, sourceName: '本机',
    connection: { type: 'http', server: '127.0.0.1', port, username: i === 204 ? 'b' : 'a', password: String(i) },
  }))
  const job: Assignment = { schemaVersion: 1, jobId: randomUUID(), createdAt: new Date().toISOString(), config: configBase, nodes }
  const endpoints = { latency: 'https://fixture.invalid/latency', exit: 'https://fixture.invalid/exit', download: 'https://fixture.invalid/download' }
  let aiChecks = 0
  const inspect = async () => {
    aiChecks++
    const ai = Object.fromEntries(surfaces.map(k => [k, classify(k, null)])) as AiResults
    if (aiChecks % 2 === 0) ai.grok = classify('grok', { status: 200, location: '', challenge: false, body: '<title>Grok</title>' })
    return ai
  }
  const stages: Progress[] = []
  const report = await run(job, binary, AbortSignal.timeout(55_000), p => stages.push(p), endpoints, inspect)
  assert.ok(reportSchema.safeParse(report).success)
  assert.equal(counts.sample, 3 * 205)
  assert.equal(auths.size, 205)
  assert.equal(report.results.filter(row => row.available).length, 205)
  assert.ok(report.results.slice(0, -1).every(row => row.exit?.ip === '192.0.2.10'))
  assert.equal(report.results.at(-1)!.exit!.ip, '192.0.2.11')
  assert.equal(aiChecks, 205)
  assert.deepEqual(new Set(report.results.slice(0, -1).map(row => row.ai!.grok.state)), new Set(['network_error', 'reachable']))
  assert.equal(counts.downloads, 0)
  assert.ok(stages.some(p => p.stage === 'ai' && p.done === 205 && p.total === 205))
  const down = { ...nodes[1], connection: { ...nodes[1].connection, username: 'down' } }
  const invalid = { ...nodes[2], connection: { type: 'ss', server: '127.0.0.1', port, cipher: 'invalid-cipher', password: 'fixture' } }
  // Only the preflight resolver knows this name. The child must use its temporary hosts entry.
  const ddns = { ...nodes[0], connection: { ...nodes[0].connection, server: 'entry-probe.invalid' } }
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }])
  const small = await run({ ...job, nodes: [ddns, down, invalid], config: { ...configBase, ai: false, bandwidth: true } },
    binary, AbortSignal.timeout(20_000), () => {}, { ...endpoints, exit: 'https://fixture.invalid/empty-exit', exitFallback: 'https://fixture.invalid/fallback-exit' })
  assert.deepEqual(small.results[0].exit, { ip: '192.0.2.10', region: 'JP' })
  assert.equal(small.results[0].speed!.stop, 'bytes')
  assert.equal(small.results[0].speed!.bytes, 1024 ** 2)
  assert.equal(small.results[0].speed!.perSecondBps.length, 1)
  assert.equal(small.results[1].error, 'no_response')
  assert.equal(small.results[1].speed, null)
  assert.equal(small.results[2].error, 'invalid_node')
  assert.equal(counts.downloads, 1)
  const unknownExits = await run({ ...job, nodes: nodes.slice(0, 2) }, binary, AbortSignal.timeout(20_000), () => {},
    { ...endpoints, exit: 'https://fixture.invalid/empty-exit', exitFallback: 'https://fixture.invalid/empty-exit' }, inspect)
  assert.ok(unknownExits.results.every(row => row.available && row.exit === null && row.ai && !row.aiSkipped))
  assert.equal(aiChecks, 207)
  const weak = { ...nodes[1], connection: { ...nodes[1].connection, username: 'weak' } }
  const shared = await run({ ...job, nodes: [nodes[0], weak] }, binary, AbortSignal.timeout(20_000), () => {}, endpoints, inspect)
  assert.deepEqual(shared.results[0].exit, shared.results[1].exit)
  assert.ok(shared.results[0].ai)
  assert.equal(shared.results[1].lossRate, .5)
  assert.equal(shared.results[1].aiSkipped, 'weak_connection')
  assert.equal(shared.results[1].ai, null)
  assert.equal(aiChecks, 208)
  let usedPort = 0
  await withCore(binary, [nodes[0]], AbortSignal.timeout(45_000), async ([route], _, signal) => {
    usedPort = route.outlet.port
    const measure = (latency: string, exit = endpoints.exit) => measureLatency(nodes[0].key, route.outlet, configBase, signal, { ...endpoints, latency, exit })
    const retried = await measure(endpoints.latency, 'https://fixture.invalid/retry-exit')
    assert.deepEqual(retried.exit, { ip: '192.0.2.10', region: 'JP' })
    assert.equal(counts.retryExit, 2)
    const landing = await measure('https://fixture.invalid/landing')
    assert.equal(landing.error, 'unexpected_status')
    assert.ok(landing.samples.every(s => s.httpStatus === 302 && s.tlsMs !== null && s.httpsMs === null))
    const closed = await measure('https://fixture.invalid/closed')
    assert.equal(closed.error, 'https_no_response')
    assert.ok(closed.samples.every(s => s.httpStatus === undefined && s.tlsMs !== null))
    const slow = await measureSpeed(route.outlet, configBase, signal, 'https://fixture.invalid/slow')
    assert.equal(slow.stop, 'duration')
    assert.ok(slow.bytes > 0 && slow.bytes < 1024 ** 2)
    assert.equal(slow.perSecondBps.length, 2)
    assert.ok(slow.elapsedMs <= 2000)
    const ai = await inspectPlatforms(route.outlet, 'JP', signal)
    assert.ok(surfaces.every(s => ai[s].state === 'network_error' && !ai[s].needsReview))
  })
  assert.deepEqual([...aiHosts].sort(), ['android.chat.openai.com', 'api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'claude.ai', 'gemini.google.com', 'grok.com'].map(h => h + ':443').sort())
  assert.ok(offered.has('h2'))
  const reused = net.createServer()
  reused.listen(usedPort, '127.0.0.1')
  await once(reused, 'listening')
  await new Promise<void>(done => reused.close(() => done()))
})

test('cancelling a full-size assignment releases every group of isolated listeners', { skip: !existsSync(binary), timeout: 40_000 }, async () => {
  const cancel = new AbortController()
  const nodes = Array.from({ length: 1024 }, (_, i) => ({
    key: 'batch-src/' + String(i).padStart(8, '0'), name: 'test', sourceName: 'fixture',
    connection: { type: 'http', server: '127.0.0.1', port: 9 },
  }))
  let ports: number[] = []
  await assert.rejects(withCore(binary, nodes, cancel.signal, async (routes, invalid, active) => {
    ports = routes.map(r => r.outlet.port)
    assert.equal(new Set(ports).size, nodes.length)
    assert.equal(invalid.length, 0)
    cancel.abort(new Error('cancel fixture'))
    active.throwIfAborted()
  }), /cancel fixture/)
  for (const index of [0, 240, 480, 720, 1023]) {
    const socket = net.createServer()
    socket.listen(ports[index], '127.0.0.1')
    await once(socket, 'listening')
    await new Promise<void>(done => socket.close(() => done()))
  }
})
