import type { AddressInfo } from 'node:net'
import type { Endpoint, LocalInput, Payload, ResponseFor } from '../src/api.ts'
import type { Group, MihomoConfig, Projection, Service, WorkspaceState } from '../shared/model.ts'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { parse, stringify } from 'yaml'
import { defaultFilter } from '../shared/catalog.ts'
import { poolCondition } from '../shared/group-filter.ts'
import { defaultQualityScheduleConfig, qualityDefaults, surfaces, type AiResults, type Assignment, type DevicePairing, type QualityRow, type QualityScheduleConfig, type ScheduleRunResult } from '../shared/quality.ts'
import { minimumProbeVersion, probeProtocol } from '../shared/quality-options.ts'
import { createApplication } from '../server/http.ts'
import { download } from '../server/remote.ts'
import { refreshWorkspace } from '../src/workspace-sync.ts'

const admin = 'integration fixture password'
const token = 'upstream-token-abcdefgh'
const sharedCredential = token + '-c'
const usableName = '🇭🇰 香港 IEPL 01 | 0.5x'
const proxy = (name: string, port: number) => ({ name, server: 'proxy.example.net', port, type: 'ss', cipher: 'aes-128-gcm', password: 'test-node-password' })

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
  assert.equal(saved.sources[source.id].good?.nodes.length, 1)
  assert.equal(saved.sources[source.id].next, null)
  assert.equal(JSON.stringify(saved).includes(nodes[0].password), false)
  await assert.rejects(work.refresh(saved.id, {}), /没有可刷新的订阅/)
  await work.saveDraft(saved.id, 'fixture', { revision: saved.revision, draft: saved.draft })
  const matched = await work.match(saved.id, 'fixture', { domain: 'test.sample.example' })
  assert.equal('match' in matched && matched.match?.serviceId, entry.id)
  await work.publish(saved.id, saved.revision)
  const published = parse(work.activeVersion(work.profileFor(saved.id))!.yaml)
  assert.deepEqual(published.proxies, nodes)
  assert.deepEqual(published.rules, ['RULE-SET,google,DIRECT'])
  assert.equal(published['rule-providers'].google.path, './ruleset/google.mrs')
  const second = await work.profiles(saved.id, { action: 'create', title: 'Transfer' })
  const transfer = await work.sourceImport(second.id, 'fixture', { ...work.sourceExport(saved.id), revision: second.revision })
  assert.equal(transfer.sources[transfer.draft.sources[0].id].good?.nodes.length, 1)
})

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

async function assertEventually<T>(run: () => Promise<T>) {
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
  let upstreamRequests = 0
  const upstream = createServer((request, response) => {
    upstreamRequests++
    if (request.url?.startsWith('/provider')) return response.end('payload:\n  - "+.example.net"\n')
    if (request.url?.startsWith('/a')) response.statusCode = aStatus
    if (response.statusCode !== 200) return response.end('Credentials must not be surfaced: ' + token)
    if (request.url?.startsWith('/a') && usage) response.setHeader('Subscription-Userinfo', usage)
    const proxies = request.url?.startsWith('/a') ? a : request.url?.startsWith('/b') ? b : c
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
  assert.ok(setCookie)
  assert.match(setCookie, /HttpOnly; SameSite=Strict/)
  const cookie = setCookie.split(';')[0]
  function forProfile(profile?: string) {
    async function call<P extends Endpoint, const B extends Payload<P>>(path: P, body?: B): Promise<ResponseFor<P, B>>
    async function call(path: 'publish', body: unknown, expected: 422): Promise<{ detail: Projection }>
    async function call(path: Endpoint, body: unknown, expected: number): Promise<{ detail?: unknown }>
    async function call(path: Endpoint, body?: unknown, expected = 200) {
      const url = new URL('/api/' + path, root)
      if (profile) url.searchParams.set('profile', profile)
      const headers = { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }
      const response = await fetch(url, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
      const data = await response.json()
      assert.equal(response.status, expected, path + ' ' + data.message)
      return data
    }
    return call
  }
  const call = forProfile()
  const forgedOrigin = await fetch(root + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://example.org', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(forgedOrigin.status, 403)
  await assert.rejects(download(upstreamUrl + '/a'), /指向内网/)
  let state = await call('state')
  const sources = ['a', 'b', 'c'].map(key => ({
    id: 'airport-' + key, name: key.toUpperCase(), tag: '[' + key.toUpperCase() + '] ', enabled: true, paused: false,
    url: upstreamUrl + '/' + key + '?token=' + token + '-' + key + '&type=ss', minutes: 1, filter: structuredClone(defaultFilter),
  }))
  sources[2].filter.keep = ['HK']
  sources[2].filter.keywords = ['免费', '试用']
  await t.test('local text imports preview without fetching and save valid nodes atomically', async t => {
    const local = await call('profiles', { action: 'create', title: 'Local imports' })
    const scoped = forProfile(local.id)
    t.after(async () => { await scoped('profiles', { action: 'delete' }) })
    const [yamlSource, linkSource] = sources.slice(0, 2).map(source => ({ ...source, local: true as const, url: '' }))
    const draft = { ...local.draft, sources: [yamlSource, linkSource] }
    const yaml: LocalInput = { format: 'yaml', text: stringify({ proxies: [proxy('本地', 443)] }) }
    const credentials = Buffer.from('aes-128-gcm:test-share-password').toString('base64url')
    const link = 'ss://' + credentials + '@edge.example.net:445#Tokyo'
    const links: LocalInput = { format: 'links', text: link + '\n' + upstreamUrl + '/invalid-node' }
    const preview = await scoped('probe', { kind: 'source', id: linkSource.id, input: links })
    assert.deepEqual(preview.nodes.map(node => node.name), ['Tokyo'])
    assert.equal(preview.rejected.length, 1)
    assert.ok(!JSON.stringify(preview).includes('test-share-password'))
    const save = (input: LocalInput, revision = local.revision) => ({
      revision, draft, localInputs: { [yamlSource.id]: yaml, [linkSource.id]: input },
    })
    const partial = await scoped('draft', save(links), 422)
    assert.deepEqual(partial.detail, preview)
    await scoped('draft', save({ format: 'links', text: 'ssr://!!!', acceptPartial: true }), 422)
    const unchanged = await scoped('state')
    assert.equal(unchanged.revision, local.revision)
    assert.deepEqual(unchanged.sources, {})
    const confirmed = { ...links, acceptPartial: true }
    const saved = await scoped('draft', save(confirmed))
    await scoped('draft', save(confirmed), 409)
    assert.deepEqual(saved.sources[linkSource.id].good, preview)
    assert.equal(saved.sources[yamlSource.id].next, null)
    assert.ok(!JSON.stringify(saved).includes('test-node-password'))
    await scoped('refresh', { id: linkSource.id }, 404)
    await scoped('publish', { revision: saved.revision })
    const localLink = (await scoped('link')).url
    assert.ok(localLink)
    const config: MihomoConfig = parse(await (await fetch(localLink)).text())
    assert.deepEqual(config.proxies.map(node => [node.name, node.password]), [
      ['[A] 本地', 'test-node-password'], ['[B] Tokyo', 'test-share-password'],
    ])
    assert.equal(upstreamRequests, 0)
  })
  for (const [index, source] of sources.entries()) {
    const result = await call('probe', { id: source.id, url: source.url, kind: 'source' })
    assert.equal(result.nodes.length, [a, b, c][index].length)
    assert.deepEqual(result.rejected.map(item => item.item), ['代理集合 1'])
    assert.equal(result.nodes[0].connection, undefined)
    assert.ok(!JSON.stringify(result).includes(token))
  }
  const provider = { id: 'remote-set-a', name: '远程规则集', enabled: true, target: 'DIRECT', provider: { url: upstreamUrl + '/provider', behavior: 'domain', format: 'yaml', minutes: 1440 } } satisfies Service
  const remote = await call('probe', { kind: 'provider', id: provider.id, ...provider.provider })
  assert.equal(remote.count, 1)
  const g1: Group = { id: 'group-0001', name: '出口 X', type: 'select', enabled: true, members: [{
    kind: 'pool', sourceIds: [sources[0].id, sources[1].id], regions: ['HK'], includeRegex: '香港', excludeRegex: '备用$',
  }] }
  const g2: Group = { id: 'group-0002', name: '出口 Y', type: 'select', enabled: true, members: [{ kind: 'pool', sourceId: sources[1].id, regions: [] }] }
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
  const invalidPattern = structuredClone(state.draft)
  const invalidMember = invalidPattern.groups[0].members[0]
  assert.ok(invalidMember.kind === 'pool')
  invalidMember.includeRegex = '['
  await call('draft', { revision: state.revision, draft: invalidPattern }, 400)
  assert.equal((await call('state')).revision, state.revision)
  assert.equal(state.draft.sources[0].url, '')
  const savedAddress = await fetch(root + '/api/source-address?id=' + sources[0].id, { headers: { Cookie: cookie } })
  assert.equal(savedAddress.status, 200)
  assert.equal(savedAddress.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await savedAddress.json(), { url: sources[0].url })
  await call('source-address?id=missing-source', undefined, 404)
  assert.equal(state.sources[sources[0].id].subscriptionInfo?.expire, expire)
  assert.equal(state.sources[sources[1].id].subscriptionInfo, null)
  const due = (date = expiryDate) => call('renewal-reminders', { timeZone: 'UTC', dates: [sources[0].id + '/' + date] })
  assert.deepEqual((await Promise.all([due(), due()])).flat(), [{ id: sources[0].id, date: expiryDate }])
  assert.ok(!JSON.stringify(state).includes('test-node-password'))
  assert.ok(!JSON.stringify(state).includes(token))
  const requests: string[] = []
  async function poll(previous: WorkspaceState) {
    requests.length = 0
    const scoped = forProfile(previous.id)
    return refreshWorkspace(previous, path => {
      requests.push(path)
      return scoped(path)
    })
  }
  const status = await call('status')
  assert.equal(Object.hasOwn(status, 'draft'), false)
  assert.equal(Object.hasOwn(status.sources[sources[0].id], 'good'), false)
  assert.equal(status.statusVersion, state.statusVersion)
  assert.equal(await poll(state), state)
  assert.deepEqual(requests, ['status'])
  const firstNode = state.sources[sources[0].id].good!.nodes[0]
  await call('note', { sourceId: sources[0].id, nodeId: firstNode.id, favorite: true, note: '跨标签页的备注' })
  const noted = await poll(state)
  assert.deepEqual(requests, ['status', 'state?nodes=0'])
  assert.equal(noted.notes[sources[0].id + '/' + firstNode.id].favorite, true)
  assert.equal(noted.sources[sources[0].id].good, state.sources[sources[0].id].good)
  const check = await call('check', {})
  assert.deepEqual(check.issues.filter(issue => issue.severity === 'error'), [])
  assert.equal(check.counts.nodes, 3)
  assert.deepEqual(check.rules.map(rule => rule.target), [g1.name, g1.name, g2.name, 'DIRECT'])
  assert.equal((await call('match', { domain: 'api.github.com' })).match?.target, g2.name)
  state = await call('publish', { revision: state.revision })
  assert.ok(state.current)
  const first = state.current.seq
  const link = (await call('link')).url
  assert.ok(link)
  const firstYaml = await (await fetch(link)).text()
  const firstConfig: MihomoConfig = parse(firstYaml)
  assert.equal(firstConfig.proxies[2].password, sharedCredential)
  firstConfig.proxies[2].password = ''
  assert.equal(JSON.stringify(firstConfig).includes(token), false)
  assert.equal(firstYaml.includes(upstreamUrl), false)
  assert.equal(firstYaml.includes('Fixture upstream metadata'), false)
  assert.equal(firstYaml.includes('proxy-providers:'), false)
  assert.equal(firstYaml.includes('test-node-password'), true)
  assert.deepEqual(firstConfig.proxies.map(node => node.name), ['[A] A 香港', '[B] B 日本', '[C] ' + usableName])
  assert.equal((await fetch(link, { method: 'HEAD' })).status, 200)
  assert.equal((await call('current'))?.rules.length, 4)
  assert.equal(await (await fetch(root + '/api/download', { headers: { Cookie: cookie } })).text(), firstYaml)

  const renewalDraft = structuredClone(state.draft)
  renewalDraft.sources[0].renewalDate = '2026-02-30'
  await call('draft', { revision: state.revision, draft: renewalDraft }, 400)
  const manualDate = new Date((expire - 86400) * 1000).toISOString().slice(0, 10)
  renewalDraft.sources[0].renewalDate = manualDate
  state = await call('draft', { revision: state.revision, draft: renewalDraft })
  assert.equal(state.dirty, false)
  assert.equal(state.current?.seq, first)
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
  await assertEventually(async () => assert.equal((await call('status')).sources[sources[0].id].subscriptionInfo?.download, 300))
  const usageRefresh = await poll(state)
  assert.deepEqual(requests, ['status'])
  assert.equal(usageRefresh.sources[sources[0].id].good, state.sources[sources[0].id].good)
  assert.equal(usageRefresh.current?.seq, first)
  state = usageRefresh

  const safeDraft = structuredClone(state.draft)
  const sensitiveDraft = structuredClone(safeDraft)
  sensitiveDraft.sources[0].tag = '[' + token + '-a] '
  state = await call('draft', { revision: state.revision, draft: sensitiveDraft })
  const blocked = await call('publish', { revision: state.revision }, 422)
  assert.ok(blocked.detail.issues.some(issue => issue.code === 'privacy'))
  assert.ok(!JSON.stringify(blocked).includes(token))
  assert.equal(await (await fetch(link)).text(), firstYaml)
  state = await call('draft', { revision: state.revision, draft: safeDraft })

  const stale = state.revision
  const rawDraft = structuredClone(state.draft)
  rawDraft.services[2].target = g1.id
  state = await call('draft', { revision: state.revision, draft: rawDraft })
  await call('draft', { revision: stale, draft: rawDraft }, 409)
  assert.equal(state.dirty, true)
  a = [...a, proxy('A 香港新增', 447), proxy('A 香港加速', 448), proxy('A 香港备用', 449)]
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(61000)
  // Only the private subscription is fetched while the scheduler runs.
  let autoYaml = await assertEventually(async () => {
    const yaml = await (await fetch(link)).text()
    assert.ok(yaml.includes('A 香港新增'))
    return yaml
  })
  assert.deepEqual(parse(autoYaml)['proxy-groups'][0].proxies, ['[A] A 香港', '[A] A 香港新增', '[A] A 香港加速'])
  assert.ok(autoYaml.includes('DOMAIN-SUFFIX,github.com,出口 Y'))
  const logs = await call('updates')
  assert.ok(logs.some(log => log.trigger === 'schedule' && log.diff?.added === 3))
  const refreshed = await poll(state)
  assert.deepEqual(requests, ['status', 'source-nodes?id=airport-a'])
  assert.equal(refreshed.sources[sources[0].id].good?.nodes.length, 4)
  assert.equal(refreshed.sources[sources[1].id].good, state.sources[sources[1].id].good)
  assert.equal(refreshed.sources[sources[2].id].good, state.sources[sources[2].id].good)
  assert.ok(!JSON.stringify(refreshed.sources).includes('test-node-password'))
  const oldRecord = refreshed.sources[sources[0].id]
  a[0] = { ...a[0], port: 1441 }
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.notEqual((await call('status')).sources[sources[0].id].nodesVersion, oldRecord.nodesVersion))
  const mismatched = await refreshWorkspace(refreshed, async path => {
    const response = await call(path)
    return 'nodesVersion' in response ? { ...response, nodesVersion: oldRecord.nodesVersion } : response
  })
  assert.equal(mismatched, refreshed)
  const changedConnection = await poll(refreshed)
  assert.deepEqual(requests, ['status', 'source-nodes?id=airport-a'])
  const changedNodes = changedConnection.sources[sources[0].id].good!.nodes
  assert.ok(oldRecord.good)
  assert.deepEqual(changedNodes.map(node => node.name), oldRecord.good.nodes.map(node => node.name))
  assert.notEqual(changedNodes[0].fingerprint, oldRecord.good!.nodes[0].fingerprint)
  autoYaml = await (await fetch(link)).text()
  aStatus = 403
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.match((await call('state')).sources[sources[0].id].error ?? '', /HTTP 403/))
  const failedRefresh = await poll(changedConnection)
  assert.deepEqual(requests, ['status'])
  assert.match(failedRefresh.sources[sources[0].id].error ?? '', /HTTP 403/)
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
  assert.equal(state.sources[sources[0].id].pending?.accepted, true)
  assert.equal(state.sources[sources[0].id].subscriptionInfo?.expire, expire)
  const pending = (await call('status')).sources[sources[0].id].pending
  assert.ok(pending)
  assert.equal(Object.hasOwn(pending, 'data'), false)
  const candidate = await poll(failedRefresh)
  assert.deepEqual(requests, ['status', 'source-nodes?id=airport-a'])
  assert.deepEqual(candidate.sources[sources[0].id].pending?.data, state.sources[sources[0].id].pending?.data)
  assert.equal(candidate.sources[sources[0].id].good?.nodes.length, 4)
  assert.equal((await call('check', {})).counts.nodes, 3)
  assert.equal(await (await fetch(link)).text(), autoYaml)
  state = await call('candidate', { id: sources[0].id, accept: false })

  a = [...a, proxy('A 香港', 451), proxy('A 香港加速', 448), proxy('A 香港备用', 449)]
  await call('refresh', { id: sources[0].id })
  await assertEventually(async () => assert.match((await call('state')).sources[sources[0].id].error ?? '', /重名/))
  assert.equal(await (await fetch(link)).text(), autoYaml)
  assert.deepEqual((await call(`provider-content?id=${provider.id}`)).entries, ['+.example.net'])

  const invalid = structuredClone(state.draft)
  invalid.services[0].target = 'missing-group'
  state = await call('draft', { revision: state.revision, draft: invalid })
  const failed = await call('publish', { revision: state.revision }, 422)
  assert.ok(failed.detail.issues.some(issue => issue.code === 'rule-target' && issue.id === services[0].id))
  assert.equal(await (await fetch(link)).text(), autoYaml)
  state = await call('rollback', { seq: first })
  assert.equal(state.current?.kind, 'rollback')
  assert.equal(await (await fetch(link)).text(), firstYaml)

  const backup = await call('backup/export', { passphrase: 'backup fixture password' })
  assert.ok(!JSON.stringify(backup).includes(token))
  await call('backup/import', { passphrase: 'incorrect backup password', backup }, 400)
  assert.equal(await (await fetch(link)).text(), firstYaml)
  const newLink = (await call('link', { action: 'rotate' })).url
  assert.ok(newLink)
  assert.notEqual(newLink, link)
  assert.equal((await fetch(link)).status, 404)
  assert.equal(await (await fetch(newLink)).text(), firstYaml)
  await call('link', { action: 'revoke' })
  assert.equal((await fetch(newLink)).status, 404)
  await call('backup/import', { passphrase: 'backup fixture password', backup })
  assert.deepEqual(await due(), [])
  assert.equal((await call('state')).current?.kind, 'rollback')
  assert.ok((await call('history')).length >= 3)
  assert.equal((await call('link')).url, null)
  const restoredLink = new URL((await call('link', { action: 'rotate' })).url!)
  await app.close()
  app = createApplication({ directory, allowPrivate: true, tickMs: 0 })
  const restarted = await listen(app.server)
  assert.equal(await (await fetch(restarted + restoredLink.pathname)).text(), firstYaml)
})

test('GET /api/quality/latest, incremental agent/complete linkage to /sub/:token, and removed snapshot route', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'submeld-http-quality-latest-'))
  const app = createApplication({ directory, tickMs: 0, password: admin, verify: async () => null })
  const root = await listen(app.server)
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })

  // Unauthenticated check
  assert.equal((await fetch(root + '/api/quality/latest')).status, 401)
  const login = await fetch(root + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: admin }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  const authed = (path: string, body?: unknown) => fetch(root + path, body === undefined
    ? { headers: { Cookie: cookie } }
    : { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  assert.equal((await authed('/api/quality/snapshot')).status, 404)
  assert.deepEqual(await (await authed('/api/quality/latest')).json(), {})
  assert.equal((await authed('/api/quality/latest?deviceId=invalid-uuid')).status, 400)

  // Setup local nodes + probe + dynamic group
  const state0 = await (await authed('/api/state')).json() as WorkspaceState
  const source = { id: 'local-q-1', local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }
  const draftRes = await authed('/api/draft', {
    revision: state0.revision,
    draft: { ...state0.draft, sources: [source] },
    localNodes: { [source.id]: [proxy('Node-A', 8001), proxy('Node-B', 8002)] },
  })
  assert.equal(draftRes.status, 200)
  const savedDraft = await draftRes.json() as WorkspaceState
  const keys = savedDraft.sources[source.id].good!.nodes.map(n => source.id + '/' + n.id)

  const invite = await (await authed('/api/quality/invite', {})).json() as DevicePairing
  const [, profileId, ticket] = new URL(invite.pairing).hash.slice(1).split('.')
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const capabilities = { agentVersion: minimumProbeVersion, protocolVersion: probeProtocol, localRegion: 'JP', localIsp: 'ISP', ipStack: 'dual', mihomoVersion: '1.0' }
  const agentPost = (action: string, bearer: string, payload: unknown) => fetch(root + '/api/quality/agent/' + action, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  assert.equal((await agentPost('enroll', ticket, { profileId, name: 'HTTP Probe', platform: 'linux', secret, capabilities })).status, 200)
  const devices = await (await authed('/api/quality/devices')).json() as Array<{ id: string }>
  const deviceId = devices[0].id

  const withGroup = await (await authed('/api/draft', {
    revision: savedDraft.revision,
    draft: {
      ...savedDraft.draft,
      groups: [{
        id: 'grp-ai-01',
        name: 'AI Group',
        type: 'select',
        enabled: true,
        qualityDeviceId: deviceId,
        members: [poolCondition({ quality: { aiAll: true, minAvailability: 0.5, untestedPolicy: 'include' } })],
      }],
    },
  })).json() as WorkspaceState
  await authed('/api/publish', { revision: withGroup.revision })
  const subUrl = (await (await authed('/api/link')).json() as { url: string }).url
  const initialConfig = parse(await (await fetch(subUrl)).text()) as MihomoConfig
  assert.deepEqual(initialConfig['proxy-groups'][0].proxies, ['Node-A', 'Node-B'])

  // 1. Run basic: true, ai: false (Node-A available, Node-B unavailable)
  const q1 = await (await authed('/api/quality/queue', {
    targetDeviceId: deviceId,
    keys,
    config: { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 },
  })).json() as { id: string; createdAt: string }
  const a1 = await (await agentPost('poll', secret, { profileId, worker, capabilities })).json() as Assignment
  assert.equal(a1.jobId, q1.id)
  const basicRows: QualityRow[] = [
    { key: keys[0], available: true, error: null, samples: [{ tlsMs: 10, httpsMs: 40 }, { tlsMs: 12, httpsMs: 44 }], tlsMedianMs: 11, httpsMedianMs: 42, jitterMs: 4, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, speed: null, ai: null },
    { key: keys[1], available: false, error: 'no_response', samples: [{ tlsMs: null, httpsMs: null }, { tlsMs: null, httpsMs: null }], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: 1, exit: null, speed: null, ai: null },
  ]
  assert.equal((await agentPost('complete', worker, {
    profileId, jobId: q1.id,
    report: { schemaVersion: 1, jobId: q1.id, startedAt: q1.createdAt, finishedAt: new Date().toISOString(), results: basicRows },
  })).status, 200)

  // 2. Run basic: false, ai: true (Node-A passes all AI, Node-B fails) -> refreshQuality auto-publishes & updates /sub/:token
  const okAi: AiResults = Object.fromEntries(surfaces.map(s => [s, {
    state: 'reachable', evidence: 'web_entry', httpStatus: 200, needsReview: false, providerRegion: 'JP',
  }])) as AiResults
  const downAi: AiResults = Object.fromEntries(surfaces.map(s => [s, {
    state: 'region_restricted', evidence: 'region_denied', httpStatus: 403, needsReview: false, providerRegion: null,
  }])) as AiResults
  const q2 = await (await authed('/api/quality/queue', {
    targetDeviceId: deviceId,
    keys,
    config: { ...qualityDefaults, basic: false, bandwidth: false, ai: true },
  })).json() as { id: string; createdAt: string }
  const a2 = await (await agentPost('poll', secret, { profileId, worker, capabilities })).json() as Assignment
  assert.equal(a2.jobId, q2.id)
  const aiRows: QualityRow[] = [
    { key: keys[0], available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: okAi },
    { key: keys[1], available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: downAi },
  ]
  assert.equal((await agentPost('complete', worker, {
    profileId, jobId: q2.id,
    report: { schemaVersion: 1, jobId: q2.id, startedAt: q2.createdAt, finishedAt: new Date().toISOString(), results: aiRows },
  })).status, 200)

  const latestAll = await (await authed('/api/quality/latest')).json() as Record<string, Record<string, { basic: { httpsMs: number | null } | null; ai: { results: AiResults | null } | null; availability: { rate: number; total: number } | null }>>
  assert.equal(latestAll[deviceId][keys[0]].basic?.httpsMs, 42)
  assert.equal(latestAll[deviceId][keys[0]].ai?.results?.chatgptWeb.state, 'reachable')
  assert.equal(latestAll[deviceId][keys[0]].availability?.rate, 1)
  assert.equal(latestAll[deviceId][keys[1]].availability?.rate, 0)
  assert.equal(latestAll[deviceId][keys[1]].availability?.total, 1)

  const latestScoped = await (await authed(`/api/quality/latest?deviceId=${deviceId}`)).json() as Record<string, unknown>
  assert.deepEqual(Object.keys(latestScoped).sort(), [...keys].sort())
  assert.deepEqual(await (await authed(`/api/quality/latest?deviceId=${randomUUID()}`)).json(), {})

  // /sub/:token reflects auto-published version with Node-A only
  const updatedConfig = parse(await (await fetch(subUrl)).text()) as MihomoConfig
  assert.deepEqual(updatedConfig['proxy-groups'][0].proxies, ['Node-A'])

  // Profile isolation
  const secondProfile = await (await authed('/api/profiles', { action: 'create', title: 'Empty' })).json() as WorkspaceState
  assert.deepEqual(await (await authed(`/api/quality/latest?profile=${secondProfile.id}`)).json(), {})
})

test('HTTP quality schedule CRUD, /api/quality/schedule/run with mock timers, and dynamic group autoRefreshGroups linkage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'submeld-http-quality-schedule-'))
  const app = createApplication({ directory, tickMs: 0, password: admin, verify: async () => null })
  const root = await listen(app.server)
  t.after(async () => {
    t.mock.timers.reset()
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })

  // Unauthenticated checks
  assert.equal((await fetch(root + '/api/quality/schedule')).status, 401)
  assert.equal((await fetch(root + '/api/quality/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal((await fetch(root + '/api/quality/schedule/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401)

  const login = await fetch(root + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: admin }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  const authed = (path: string, body?: unknown) => fetch(root + path, body === undefined
    ? { headers: { Cookie: cookie } }
    : { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const agentPost = (action: string, bearer: string, payload: unknown) => fetch(root + '/api/quality/agent/' + action, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  // Default schedule
  assert.deepEqual(await (await authed('/api/quality/schedule')).json(), defaultQualityScheduleConfig)

  // Validation errors (400 invalid payload, 404 unknown device)
  assert.equal((await authed('/api/quality/schedule', { ...defaultQualityScheduleConfig, basic: { ...defaultQualityScheduleConfig.basic, intervalMinutes: 0 } })).status, 400)
  assert.equal((await authed('/api/quality/schedule', { ...defaultQualityScheduleConfig, targetDeviceId: randomUUID() })).status, 404)
  assert.equal((await authed('/api/quality/schedule/run', { kind: 'unknown' })).status, 400)
  assert.equal((await authed('/api/quality/schedule/run', { kind: 'basic' })).status, 422)

  // Setup local nodes + v4 probe + dynamic group + publish
  const state0 = await (await authed('/api/state')).json() as WorkspaceState
  const source = { id: 'local-sched-1', local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }
  const savedDraft = await (await authed('/api/draft', {
    revision: state0.revision,
    draft: { ...state0.draft, sources: [source] },
    localNodes: { [source.id]: [proxy('Node-A', 8101), proxy('Node-B', 8102)] },
  })).json() as WorkspaceState
  const keys = savedDraft.sources[source.id].good!.nodes.map(n => source.id + '/' + n.id)

  const invite = await (await authed('/api/quality/invite', {})).json() as DevicePairing
  const [, profileId, ticket] = new URL(invite.pairing).hash.slice(1).split('.')
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const capabilities = { agentVersion: minimumProbeVersion, protocolVersion: probeProtocol, localRegion: 'JP', localIsp: 'ISP', ipStack: 'dual', mihomoVersion: '1.0' }
  assert.equal((await agentPost('enroll', ticket, { profileId, name: 'Sched Probe', platform: 'linux', secret, capabilities })).status, 200)
  const deviceId = ((await (await authed('/api/quality/devices')).json()) as Array<{ id: string }>)[0].id

  const withGroup = await (await authed('/api/draft', {
    revision: savedDraft.revision,
    draft: {
      ...savedDraft.draft,
      groups: [{
        id: 'grp-sched-01',
        name: 'Sched Group',
        type: 'select',
        enabled: true,
        qualityDeviceId: deviceId,
        members: [poolCondition({ quality: { maxLatencyMs: 200, aiAll: true, untestedPolicy: 'include' } })],
      }],
    },
  })).json() as WorkspaceState
  await authed('/api/publish', { revision: withGroup.revision })
  const subUrl = (await (await authed('/api/link')).json() as { url: string }).url
  assert.deepEqual((parse(await (await fetch(subUrl)).text()) as MihomoConfig)['proxy-groups'][0].proxies, ['Node-A', 'Node-B'])

  // Save schedule & verify profile isolation
  const withProfile = (path: string) => path + (path.includes('?') ? '&' : '?') + 'profile=' + encodeURIComponent(profileId)
  const authedP = (path: string, body?: unknown) => authed(withProfile(path), body)
  const savedSchedule = await (await authedP('/api/quality/schedule', {
    targetDeviceId: deviceId,
    scope: 'kept',
    autoRefreshGroups: true,
    basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 6, bandwidth: false },
    ai: { enabled: true, intervalMinutes: 180, concurrency: 4 },
  })).json() as QualityScheduleConfig
  assert.equal(savedSchedule.targetDeviceId, deviceId)
  assert.deepEqual(await (await authedP('/api/quality/schedule')).json(), savedSchedule)

  const secondProfile = await (await authedP('/api/profiles', { action: 'create', title: 'Other' })).json() as WorkspaceState
  assert.deepEqual(await (await authed(`/api/quality/schedule?profile=${secondProfile.id}`)).json(), defaultQualityScheduleConfig)

  // Enable mock timers right after setup (tests server/quality.ts () => Date.now() fix!)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })

  // Trigger basic run via HTTP
  const runBasicRes = await authedP('/api/quality/schedule/run', { kind: 'basic' })
  assert.equal(runBasicRes.status, 200)
  const runBasic = await runBasicRes.json() as ScheduleRunResult
  assert.equal(runBasic.jobs.length, 1)
  assert.equal(runBasic.jobs[0].trigger, 'schedule')
  assert.equal(runBasic.jobs[0].scheduleKind, 'basic')
  assert.equal(runBasic.schedule.basic.lastJobId, runBasic.jobs[0].id)
  const assignBasic = await (await agentPost('poll', secret, { profileId, worker, capabilities })).json() as Assignment
  assert.equal(assignBasic.jobId, runBasic.jobs[0].id)
  assert.equal(assignBasic.config.basic, true)
  assert.equal(assignBasic.config.ai, false)

  // Trigger AI run via HTTP
  const runAiRes = await authedP('/api/quality/schedule/run', { kind: 'ai' })
  assert.equal(runAiRes.status, 200)
  const runAi = await runAiRes.json() as ScheduleRunResult
  assert.equal(runAi.jobs.length, 1)
  assert.equal(runAi.jobs[0].trigger, 'schedule')
  assert.equal(runAi.jobs[0].scheduleKind, 'ai')
  assert.equal(runAi.schedule.ai.lastJobId, runAi.jobs[0].id)

  // Complete basic (Node-A fast 40ms, Node-B unavailable)
  const basicRows1: QualityRow[] = [
    { key: keys[0], available: true, error: null, samples: [{ tlsMs: 10, httpsMs: 40 }, { tlsMs: 12, httpsMs: 40 }], tlsMedianMs: 11, httpsMedianMs: 40, jitterMs: 0, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, speed: null, ai: null },
    { key: keys[1], available: false, error: 'no_response', samples: [{ tlsMs: null, httpsMs: null }, { tlsMs: null, httpsMs: null }], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: 1, exit: null, speed: null, ai: null },
  ]
  assert.equal((await agentPost('complete', worker, {
    profileId, jobId: assignBasic.jobId,
    report: { schemaVersion: 1, jobId: assignBasic.jobId, startedAt: runBasic.jobs[0].createdAt, finishedAt: new Date().toISOString(), results: basicRows1 },
  })).status, 200)

  // Poll & complete AI (Node-A passes all AI, Node-B passes all AI too so Node-B only fails latency/availability)
  const okAi: AiResults = Object.fromEntries(surfaces.map(s => [s, {
    state: 'reachable', evidence: 'web_entry', httpStatus: 200, needsReview: false, providerRegion: 'JP',
  }])) as AiResults
  const assignAi = await (await agentPost('poll', secret, { profileId, worker, capabilities })).json() as Assignment
  assert.equal(assignAi.jobId, runAi.jobs[0].id)
  assert.equal(assignAi.config.basic, false)
  assert.equal(assignAi.config.ai, true)
  const aiRows: QualityRow[] = [
    { key: keys[0], available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: okAi },
    { key: keys[1], available: true, error: null, samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null, ai: okAi },
  ]
  assert.equal((await agentPost('complete', worker, {
    profileId, jobId: assignAi.jobId,
    report: { schemaVersion: 1, jobId: assignAi.jobId, startedAt: runAi.jobs[0].createdAt, finishedAt: new Date().toISOString(), results: aiRows },
  })).status, 200)

  // autoRefreshGroups: true -> auto-published 'auto' version with ['Node-A']
  const historyAfterFirst = await (await authedP('/api/history')).json() as Array<{ kind: string }>
  assert.equal(historyAfterFirst[0].kind, 'auto')
  assert.deepEqual((parse(await (await fetch(subUrl)).text()) as MihomoConfig)['proxy-groups'][0].proxies, ['Node-A'])

  // Advance 61 minutes -> POST /api/quality/schedule/run { kind: 'due' } triggers basic ONLY (ai not due until 180m)
  t.mock.timers.tick(61 * 60_000)
  // Keep probe online in mocked time
  await agentPost('poll', secret, { profileId, worker, capabilities })
  const dueRun = await (await authedP('/api/quality/schedule/run', { kind: 'due' })).json() as ScheduleRunResult
  assert.equal(dueRun.jobs.length, 1)
  assert.equal(dueRun.jobs[0].scheduleKind, 'basic')
  assert.deepEqual(dueRun.skipped, [{ kind: 'ai', reason: 'not_due' }])

  // Update schedule to autoRefreshGroups: false (must preserve lastRunAt/lastJobId!)
  const disabledAuto = await (await authedP('/api/quality/schedule', {
    targetDeviceId: deviceId,
    scope: 'kept',
    autoRefreshGroups: false,
    basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 6, bandwidth: false },
    ai: { enabled: true, intervalMinutes: 180, concurrency: 4 },
  })).json() as QualityScheduleConfig
  assert.equal(disabledAuto.autoRefreshGroups, false)
  assert.equal(disabledAuto.basic.lastJobId, dueRun.jobs[0].id)
  assert.equal(disabledAuto.ai.lastJobId, runAi.jobs[0].id)

  // Complete the scheduled basic job with flipped results (Node-A fails, Node-B fast 50ms)
  const assignDueBasic = await (await agentPost('poll', secret, { profileId, worker, capabilities })).json() as Assignment
  assert.equal(assignDueBasic.jobId, dueRun.jobs[0].id)
  const basicRows2: QualityRow[] = [
    { key: keys[0], available: false, error: 'no_response', samples: [{ tlsMs: null, httpsMs: null }, { tlsMs: null, httpsMs: null }], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: 1, exit: null, speed: null, ai: null },
    { key: keys[1], available: true, error: null, samples: [{ tlsMs: 12, httpsMs: 50 }, { tlsMs: 14, httpsMs: 50 }], tlsMedianMs: 13, httpsMedianMs: 50, jitterMs: 0, lossRate: 0, exit: { ip: '192.0.2.2', region: 'JP' }, speed: null, ai: null },
  ]
  assert.equal((await agentPost('complete', worker, {
    profileId, jobId: assignDueBasic.jobId,
    report: { schemaVersion: 1, jobId: assignDueBasic.jobId, startedAt: dueRun.jobs[0].createdAt, finishedAt: new Date().toISOString(), results: basicRows2 },
  })).status, 200)

  // Latest store updated, but /sub/:token & history did NOT auto-publish because autoRefreshGroups: false
  const latestNow = await (await authedP(`/api/quality/latest?deviceId=${deviceId}`)).json() as Record<string, { basic: { available: boolean } | null }>
  assert.equal(latestNow[keys[0]].basic?.available, false)
  assert.equal(latestNow[keys[1]].basic?.available, true)
  const historyAfterSkipped = await (await authedP('/api/history')).json() as Array<{ kind: string }>
  assert.equal(historyAfterSkipped.length, historyAfterFirst.length)
  assert.deepEqual((parse(await (await fetch(subUrl)).text()) as MihomoConfig)['proxy-groups'][0].proxies, ['Node-A'])

  // Manual run STILL auto-publishes even when schedule.autoRefreshGroups === false
  const manualJob = await (await authedP('/api/quality/queue', {
    targetDeviceId: deviceId,
    keys,
    config: { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 },
  })).json() as { id: string; createdAt: string }
  const assignManual = await (await agentPost('poll', secret, { profileId, worker, capabilities })).json() as Assignment
  assert.equal(assignManual.jobId, manualJob.id)
  assert.equal((await agentPost('complete', worker, {
    profileId, jobId: manualJob.id,
    report: { schemaVersion: 1, jobId: manualJob.id, startedAt: manualJob.createdAt, finishedAt: new Date().toISOString(), results: basicRows2 },
  })).status, 200)
  const historyAfterManual = await (await authedP('/api/history')).json() as Array<{ kind: string }>
  assert.equal(historyAfterManual.length, historyAfterFirst.length + 1)
  assert.deepEqual((parse(await (await fetch(subUrl)).text()) as MihomoConfig)['proxy-groups'][0].proxies, ['Node-B'])

  // Advance another 120 minutes (total +181m since AI run) -> app.workspace.tick() dispatches due AI job via onTick listener
  t.mock.timers.tick(120 * 60_000)
  await agentPost('poll', secret, { profileId, worker, capabilities })
  app.workspace.tick(Date.now())
  const waitingJobs = app.quality.list(profileId).filter(j => j.status === 'waiting')
  assert.ok(waitingJobs.some(j => j.scheduleKind === 'ai' && !j.config.basic && j.config.ai))
  assert.ok(waitingJobs.some(j => j.scheduleKind === 'basic' && j.config.basic && !j.config.ai))
})

test('HTTP security hardening (GET / CSP, malformed/missing Host 400, SSRF variants), restoreBackup poll wake, and complete + publish concurrency', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'submeld-http-hardening-'))
  const staticPath = await mkdtemp(join(tmpdir(), 'submeld-http-static-'))
  await writeFile(join(staticPath, 'index.html'), '<!doctype html><html><head><meta property="csp-nonce" nonce="SUBMELD_STYLE_NONCE"></head><body>ok</body></html>')
  const app = createApplication({ directory, staticPath, tickMs: 0, password: admin, verify: async () => null })
  const root = await listen(app.server)
  const port = (app.server.address() as AddressInfo).port
  const redirectOrigin = createServer((_, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:' + port + '/' }).end()
  })
  const redirectUrl = await listen(redirectOrigin)
  t.after(async () => {
    await app.close()
    await new Promise(resolve => redirectOrigin.close(resolve))
    await rm(directory, { recursive: true, force: true })
    await rm(staticPath, { recursive: true, force: true })
  })

  // 1. GET / CSP includes script-src 'self' and style-src 'self' 'nonce-...' matching HTML meta nonce
  const indexRes = await fetch(root + '/')
  assert.equal(indexRes.status, 200)
  const csp = indexRes.headers.get('content-security-policy') ?? ''
  const html = await indexRes.text()
  const nonceMatch = /nonce="([^"]+)"/.exec(html)
  assert.ok(nonceMatch && nonceMatch[1] !== 'SUBMELD_STYLE_NONCE')
  assert.match(csp, /script-src 'self'/)
  assert.ok(csp.includes(`style-src 'self' 'nonce-${nonceMatch[1]}'`))

  // 2. Malformed or missing Host header returns HTTP 400 (never 500)
  const rawRequest = (raw: string) => new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw))
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
  const malformedHostRaw = await rawRequest('GET /api/session HTTP/1.1\r\nHost: invalid host with spaces\r\nConnection: close\r\n\r\n')
  assert.match(malformedHostRaw, /^HTTP\/1\.1 400 /)
  const missingHostRaw = await rawRequest('GET /api/session HTTP/1.0\r\nConnection: close\r\n\r\n')
  assert.match(missingHostRaw, /^HTTP\/1\.1 400 /)

  // 3. SSRF variants blocked (IPv4-mapped IPv6 loopback, CGNAT 100.64.0.1, octal loopback, and 302 redirect to loopback)
  await assert.rejects(download('http://[::ffff:127.0.0.1]/sub'), /指向内网/)
  await assert.rejects(download('http://100.64.0.1/sub'), /指向内网/)
  await assert.rejects(download('http://0177.0.0.1/sub'), /指向内网/)
  await assert.rejects(download(redirectUrl + '/sub', { allowPrivate: false }), /指向内网/)

  // 4. restoreBackup() immediately wakes active wait: true agent/poll returning 403
  const login = await fetch(root + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: admin }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  const authed = (path: string, body?: unknown) => fetch(root + path, body === undefined
    ? { headers: { Cookie: cookie } }
    : { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const agentPost = (action: string, bearer: string, payload: unknown) => fetch(root + '/api/quality/agent/' + action, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const emptyBackup = await (await authed('/api/backup/export', { passphrase: 'restore wake secret' })).json()
  const state0 = await (await authed('/api/state')).json() as WorkspaceState
  const source = { id: 'local-conc-1', local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }
  const savedDraft = await (await authed('/api/draft', {
    revision: state0.revision,
    draft: { ...state0.draft, sources: [source] },
    localNodes: { [source.id]: [proxy('Node-C1', 8201), proxy('Node-C2', 8202)] },
  })).json() as WorkspaceState
  const keys = savedDraft.sources[source.id].good!.nodes.map(n => source.id + '/' + n.id)

  const invite = await (await authed('/api/quality/invite', {})).json() as DevicePairing
  const [, profileId, ticket] = new URL(invite.pairing).hash.slice(1).split('.')
  const secret = randomBytes(32).toString('base64url')
  const worker = randomBytes(32).toString('base64url')
  const capabilities = { agentVersion: minimumProbeVersion, protocolVersion: probeProtocol, localRegion: 'JP', localIsp: 'ISP', ipStack: 'dual', mihomoVersion: '1.0' }
  assert.equal((await agentPost('enroll', ticket, { profileId, name: 'Conc Probe', platform: 'linux', secret, capabilities })).status, 200)
  const deviceId = ((await (await authed('/api/quality/devices')).json()) as Array<{ id: string }>)[0].id

  const pollStart = Date.now()
  const waitingPoll = agentPost('poll', secret, { profileId, worker, wait: true, capabilities })
  await setTimeout(50)
  const restoreRes = await authed('/api/backup/import', { passphrase: 'restore wake secret', backup: emptyBackup })
  assert.equal(restoreRes.status, 200)
  const wokenPoll = await waitingPoll
  assert.equal(wokenPoll.status, 403)
  assert.ok(Date.now() - pollStart < 3000, 'active long-poll must wake promptly after restoreBackup')

  // 5. complete + publish concurrency after re-enrolling a device and saving draft
  const afterRestore = await (await authed('/api/state')).json() as WorkspaceState
  const draft2 = await (await authed('/api/draft', {
    revision: afterRestore.revision,
    draft: { ...afterRestore.draft, sources: [source] },
    localNodes: { [source.id]: [proxy('Node-C1', 8201), proxy('Node-C2', 8202)] },
  })).json() as WorkspaceState
  const keys2 = draft2.sources[source.id].good!.nodes.map(n => source.id + '/' + n.id)
  const invite2 = await (await authed('/api/quality/invite', {})).json() as DevicePairing
  const [, profileId2, ticket2] = new URL(invite2.pairing).hash.slice(1).split('.')
  assert.equal((await agentPost('enroll', ticket2, { profileId: profileId2, name: 'Conc Probe 2', platform: 'linux', secret, capabilities })).status, 200)
  const deviceId2 = ((await (await authed('/api/quality/devices')).json()) as Array<{ id: string }>)[0].id
  const withPool = await (await authed('/api/draft', {
    revision: draft2.revision,
    draft: {
      ...draft2.draft,
      groups: [{
        id: 'grp-conc-1', name: 'Conc Group', type: 'select', enabled: true, qualityDeviceId: deviceId2,
        members: [poolCondition({ quality: { maxLatencyMs: 200, untestedPolicy: 'include' } })],
      }],
    },
  })).json() as WorkspaceState
  const qConc = await (await authed('/api/quality/queue', {
    targetDeviceId: deviceId2, keys: keys2, config: { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 },
  })).json() as { id: string; createdAt: string }
  const aConc = await (await agentPost('poll', secret, { profileId: profileId2, worker, capabilities })).json() as Assignment
  assert.equal(aConc.jobId, qConc.id)

  const concRows: QualityRow[] = [
    { key: keys2[0], available: true, error: null, samples: [{ tlsMs: 10, httpsMs: 40 }, { tlsMs: 12, httpsMs: 42 }], tlsMedianMs: 11, httpsMedianMs: 41, jitterMs: 2, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, speed: null, ai: null },
    { key: keys2[1], available: false, error: 'no_response', samples: [{ tlsMs: null, httpsMs: null }, { tlsMs: null, httpsMs: null }], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: 1, exit: null, speed: null, ai: null },
  ]
  const [completeRes, publishRes] = await Promise.all([
    agentPost('complete', worker, {
      profileId: profileId2, jobId: qConc.id,
      report: { schemaVersion: 1, jobId: qConc.id, startedAt: qConc.createdAt, finishedAt: new Date().toISOString(), results: concRows },
    }),
    authed('/api/publish', { revision: withPool.revision }),
  ])
  assert.equal(completeRes.status, 200)
  assert.equal(publishRes.status, 200)
  const finalState = await (await authed('/api/state')).json() as WorkspaceState
  assert.ok(finalState.current)
})
