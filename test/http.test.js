import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { parse, stringify } from 'yaml'
import { defaultFilter } from '../shared/catalog.js'
import { createApplication } from '../server/http.js'
import { download } from '../server/remote.js'
import { refreshWorkspace } from '../src/workspace-sync.js'

const admin = 'integration fixture password'
const token = 'upstream-token-abcdefgh'
const sharedCredential = token + '-c'
const usableName = '🇭🇰 香港 IEPL 01 | 0.5x'
const z = value => JSON.parse(JSON.stringify(value))
const proxy = (name, port) => ({ name, server: 'proxy.example.net', port, type: 'ss', cipher: 'aes-128-gcm', password: 'test-node-password' })

test('file source credentials stay server-side through edits, publication and source transfer', async t => {
  const temp = resolve(tmpdir())
  const directory = await mkdtemp(join(temp, 'submeld-file-source-'))
  const app = createApplication({ directory, tickMs: 0, verify: async () => null, loadRuleSetList: async () => '+.sample.example' })
  t.after(async () => {
    await app.close()
    if (dirname(resolve(directory)) === temp) await rm(directory, { recursive: true, force: true })
  })
  const work = app.workspace
  const initial = work.state()
  const source = { id: 'local-source', local: true, name: 'File', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }
  const entry = { id: 'service-google', name: 'Google', enabled: true, target: 'DIRECT', provider: null, ruleSet: 'geosite/google', ruleSetAlias: 'google' }
  const draft = { ...initial.draft, sources: [source], services: [entry], rules: [
    { id: 'rule-google', serviceId: entry.id, type: 'RULE-SET', value: '', enabled: true, noResolve: false },
  ] }
  const nodes = [proxy('Sample', 443)]
  const saved = await work.saveDraft(initial.id, 'fixture', { revision: initial.revision, draft, localNodes: { [source.id]: nodes } })
  assert.equal(saved.sources[source.id].good.nodes.length, 1)
  assert.equal(saved.sources[source.id].next, null)
  assert.equal(JSON.stringify(saved).includes(nodes[0].password), false)
  await assert.rejects(work.refresh(saved.id, {}), /没有可刷新的订阅/)
  await work.saveDraft(saved.id, 'fixture', { revision: saved.revision, draft: saved.draft })
  assert.equal((await work.match(saved.id, 'fixture', { domain: 'test.sample.example' })).match.serviceId, entry.id)
  await work.publish(saved.id, saved.revision)
  const published = parse(work.activeVersion(work.profileFor(saved.id)).yaml)
  assert.deepEqual(published.proxies, nodes)
  assert.deepEqual(published.rules, ['RULE-SET,google,DIRECT'])
  assert.equal(published['rule-providers'].google.path, './ruleset/google.mrs')
  const second = await work.profiles(saved.id, { action: 'create', title: 'Transfer' })
  const transfer = await work.sourceImport(second.id, 'fixture', { ...work.sourceExport(saved.id), revision: second.revision })
  assert.equal(transfer.sources[transfer.draft.sources[0].id].good.nodes.length, 1)
})

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return 'http://127.0.0.1:' + server.address().port
}

async function assertEventually(run) {
  let error
  for (let attempt = 0; attempt < 200; attempt++) {
    try { return await run() } catch (caught) { error = caught }
    await setTimeout(40)
  }
  throw error
}

test('authentication, isolated source drafts, scheduled publishing, failure recovery, private links and backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'submeld-test-'))
  let a = [proxy('A 香港', 441)]
  const b = [proxy('B 日本', 442)]
  const c = [{ ...proxy(usableName, 443), password: sharedCredential }, proxy('🇭🇰 香港 免费', 444), proxy('HK 试用', 445), proxy('JP 1', 446)]
  let aStatus = 200
  const expire = Math.floor(Date.now() / 1000) + 4 * 86400
  const expiryDate = new Date(expire * 1000).toISOString().slice(0, 10)
  let usage = 'total=1024; upload=100; download=200; expire=' + expire
  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/provider')) return response.end('payload:\n  - "+.example.net"\n')
    if (request.url.startsWith('/a')) response.statusCode = aStatus
    if (response.statusCode !== 200) return response.end('Credentials must not be surfaced: ' + token)
    if (request.url.startsWith('/a') && usage) response.setHeader('Subscription-Userinfo', usage)
    const proxies = request.url.startsWith('/a') ? a : request.url.startsWith('/b') ? b : c
    response.end(stringify({ proxies, 'source-description': 'Fixture upstream metadata', 'proxy-providers': { upstream: { url: 'https://example.com/sub?token=' + token } } }))
  })
  const upstreamUrl = await listen(upstream)
  let app = createApplication({
    directory, allowPrivate: true, tickMs: 30, password: admin,
    ...(process.env.SUBMELD_MIHOMO_BIN ? { binary: process.env.SUBMELD_MIHOMO_BIN } : { verify: async () => null }),
  })
  const root = await listen(app.server)
  t.after(async () => {
    await app.close()
    await new Promise(resolve => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  assert.equal((await fetch(root + '/api/state')).status, 401)
  assert.equal((await fetch(root + '/api/status')).status, 401)
  assert.equal((await fetch(root + '/api/source-address?id=airport-a')).status, 401)
  assert.equal((await fetch(root + '/api/source-nodes?id=airport-a')).status, 401)
  assert.equal((await fetch(root + '/api/sources/export')).status, 401)
  assert.equal((await fetch(root + '/api/download')).status, 401)
  const login = await fetch(root + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: admin }) })
  assert.equal(login.status, 200)
  const setCookie = login.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly; SameSite=Strict/)
  const cookie = setCookie.split(';')[0]
  async function call(path, body, expected = 200) {
    const headers = { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }
    const response = await fetch(root + '/api/' + path, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
    const data = await response.json()
    assert.equal(response.status, expected, path + ' ' + data.message)
    return data
  }
  const forgedOrigin = await fetch(root + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://example.org', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(forgedOrigin.status, 403)
  await assert.rejects(download(upstreamUrl + '/a'), /指向内网/)
  let state = await call('state')
  const sources = ['a', 'b', 'c'].map(key => ({
    id: 'airport-' + key, name: key.toUpperCase(), tag: '[' + key.toUpperCase() + '] ', enabled: true, paused: false,
    url: upstreamUrl + '/' + key + '?token=' + token + '-' + key + '&type=ss', minutes: 1, filter: z(defaultFilter),
  }))
  sources[2].filter.keep = ['HK']
  sources[2].filter.keywords = ['免费', '试用']
  for (const [index, source] of sources.entries()) {
    const result = await call('probe', { id: source.id, url: source.url, kind: 'source' })
    assert.equal(result.nodes.length, [a, b, c][index].length)
    assert.deepEqual(result.rejected.map(item => item.item), ['代理集合 1'])
    assert.equal(result.nodes[0].connection, undefined)
    assert.ok(!JSON.stringify(result).includes(token))
  }
  const provider = { id: 'remote-set-a', name: '远程规则集', enabled: true, target: 'DIRECT', provider: { url: upstreamUrl + '/provider', behavior: 'domain', format: 'yaml', minutes: 1440 } }
  const remote = await call('probe', { kind: 'provider', id: provider.id, ...provider.provider })
  assert.equal(remote.count, 1)
  const g1 = { id: 'group-0001', name: '出口 X', type: 'select', enabled: true, members: [{
    kind: 'pool', sourceIds: [sources[0].id, sources[1].id], regions: ['HK'], includeRegex: '香港', excludeRegex: '备用$',
  }] }
  const g2 = { id: 'group-0002', name: '出口 Y', type: 'select', enabled: true, members: [{ kind: 'pool', sourceId: sources[1].id, regions: [] }] }
  const services = [
    { id: 'google-svc', name: 'Google', target: g1.id, enabled: true, provider: null },
    { id: 'gemini-svc', name: 'Gemini', target: g1.id, enabled: true, provider: null },
    { id: 'github-svc', name: 'GitHub', target: g2.id, enabled: true, provider: null },
    provider,
  ]
  const rules = ['google.com', 'gemini.google.com', 'github.com', ''].map((value, index) => ({
    id: 'rule-0000' + index, serviceId: services[index].id, enabled: true, type: index === 3 ? 'RULE-SET' : 'DOMAIN-SUFFIX', value, noResolve: false,
  }))
  state = await call('draft', { revision: state.revision, draft: { ...state.draft, sources, groups: [g1, g2], services, rules } })
  assert.deepEqual(state.draft.groups[0].members, g1.members)
  const invalidPattern = z(state.draft)
  invalidPattern.groups[0].members[0].includeRegex = '['
  await call('draft', { revision: state.revision, draft: invalidPattern }, 400)
  assert.equal((await call('state')).revision, state.revision)
  assert.equal(state.draft.sources[0].url, '')
  const savedAddress = await fetch(root + '/api/source-address?id=' + sources[0].id, { headers: { Cookie: cookie } })
  assert.equal(savedAddress.status, 200)
  assert.equal(savedAddress.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await savedAddress.json(), { url: sources[0].url })
  await call('source-address?id=missing-source', undefined, 404)
  assert.equal(state.sources[sources[0].id].subscriptionInfo.expire, expire)
  assert.equal(state.sources[sources[1].id].subscriptionInfo, null)
  const due = (date = expiryDate) => call('renewal-reminders', { timeZone: 'UTC', dates: [sources[0].id + '/' + date] })
  assert.deepEqual((await Promise.all([due(), due()])).flat(), [{ id: sources[0].id, date: expiryDate }])
  assert.ok(!JSON.stringify(state).includes('test-node-password'))
  assert.ok(!JSON.stringify(state).includes(token))
  const requests = []
  async function poll(previous) {
    requests.length = 0
    return refreshWorkspace(previous, path => {
      requests.push(path)
      return call(path + (path.includes('?') ? '&' : '?') + 'profile=' + previous.id)
    })
  }
  const status = await call('status')
  assert.equal(status.draft, undefined)
  assert.equal(status.sources[sources[0].id].good, undefined)
  assert.equal(status.statusVersion, state.statusVersion)
  assert.equal(await poll(state), state)
  assert.deepEqual(requests, ['status'])
  const firstNode = state.sources[sources[0].id].good.nodes[0]
  await call('note', { sourceId: sources[0].id, nodeId: firstNode.id, favorite: true, note: '跨标签页的备注' })
  const noted = await poll(state)
  assert.deepEqual(requests, ['status', 'state?nodes=0'])
  assert.equal(noted.notes[sources[0].id + '/' + firstNode.id].favorite, true)
  assert.equal(noted.sources[sources[0].id].good, state.sources[sources[0].id].good)
  const check = await call('check', {})
  assert.deepEqual(check.issues.filter(issue => issue.severity === 'error'), [])
  assert.equal(check.counts.nodes, 3)
  assert.deepEqual(check.rules.map(rule => rule.target), [g1.name, g1.name, g2.name, 'DIRECT'])
  assert.equal((await call('match', { domain: 'api.github.com' })).match.target, g2.name)
  state = await call('publish', { revision: state.revision })
  const first = state.current.seq
  const link = (await call('link')).url
  const firstYaml = await (await fetch(link)).text()
  const firstConfig = parse(firstYaml)
  assert.equal(firstConfig.proxies[2].password, sharedCredential)
  firstConfig.proxies[2].password = ''
  assert.equal(JSON.stringify(firstConfig).includes(token), false)
  assert.equal(firstYaml.includes(upstreamUrl), false)
  assert.equal(firstYaml.includes('Fixture upstream metadata'), false)
  assert.equal(firstYaml.includes('proxy-providers:'), false)
  assert.equal(firstYaml.includes('test-node-password'), true)
  assert.deepEqual(firstConfig.proxies.map(node => node.name), ['[A] A 香港', '[B] B 日本', '[C] ' + usableName])
  assert.equal((await fetch(link, { method: 'HEAD' })).status, 200)
  assert.equal((await call('current')).rules.length, 4)
  assert.equal(await (await fetch(root + '/api/download', { headers: { Cookie: cookie } })).text(), firstYaml)

  const renewalDraft = z(state.draft)
  renewalDraft.sources[0].renewalDate = '2026-02-30'
  await call('draft', { revision: state.revision, draft: renewalDraft }, 400)
  const manualDate = new Date((expire - 86400) * 1000).toISOString().slice(0, 10)
  renewalDraft.sources[0].renewalDate = manualDate
  state = await call('draft', { revision: state.revision, draft: renewalDraft })
  assert.equal(state.dirty, false)
  assert.equal(state.current.seq, first)
  assert.deepEqual(await due(), [])
  assert.deepEqual(await due(manualDate), [{ id: sources[0].id, date: manualDate }])
  assert.equal((await call('sources/export')).sources[0].renewalDate, manualDate)
  delete renewalDraft.sources[0].renewalDate
  state = await call('draft', { revision: state.revision, draft: renewalDraft })
  assert.deepEqual(await due(), [])

  usage = ''
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.equal((await call('status')).sources[sources[0].id].subscriptionInfo, null))
  usage = 'upload=100; download=300; total=1024; expire=' + expire
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.equal((await call('status')).sources[sources[0].id].subscriptionInfo.download, 300))
  const usageRefresh = await poll(state)
  assert.deepEqual(requests, ['status'])
  assert.equal(usageRefresh.sources[sources[0].id].good, state.sources[sources[0].id].good)
  assert.equal(usageRefresh.current.seq, first)
  state = usageRefresh

  const safeDraft = z(state.draft)
  const sensitiveDraft = z(safeDraft)
  sensitiveDraft.sources[0].tag = '[' + token + '-a] '
  state = await call('draft', { revision: state.revision, draft: sensitiveDraft })
  const blocked = await call('publish', { revision: state.revision }, 422)
  assert.ok(blocked.detail.issues.some(issue => issue.code === 'privacy'))
  assert.ok(!JSON.stringify(blocked).includes(token))
  assert.equal(await (await fetch(link)).text(), firstYaml)
  state = await call('draft', { revision: state.revision, draft: safeDraft })

  const stale = state.revision
  const rawDraft = z(state.draft)
  rawDraft.services[2].target = g1.id
  state = await call('draft', { revision: state.revision, draft: rawDraft })
  await call('draft', { revision: stale, draft: rawDraft }, 409)
  assert.equal(state.dirty, true)
  a = [...a, proxy('A 香港新增', 447), proxy('A 香港加速', 448), proxy('A 香港备用', 449)]
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(61000)
  let autoYaml
  // Only the private subscription is fetched while the scheduler runs.
  await assertEventually(async () => {
    autoYaml = await (await fetch(link)).text()
    assert.ok(autoYaml.includes('A 香港新增'))
  })
  assert.deepEqual(parse(autoYaml)['proxy-groups'][0].proxies, ['[A] A 香港', '[A] A 香港新增', '[A] A 香港加速'])
  assert.ok(autoYaml.includes('DOMAIN-SUFFIX,github.com,出口 Y'))
  const logs = await call('updates')
  assert.ok(logs.some(log => log.trigger === 'schedule' && log.diff.added === 3))
  const refreshed = await poll(state)
  assert.deepEqual(requests, ['status', 'source-nodes?id=airport-a'])
  assert.equal(refreshed.sources[sources[0].id].good.nodes.length, 4)
  assert.equal(refreshed.sources[sources[1].id].good, state.sources[sources[1].id].good)
  assert.equal(refreshed.sources[sources[2].id].good, state.sources[sources[2].id].good)
  assert.ok(!JSON.stringify(refreshed.sources).includes('test-node-password'))
  const oldRecord = refreshed.sources[sources[0].id]
  a[0] = { ...a[0], port: 1441 }
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.notEqual((await call('status')).sources[sources[0].id].nodesVersion, oldRecord.nodesVersion))
  const changedStatus = await call('status')
  const mismatched = await refreshWorkspace(refreshed, path => path === 'status' ? changedStatus : oldRecord)
  assert.equal(mismatched, refreshed)
  const changedConnection = await poll(refreshed)
  assert.deepEqual(requests, ['status', 'source-nodes?id=airport-a'])
  const changedNodes = changedConnection.sources[sources[0].id].good.nodes
  assert.deepEqual(changedNodes.map(node => node.name), oldRecord.good.nodes.map(node => node.name))
  assert.notEqual(changedNodes[0].fingerprint, oldRecord.good.nodes[0].fingerprint)
  autoYaml = await (await fetch(link)).text()
  aStatus = 403
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.match((await call('state')).sources[sources[0].id].error ?? '', /HTTP 403/))
  const failedRefresh = await poll(changedConnection)
  assert.deepEqual(requests, ['status'])
  assert.match(failedRefresh.sources[sources[0].id].error, /HTTP 403/)
  assert.deepEqual(failedRefresh.sources[sources[0].id].subscriptionInfo, changedConnection.sources[sources[0].id].subscriptionInfo)
  assert.equal(failedRefresh.sources[sources[0].id].good, changedConnection.sources[sources[0].id].good)
  assert.equal(await (await fetch(link)).text(), autoYaml)
  aStatus = 200
  usage = ''
  a = []
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.match((await call('state')).sources[sources[0].id].error ?? '', /空节点/))
  assert.deepEqual((await call('status')).sources[sources[0].id].subscriptionInfo, failedRefresh.sources[sources[0].id].subscriptionInfo)
  assert.equal(await (await fetch(link)).text(), autoYaml)

  a = [proxy('A 香港', 441)]
  usage = 'expire=' + expire
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.match((await call('state')).sources[sources[0].id].error ?? '', /节点异常减少/))
  state = await call('candidate', { id: sources[0].id, accept: true })
  assert.equal(state.sources[sources[0].id].pending.accepted, true)
  assert.equal(state.sources[sources[0].id].subscriptionInfo.expire, expire)
  assert.equal((await call('status')).sources[sources[0].id].pending.data, undefined)
  const candidate = await poll(failedRefresh)
  assert.deepEqual(requests, ['status', 'source-nodes?id=airport-a'])
  assert.deepEqual(candidate.sources[sources[0].id].pending.data, state.sources[sources[0].id].pending.data)
  assert.equal(candidate.sources[sources[0].id].good.nodes.length, 4)
  assert.equal((await call('check', {})).counts.nodes, 3)
  assert.equal(await (await fetch(link)).text(), autoYaml)
  state = await call('candidate', { id: sources[0].id, accept: false })

  a = [...a, proxy('A 香港', 451), proxy('A 香港加速', 448), proxy('A 香港备用', 449)]
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.match((await call('state')).sources[sources[0].id].error ?? '', /重名/))
  assert.equal(await (await fetch(link)).text(), autoYaml)
  assert.deepEqual((await call('provider-content?id=' + provider.id)).entries, ['+.example.net'])

  const invalid = z(state.draft)
  invalid.services[0].target = 'missing-group'
  state = await call('draft', { revision: state.revision, draft: invalid })
  const failed = await call('publish', { revision: state.revision }, 422)
  assert.ok(failed.detail.issues.some(issue => issue.code === 'rule-target' && issue.id === services[0].id))
  assert.equal(await (await fetch(link)).text(), autoYaml)
  state = await call('rollback', { seq: first })
  assert.equal(state.current.kind, 'rollback')
  assert.equal(await (await fetch(link)).text(), firstYaml)

  const backup = await call('backup/export', { passphrase: 'backup fixture password' })
  assert.ok(!JSON.stringify(backup).includes(token))
  await call('backup/import', { passphrase: 'incorrect backup password', backup }, 400)
  assert.equal(await (await fetch(link)).text(), firstYaml)
  const newLink = (await call('link', { action: 'rotate' })).url
  assert.notEqual(newLink, link)
  assert.equal((await fetch(link)).status, 404)
  assert.equal(await (await fetch(newLink)).text(), firstYaml)
  await call('link', { action: 'revoke' })
  assert.equal((await fetch(newLink)).status, 404)
  await call('backup/import', { passphrase: 'backup fixture password', backup })
  assert.deepEqual(await due(), [])
  assert.equal((await call('state')).current.kind, 'rollback')
  assert.ok((await call('history')).length >= 3)
  assert.equal((await call('link')).url, null)
  const restoredLink = new URL((await call('link', { action: 'rotate' })).url)
  await app.close()
  app = createApplication({ directory, allowPrivate: true, tickMs: 0 })
  const restarted = await listen(app.server)
  assert.equal(await (await fetch(restarted + restoredLink.pathname)).text(), firstYaml)
})
