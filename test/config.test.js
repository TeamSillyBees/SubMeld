import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stringify } from 'yaml'
import { blankDraft, defaultFilter, identifyRegion } from '../shared/catalog.js'
import { evaluate, filterNodes, normalizeDomain, sourceReferences, testDomain } from '../shared/config.js'
import { membersForSources } from '../shared/group-filter.js'
import { configHasSubscriptionSecret, parseProvider, parseSource } from '../server/parse.js'
import { containsSubscriptionSecret, subscriptionSecrets } from '../server/remote.js'
import { createRuleSetMatcher } from '../server/rule-set-preview.js'
import { draft as draftSchema } from '../server/schema.js'

const rawName = '  🇭🇰 香港 IEPL 01 | 0.5x  '
const node = (name, port = 443) => ({ name, type: 'ss', server: 'edge.example.net', port, cipher: 'aes-128-gcm', password: 'node-private-credential' })
const parse = (nodes, url = 'https://airport.example/api?token=source-private-secret') => parseSource(Buffer.from(stringify({ proxies: nodes })), [url])
const source = (id, filter, tag = '') => ({ id, name: id, filter: { ...defaultFilter, ...filter }, tag, enabled: true })
const service = (id, target) => ({ id, name: id, target, enabled: true })
const rule = (id, serviceId, type, value, noResolve = false) => ({ id, serviceId, type, value, enabled: true, noResolve })

test('regions, exclusion precedence, manual restoration and exact names', () => {
  const set = parse([node(rawName), node('HK02 免费'), node('JP01'), node('线路 1'), node('香港 试用')])
  assert.equal(identifyRegion('USA 1'), 'US')
  const a = source('airport-a', {}, '[A] ')
  const c = source('airport-c', { keep: ['HK'], keywords: ['免费', '试用'] }, '[C] ')
  assert.equal(filterNodes(a, set).filter(row => row.kept).length, 5)
  const rows = filterNodes(c, set)
  assert.deepEqual(rows.map(row => row.kept), [true, false, false, false, false])
  assert.equal(rows[0].name, '[C] ' + rawName)
  assert.deepEqual(rows[1].reasons, ['名称包含「免费」'])
  assert.deepEqual(rows[2].reasons, ['非所选地区'])
  assert.deepEqual(rows[3].reasons, ['非所选地区'])
  assert.deepEqual(rows[4].reasons, ['名称包含「试用」'])
  assert.equal(filterNodes({ ...c, tag: '[新] ' }, set)[0].name, '[新] ' + rawName)
  assert.equal(filterNodes({ ...c, filter: { ...c.filter, unknown: 'keep' } }, set)[3].kept, true)
  const manual = { ...c, filter: { ...c.filter, manual: [rows[0].id] } }
  assert.deepEqual(filterNodes(manual, set)[0].reasons, ['已手动排除'])
})

test('collisions preserve names and groups resolve pool order and references', () => {
  const a = source('airport-a', {}, '[A] ')
  const b = source('airport-b', {}, '[A] ')
  const data = { [a.id]: parse([node('香港 1'), node('日本 1', 1443)]), [b.id]: parse([node('香港 1')]) }
  const group = { id: 'group-a', name: '香港', enabled: true, type: 'select', members: [{ kind: 'pool', sourceId: '', regions: ['HK'] }] }
  const nested = { id: 'group-b', name: '手动选择', enabled: true, type: 'select', members: [{ kind: 'group', id: group.id }, { kind: 'builtin', id: 'DIRECT' }] }
  const draft = { ...blankDraft(), sources: [a, b], groups: [group, nested] }
  const conflict = evaluate(draft, data)
  assert.ok(conflict.issues.some(issue => issue.code === 'node-conflict'))
  assert.equal(conflict.nodes.filter(row => row.collision).length, 2)
  assert.equal(conflict.nodes[0].duplicateCount, 1)
  b.tag = '[B] '
  group.name = '香港线路'
  const distinct = evaluate(draft, data, {}, true)
  assert.equal(distinct.issues.filter(issue => issue.severity === 'error').length, 0)
  assert.deepEqual(distinct.config['proxy-groups'][0].proxies, ['[A] 香港 1', '[B] 香港 1'])
  assert.deepEqual(distinct.config['proxy-groups'][1].proxies, ['香港线路', 'DIRECT'])
  group.members.push({ kind: 'group', id: nested.id })
  assert.ok(evaluate(draft, data).issues.some(issue => issue.message.includes('循环引用')))
})

test('removing sources narrows scoped group filters and preserves all-source filters', () => {
  const scoped = { kind: 'pool', sourceIds: ['airport-a', 'airport-b'], regions: ['HK'], includeRegex: 'IEPL', excludeRegex: '测试' }
  const all = { kind: 'pool', sourceId: '', regions: [] }
  const legacy = { kind: 'pool', sourceId: 'airport-a', regions: [] }
  const direct = { kind: 'builtin', id: 'DIRECT' }
  const nodeA = { kind: 'node', sourceId: 'airport-a', id: 'node-0001' }
  const members = [direct, scoped, legacy, nodeA, all]
  const group = { id: 'group-0001', members }
  const draft = { groups: [group, { id: 'group-0002', members: [all] }] }
  assert.deepEqual(sourceReferences(draft, 'airport-b'), [group])
  assert.deepEqual(membersForSources(members, new Set(['airport-b'])), [direct, { ...scoped, sourceIds: ['airport-b'] }, all])
  assert.deepEqual(membersForSources(members, new Set()), [direct, all])
})

test('rule order, duplicate and fallback diagnostics, and conservative match prediction', () => {
  const s = service('service-a', 'REJECT')
  const allowed = service('service-b', 'DIRECT')
  const draft = {
    ...blankDraft(), services: [s, allowed],
    rules: [
      rule('r1', s.id, 'IP-CIDR', '10.0.0.0/8', true),
      rule('r2', allowed.id, 'DOMAIN-SUFFIX', 'github.com'),
      rule('r3', s.id, 'DOMAIN', 'api.github.com'),
      rule('r4', s.id, 'MATCH', ''),
      rule('r5', allowed.id, 'DOMAIN-SUFFIX', 'example.org'),
      rule('r6', s.id, 'DOMAIN-SUFFIX', 'github.com'),
    ],
  }
  const compiled = evaluate(draft, {}, {}, true)
  const codes = new Set(compiled.issues.map(issue => issue.code))
  for (const expected of ['rule-shadow', 'rule-duplicate', 'rule-match-order']) assert.ok(codes.has(expected), expected)
  const result = testDomain(compiled, 'Api.GitHub.com.', {}, 'rule')
  assert.equal(result.match.id, 'r2')
  assert.equal(result.match.target, 'DIRECT')
  assert.equal(result.uncertain[0].id, 'r1')
  assert.equal(testDomain(compiled, 'notgithub.com', {}, 'rule').match.id, 'r4')
  assert.equal(normalizeDomain('例子.测试'), 'xn--fsqu00a.xn--0zwm56d')
  assert.equal(normalizeDomain('https://example.org'), '')
})

test('upstream metadata is stripped and credentials needed to connect are retained', () => {
  const upstream = 'https://airport.example/subscribe/clash-meta?token=very-private&type=ss&region=Hong-Kong'
  const payload = parse([
    { ...node('香港 1'), source: '机场标识', 'subscription-url': upstream, token: 'very-private' },
    { ...node('Hong-Kong 2'), password: 'very-private' },
    { ...node('香港 3'), type: 'unsupported' },
    { ...node('香港 4'), 'unknown-transport': 'retained or rejected' },
  ], upstream)
  assert.equal(payload.total, 4)
  assert.equal(payload.nodes.length, 2)
  assert.equal(payload.rejected.length, 2)
  assert.deepEqual(payload.nodes[0].connection, { type: 'ss', server: 'edge.example.net', port: 443, cipher: 'aes-128-gcm', password: 'node-private-credential' })
  assert.equal(payload.nodes[1].connection.password, 'very-private')
  const secrets = subscriptionSecrets([upstream])
  const proxies = payload.nodes.map(({ name, connection }) => ({ name, ...connection }))
  assert.equal(configHasSubscriptionSecret({ proxies }, secrets), false)
  assert.equal(configHasSubscriptionSecret({ proxies: [{ ...proxies[1], name: 'very%2Dprivate' }] }, secrets), true)
  assert.equal(configHasSubscriptionSecret({ proxies: [{ ...proxies[1], password: upstream }] }, secrets), true)
  assert.equal(configHasSubscriptionSecret({ proxies: [{ ...proxies[1], 'subscription-token': 'very-private' }] }, secrets), true)
  assert.equal(configHasSubscriptionSecret({ proxies, rules: ['DOMAIN-KEYWORD,very-private,DIRECT'] }, secrets), true)
  assert.equal(containsSubscriptionSecret({ host: 'test?token=very%2Dprivate' }, secrets), true)
  assert.equal(containsSubscriptionSecret(['ss', 'Hong-Kong', 'clash-meta'], secrets), false)
})

test('Hysteria2 YAML normalizes the port hopping alias to Mihomo ports', () => {
  const ports = '443,20000-20100'
  const hysteria2 = { type: 'hysteria2', server: 'edge.example.net', port: 443, password: 'node-private-credential' }
  const payload = parse([
    { ...hysteria2, name: 'Mihomo', ports },
    { ...hysteria2, name: 'Alias', mport: ports },
    { ...hysteria2, name: 'Duplicate', mport: ports, ports },
    { ...hysteria2, name: 'Native precedence', ports, mport: '20443' },
  ])
  assert.deepEqual(payload.rejected, [])
  assert.deepEqual(payload.nodes.map(({ connection }) => connection), Array.from({ length: 4 }, () => ({ ...hysteria2, ports })))
})

test('plain and Base64 links preserve the fragment and connection credentials', () => {
  const creds = Buffer.from('aes-128-gcm:fixture-password').toString('base64url')
  const uri = 'ss://' + creds + '@edge.example.net:443#' + encodeURIComponent(rawName)
  const data = parseSource(Buffer.from(Buffer.from(uri).toString('base64')), [])
  assert.equal(data.nodes[0].name, rawName)
  assert.equal(data.nodes[0].connection.password, 'fixture-password')
  assert.equal(data.format, 'Base64 分享链接')
  const vmess = { ps: '东京 A', add: 'example.net', port: '443', id: 'ad316e0d-6b02-4d7d-926d-617cd449d405', aid: '0', net: 'ws', tls: 'tls', path: '/edge' }
  const plain = parseSource(Buffer.from('vmess://' + Buffer.from(JSON.stringify(vmess)).toString('base64')), [])
  assert.equal(plain.nodes[0].connection['ws-opts'].path, '/edge')
})

test('SSR links preserve IPv6, Unicode names, and protocol and obfuscation parameters', () => {
  const encode = text => Buffer.from(text).toString('base64url')
  const endpoint = '[2001:db8::42]:443:auth_aes128_sha1:aes-128-ctr:http_simple:' + encode('凭据:fixture')
  const params = new URLSearchParams({ remarks: encode(rawName), protoparam: encode('7:fixture'), obfsparam: encode('cdn.example.net') })
  const link = 'ssr://' + encode(endpoint + '/?' + params)
  const data = parseSource(Buffer.from(encode(link)), [], 'links')
  assert.deepEqual(data.rejected, [])
  assert.equal(data.nodes[0].name, rawName)
  assert.deepEqual(data.nodes[0].connection, {
    type: 'ssr', server: '2001:db8::42', port: 443, protocol: 'auth_aes128_sha1', cipher: 'aes-128-ctr',
    obfs: 'http_simple', password: '凭据:fixture', udp: true, 'protocol-param': '7:fixture', 'obfs-param': 'cdn.example.net',
  })
  const unnamed = parseSource(Buffer.from('ssr://' + encode(endpoint)), [])
  assert.equal(unnamed.nodes[0].name, '[2001:db8::42]:443')
  assert.equal(parseSource(Buffer.from('ssr://' + encode('bad endpoint')), [], 'links').rejected.length, 1)
})

test('pasted formats stay distinct and report invalid entries alongside usable links', () => {
  const yamlList = Buffer.from(stringify([node('香港 01'), node('香港 02')]).replace(/^./gm, '  $&'))
  const link = 'vless://ad316e0d-6b02-4d7d-926d-617cd449d405@edge.example.net:443#Tokyo'
  const unnamedSS = 'ss://' + Buffer.from('aes-128-gcm:fixture@[2001:db8::1]:8443').toString('base64url')
  const unnamed = Buffer.from([unnamedSS, link.split('#')[0]].join('\n'))
  assert.deepEqual(parseSource(unnamed, [], 'links').nodes.map(node => node.name), ['[2001:db8::1]:8443', 'edge.example.net:443'])
  assert.equal(parseSource(unnamed, []).nodes.length, 0)
  assert.deepEqual(parseSource(yamlList, [], 'yaml').nodes.map(node => node.name), ['香港 01', '香港 02'])
  assert.throws(() => parseSource(yamlList, [], 'links'), /节点分享链接/)
  assert.throws(() => parseSource(Buffer.from(link), [], 'yaml'), /YAML 配置需要包含/)
  const mixed = 'invalid first row\r\n\r\n  ' + link + '\r\nssr://!!!'
  for (const text of [mixed, Buffer.from(mixed).toString('base64')]) {
    const data = parseSource(Buffer.from(text), [], 'links')
    assert.equal(data.total, 3)
    assert.deepEqual(data.nodes.map(node => node.name), ['Tokyo'])
    assert.deepEqual(data.rejected.map(row => row.item), ['第 1 项', '第 3 项'])
  }
})

test('rule providers compile locally without an upstream request from the client', () => {
  const data = parseProvider(Buffer.from('payload:\n  - "+.github.com"\n  - github.io\n'), { behavior: 'domain', format: 'yaml' })
  const entry = { ...service('provider-a', 'DIRECT'), provider: { behavior: 'domain', url: 'https://provider.example/list' } }
  const rules = [rule('r1', entry.id, 'RULE-SET', '')]
  const compiled = evaluate({ ...blankDraft(), services: [entry], rules }, {}, { [entry.id]: data }, true)
  assert.equal(compiled.config['rule-providers'][entry.id].type, 'inline')
  assert.equal(compiled.config['rule-providers'][entry.id].url, undefined)
  assert.equal(testDomain(compiled, 'api.github.com', { [entry.id]: data }, 'rule').match.id, 'r1')
  assert.equal(testDomain(compiled, 'one.github.io', { [entry.id]: data }, 'rule').match, null)
  assert.throws(() => parseProvider(Buffer.from('bad IP format'), { behavior: 'ipcidr', format: 'text' }), /不兼容/)
})

test('inline routing rules, independent listeners and DNS mappings survive a draft round trip', () => {
  const draft = blankDraft()
  const entry = { ...service('port-overrides', 'DIRECT'), provider: null, inlineRules: ['DST-PORT,25', 'DOMAIN-SUFFIX,cdn.example'] }
  draft.services.push(entry)
  draft.rules.push(rule('outlet-rule', entry.id, 'RULE-SET', ''))
  Object.assign(draft.base, { port: 0, httpPort: 7890, socksPort: 7891, controllerPort: 9090, hosts: ['clock.example 192.0.2.1'] })
  Object.assign(draft.base.dns, { enabled: true, nameserverPolicy: ['+.example.org tcp://dns.example:8053 192.0.2.2'] })
  const saved = draftSchema.parse(draft)
  const { config, issues } = evaluate(saved, {}, {}, true)
  assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [])
  assert.deepEqual(config.rules, ['RULE-SET,port-overrides,DIRECT'])
  assert.deepEqual(config['rule-providers'][entry.id], { type: 'inline', behavior: 'classical', payload: entry.inlineRules })
  assert.deepEqual([config['mixed-port'], config.port, config['socks-port'], config['external-controller']], [0, 7890, 7891, '127.0.0.1:9090'])
  assert.deepEqual(config.hosts, { 'clock.example': '192.0.2.1' })
  assert.deepEqual(config.dns['nameserver-policy'], { '+.example.org': ['tcp://dns.example:8053', '192.0.2.2'] })
  entry.inlineRules = ['DST-PORT,65536']
  assert.equal(draftSchema.safeParse(draft).success, false)
  saved.base.socksPort = saved.base.httpPort
  saved.base.dns.nameserverPolicy = ['+.example.org']
  assert.deepEqual(evaluate(saved, {}).issues.filter(issue => issue.severity === 'error').map(issue => issue.code), ['base-ports', 'dns-policy'])
})

test('catalog previews respect priority, unavailable domain lists, IP uncertainty and disabled rules', async () => {
  const services = ['geoip/telegram', 'geosite/netflix', 'geosite/github'].map((key, index) => ({
    ...service('service-' + index, 'DIRECT'), ruleSet: key,
  }))
  const rules = services.map((entry, index) => rule('rule-' + index, entry.id, 'RULE-SET', ''))
  const draft = { ...blankDraft(), services, rules }
  const compiled = evaluate(draft, {}, {}, true)
  assert.deepEqual(compiled.config.rules, services.map(entry => 'RULE-SET,' + entry.ruleSet + ',DIRECT'))
  const requests = []
  const match = createRuleSetMatcher(async key => {
    requests.push(key)
    if (key === 'geosite/netflix') throw new Error('unavailable fixture')
    return '+.github.com\ngithub.io'
  })
  const result = await match(compiled, 'api.github.com', {}, 'rule')
  assert.equal(result.match.serviceId, services[2].id)
  assert.deepEqual(result.uncertain.map(row => row.value), ['geoip/telegram', 'geosite/netflix'])
  assert.equal((await match(compiled, 'sub.github.io', {}, 'rule')).match, null)
  assert.deepEqual(requests, ['geosite/netflix', 'geosite/github'])
  const disabled = evaluate({ ...draft, rules: rules.map(row => ({ ...row, enabled: false })) }, {}, {}, true)
  assert.equal(disabled.config['rule-providers'], undefined)
  assert.ok(!disabled.issues.some(issue => issue.code === 'rule-set-row'))
})
