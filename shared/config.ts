import type { Base, Draft, EvaluatedRule, FilteredNode, Group, Issue, MatchResult, MihomoConfig, ProjectedMember, Projection, ProviderData, ProviderMap, ReportIssue, Rule, RuleProvider, Source, SourceData, SourceMap } from './model.ts'
import ipaddr from 'ipaddr.js'
import { builtins, regionLabel, reservedNames, ruleTypes } from './catalog.ts'
import type { QualitySnapshot } from './quality-snapshot.ts'
import { resolvePool, memberSourceIds } from './group-filter.ts'
import { isCatalogRuleSet, publicRuleProvider } from './rule-sets.ts'

const invalidRuleChars = /[,\u0000-\u001f\u007f]/
const invalidNameChars = /[\u0000-\u001f\u007f]/
const isBuiltin = (id: string) => Object.hasOwn(builtins, id)
export const nodeKey = (sourceId: string, nodeId: string) => sourceId + '/' + nodeId

export function draftDataset<T>(record?: { pending?: { accepted: boolean; data?: T | null } | null; good?: T | null } | null) {
  return record?.pending?.accepted ? record.pending.data : record?.good
}

export function filterNodes(source: Source, dataset?: Pick<SourceData, 'nodes'> | null): FilteredNode[] {
  const { filter } = source
  const keep = new Set(filter.keep)
  const drop = new Set(filter.exclude)
  const manual = new Set(filter.manual)
  const keywords = filter.keywords.map(word => [word, word.toLowerCase()])
  return (dataset?.nodes ?? []).map(raw => {
    const reasons = []
    const unknown = raw.region === 'unknown'
    if (unknown && filter.unknown === 'exclude') reasons.push('排除未知地区')
    if (keep.size && !keep.has(raw.region) && !(unknown && filter.unknown === 'keep')) reasons.push('非所选地区')
    if (drop.has(raw.region)) reasons.push('排除地区「' + regionLabel(raw.region) + '」')
    const lower = raw.name.toLowerCase()
    for (const [word, match] of keywords) {
      if (match && lower.includes(match)) reasons.push('名称包含「' + word + '」')
    }
    if (manual.has(raw.id)) reasons.push('已手动排除')
    if (!source.enabled) reasons.push('订阅源已停用')
    return {
      key: nodeKey(source.id, raw.id), id: raw.id, sourceId: source.id, sourceName: source.name,
      originalName: raw.name, name: source.tag + raw.name, type: raw.type, region: raw.region,
      kept: !reasons.length, reasons, fingerprint: raw.fingerprint, raw,
    }
  })
}

export function normalizeDomain(value: string) {
  const input = value.trim().replace(/\.$/, '')
  if (!input || /[\s/:?#[\]@\\%]/u.test(input)) return ''
  try {
    const domain = new URL('http://' + input).hostname.toLowerCase()
    if (domain.length > 253 || ipaddr.isValid(domain)) return ''
    return domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? domain : ''
  } catch {
    return ''
  }
}

export function parseRange(value: string) {
  try {
    return ipaddr.parseCIDR(value)
  } catch {
    return null
  }
}

export function ruleValue(type: string, raw: string) {
  const value = raw.trim()
  if (type === 'MATCH' || type === 'RULE-SET') return ''
  if (!value || invalidRuleChars.test(value)) return null
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    if (type === 'DOMAIN-SUFFIX' && value.startsWith('+.')) {
      const hostname = normalizeDomain(value.slice(2))
      return hostname ? '+.' + hostname : null
    }
    return normalizeDomain(type === 'DOMAIN-SUFFIX' ? value.replace(/^\*?\./, '') : value) || null
  }
  if (type === 'DOMAIN-KEYWORD') return /\s/.test(value) ? null : value.toLowerCase()
  if (type === 'DST-PORT') return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? String(Number(value)) : null
  if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
    const cidr = parseRange(value)
    return cidr?.[0].kind() === (type === 'IP-CIDR' ? 'ipv4' : 'ipv6') ? value : null
  }
  if (type === 'GEOIP' || type === 'GEOSITE') {
    return /^[a-z0-9_-]+(?:@[a-z0-9_-]+)?$/i.test(value) ? value.toLowerCase() : null
  }
  if (type === 'PROCESS-NAME' || type === 'PROCESS-PATH') return value
  return null
}

export function classicalEntry(line: string): string | null {
  const [type, input, option, ...rest] = line.split(',').map(part => part.trim())
  if (!input || rest.length || (option !== undefined && !(option === 'no-resolve' && ['IP-CIDR', 'IP-CIDR6', 'GEOIP'].includes(type)))) return null
  let value = ruleValue(type, input)
  // DNS rules can also match wire-format names with non-hostname labels.
  if (!value && ['DOMAIN', 'DOMAIN-SUFFIX'].includes(type) && input.length <= 253 && input.split('.').every(label => /^[a-z0-9_-]{1,63}$/i.test(label))) value = input.toLowerCase()
  return value ? [type, value, ...(option ? [option] : [])].join(',') : null
}

function mapList<T>(entries: T[], key: (entry: T) => string) {
  const result = new Map<string, T[]>()
  for (const entry of entries) {
    const value = key(entry)
    if (!value) continue
    if (!result.has(value)) result.set(value, [])
    result.get(value)!.push(entry)
  }
  return result
}

export function groupReferences(draft: Draft, id: string) {
  return [
    ...draft.groups.filter(group => group.id !== id && group.members.some(member => member.kind === 'group' && member.id === id))
      .map(group => ({ id: group.id, name: group.name, pane: 'groups' })),
    ...draft.services.filter(service => service.target === id).map(service => ({ id: service.id, name: service.name, pane: 'rules' })),
  ]
}

export function sourceReferences(draft: Pick<Draft, 'groups'>, id: string) {
  return draft.groups.filter(group => group.members.some(member => memberSourceIds(member).includes(id)))
}

function groupCycles(groups: Group[]) {
  const byId = new Map(groups.map(group => [group.id, group]))
  const state = new Map()
  const cycles = new Set<string>()
  const stack: string[] = []
  function visit(id: string) {
    if (!byId.has(id)) return
    if (state.get(id) === 'active') {
      for (const member of stack.slice(stack.indexOf(id))) cycles.add(member)
      return
    }
    if (state.has(id)) return
    state.set(id, 'active')
    stack.push(id)
    for (const member of byId.get(id)!.members) {
      if (member.kind === 'group') visit(member.id)
    }
    stack.pop()
    state.set(id, 'done')
  }
  for (const group of groups) visit(group.id)
  return cycles
}

export function structuralGroupIssues(draft: Draft) {
  const groupIds = new Set(draft.groups.map(group => group.id))
  const sourceIds = new Set(draft.sources.map(source => source.id))
  const cycles = groupCycles(draft.groups)
  const duplicateNames = mapList(draft.groups, group => group.name)
  const issues = new Map<string, string>()
  for (const group of draft.groups) {
    if (cycles.has(group.id)) issues.set(group.id, '代理组存在循环引用，请移除一条组间引用。')
    else if (reservedNames.has(group.name) || invalidRuleChars.test(group.name)) issues.set(group.id, '组名不能使用保留名称、逗号或控制字符。')
    else if ((duplicateNames.get(group.name)?.length ?? 0) > 1) issues.set(group.id, '组名已被另一个代理组使用。')
    else if (group.members.some(member => member.kind === 'group' && !groupIds.has(member.id))) issues.set(group.id, '列表中引用的代理组已删除，请移除该项。')
    else if (group.members.some(member => memberSourceIds(member).some(id => !sourceIds.has(id)))) issues.set(group.id, '组内代理引用了已删除的订阅源，请重新选择。')
    else if (group.type !== 'select' && group.members.some(member => member.kind === 'builtin' && member.id !== 'DIRECT')) issues.set(group.id, '请移除组内的拒绝策略，或将代理组类型改为「手动选择」。')
  }
  return issues
}

function checkGroups(draft: Draft, rows: FilteredNode[], issue: ReportIssue, quality: QualitySnapshot | null) {
  const byGroup = new Map(draft.groups.map(group => [group.id, group]))
  const nodes = new Map(rows.map(row => [row.key, row]))
  const retained = rows.filter(row => row.kept)
  const retainedNames = new Set(retained.map(row => row.name))
  for (const [id, message] of structuralGroupIssues(draft)) issue('error', 'groups', id, 'group-structure', message)
  return draft.groups.map(group => {
    const addIssue = (code: string, message: string) => issue('error', 'groups', group.id, code, message)
    const members: ProjectedMember[] = []
    const seen = new Set()
    const add = (key: string, name: string, kind: ProjectedMember['kind']) => {
      if (seen.has(key)) return
      seen.add(key)
      members.push({ key, name, kind })
    }
    for (const member of group.members) {
      if (member.kind === 'pool') {
        const filter = resolvePool(member, retained, quality)
        if (filter.includeError || filter.excludeError) addIssue('group-filter', filter.includeError ? '包含正则：' + filter.includeError : '排除正则：' + filter.excludeError)
        else {
          if (filter.emptied && group.enabled) issue('warning', 'groups', group.id, 'pool-quality-empty',
            '「' + group.name + '」的质量条件排除了全部 ' + filter.candidates.length + ' 个候选节点。' + (filter.fallback ? '已按来源、地区和名称条件兜底。' : '请调整阈值或补测节点。'))
          for (const row of filter.matches) add(row.key, row.name, 'node')
        }
      }
      if (member.kind === 'node') {
        const row = nodes.get(nodeKey(member.sourceId, member.id))
        if (row?.kept) add(row.key, row.name, 'node')
        else if (group.enabled) addIssue('group-node', '选中的节点「' + (row?.name ?? '已移除') + '」不可用。请恢复节点或将其移出代理组。')
      }
      if (member.kind === 'group') {
        const target = byGroup.get(member.id)
        if (target?.enabled) add(member.id, target.name, 'group')
        else if (group.enabled && target) addIssue('group-disabled', '引用的代理组「' + target.name + '」已停用，请启用或移除引用。')
      }
      if (member.kind === 'builtin') add(member.id, member.id, 'builtin')
    }
    if (group.enabled && !members.length) addIssue('group-empty', '此代理组缺少可用代理。请添加节点、代理组或内置策略，或停用此组。')
    if (group.enabled && retainedNames.has(group.name)) addIssue('group-name', '组名和保留节点的最终名称相同。请更换组名或调整节点名称前缀。')
    return { id: group.id, name: group.name, enabled: group.enabled, type: group.type, members }
  })
}

function coverByDomain(row: EvaluatedRule, exact: Map<string, EvaluatedRule>, suffix: Map<string, EvaluatedRule>, keywords: EvaluatedRule[]) {
  if (row.type === 'DOMAIN') {
    const same = exact.get(row.value)
    if (same) return same
  }
  if (row.type === 'DOMAIN' || row.type === 'DOMAIN-SUFFIX') {
    const labels = row.value.split('.')
    for (let i = 0; i < labels.length; i++) {
      const match = suffix.get(labels.slice(i).join('.'))
      if (match) return match
    }
  }
  if (row.type.startsWith('DOMAIN')) {
    return keywords.find(earlier => row.value.includes(earlier.value))
  }
}

function checkRules(draft: Draft, ruleData: ProviderMap, issue: ReportIssue) {
  const byGroup = new Map(draft.groups.map(group => [group.id, group]))
  const byService = new Map(draft.services.map(service => [service.id, service]))
  const emitted: EvaluatedRule[] = []
  const ruleProviders: Record<string, RuleProvider> = Object.create(null)
  const seen = new Map()
  const exact = new Map()
  const suffix = new Map()
  const keywords: EvaluatedRule[] = []
  const serviceUsed = new Set()
  let catchAll: EvaluatedRule | undefined
  for (const entry of draft.rules) {
    const service = byService.get(entry.serviceId)
    if (!service) {
      issue('error', 'rules', entry.id, 'rule-service', '这条规则所属的服务已删除，请重新分配或移除规则。')
      continue
    }
    if (!entry.enabled || !service.enabled) continue
    serviceUsed.add(service.id)
    const report = (severity: Issue['severity'], code: string, message: string) => issue(severity, 'rules', service.id, code, message, entry.id)
    const group = byGroup.get(service.target)
    if (!isBuiltin(service.target) && !group?.enabled) {
      report('error', 'rule-target', '服务「' + service.name + '」的出站策略不存在或已停用，请重新选择。')
      continue
    }
    const value = ruleValue(entry.type, entry.value)
    if (!Object.hasOwn(ruleTypes, entry.type) || value === null) {
      report('error', 'rule-value', '服务「' + service.name + '」包含无效的匹配值。请检查匹配方式及输入。')
      continue
    }
    let matchValue = value
    if (entry.type === 'RULE-SET' && service.ruleSet) {
      if (!isCatalogRuleSet(service.ruleSet)) {
        report('error', 'rule-set', '规则集「' + service.ruleSet + '」不在当前目录中，请更换或停用。')
        continue
      }
      matchValue = service.ruleSetAlias ?? service.ruleSet
      const definition = publicRuleProvider(service.ruleSet, service.ruleSetAlias)
      const previous = ruleProviders[matchValue]
      if (previous && (previous.type !== 'http' || previous.url !== definition.url)) {
        report('error', 'rule-set-alias', '规则集名称重复，请使用不同的名称。')
        continue
      }
      ruleProviders[matchValue] = definition
    } else if (entry.type === 'RULE-SET') {
      const data = service.inlineRules ? { behavior: 'classical', payload: service.inlineRules } : ruleData[service.id]
      if ((!service.provider && !service.inlineRules) || !data?.payload?.length) {
        report('error', 'rule-set', '规则集「' + service.name + '」没有可用内容，请测试地址或停用规则集。')
        continue
      }
      if (ruleProviders[service.id]?.type === 'http') {
        report('error', 'rule-set-alias', '规则集名称与内嵌规则集重复。')
        continue
      }
      ruleProviders[service.id] = { type: 'inline', behavior: service.provider?.behavior ?? 'classical', payload: data.payload }
      matchValue = service.id
    }
    const noResolve = entry.noResolve && ['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'RULE-SET'].includes(entry.type)
    const row = {
      ...entry, value: matchValue, noResolve,
      ...(entry.type === 'RULE-SET' && service.ruleSetAlias ? { catalogKey: service.ruleSet } : {}),
      position: emitted.length + 1, service: service.name,
      target: group?.name ?? service.target, outlet: group?.name ?? builtins[service.target],
    }
    const key = row.type + ':' + row.value + ':' + row.noResolve
    const duplicate = seen.get(key)
    const earlier = duplicate ?? catchAll ?? coverByDomain(row, exact, suffix, keywords)
    if (earlier) {
      report('warning', duplicate ? 'rule-duplicate' : 'rule-shadow',
        '「' + service.name + '」第 ' + row.position + ' 条规则被第 ' + earlier.position + ' 条「' + earlier.service
        + '」' + (duplicate ? '重复匹配' : '优先匹配') + '。请调整优先级或禁用重复项。')
    }
    if (row.type === 'MATCH' && !catchAll) catchAll = row
    if (row.type === 'DOMAIN' && !exact.has(row.value)) exact.set(row.value, row)
    if (row.type === 'DOMAIN-SUFFIX' && !suffix.has(row.value)) suffix.set(row.value, row)
    if (row.type === 'DOMAIN-KEYWORD') keywords.push(row)
    seen.set(key, duplicate ?? row)
    emitted.push(row)
  }
  if (catchAll && catchAll.position < emitted.length) {
    issue('warning', 'rules', catchAll.serviceId, 'rule-match-order', 'MATCH 会匹配所有请求。请将它移至规则列表末尾，以便后续规则生效。', catchAll.id)
  }
  for (const service of draft.services) {
    if (!service.enabled) continue
    if (!serviceUsed.has(service.id) && (service.provider || service.inlineRules)) {
      issue('error', 'rules', service.id, 'rule-set-row', '规则集需要一条启用的匹配规则。')
    } else if (!serviceUsed.has(service.id) && !service.ruleSet) {
      issue('warning', 'rules', service.id, 'rule-empty', '服务「' + service.name + '」没有启用的规则。')
    }
  }
  return { rules: emitted, ruleProviders }
}

function validDnsAddress(input: string, bootstrap: boolean) {
  if (!input || /[\s,]/.test(input)) return false
  if (ipaddr.isValid(input)) return true
  const value = input.split('#', 1)[0]
  try {
    const hasScheme = value.includes('://')
    const url = new URL(hasScheme ? value : 'udp://' + value)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (url.username || url.password || !hostname || (!ipaddr.isValid(hostname) && !normalizeDomain(hostname))) return false
    if (bootstrap && !ipaddr.isValid(hostname)) return false
    if (!['https:', 'tls:', 'quic:', 'tcp:', 'udp:'].includes(url.protocol)) return false
    if (url.port && !(Number(url.port) > 0 && Number(url.port) <= 65535)) return false
    return url.protocol === 'https:' || (!url.pathname && !url.search)
  } catch {
    return false
  }
}

function parseMappings(lines: string[] | undefined, validAddress: (value: string) => boolean) {
  const mappings = new Map()
  for (const [i, line] of (lines ?? []).entries()) {
    const [domain, ...addresses] = line.trim().split(/\s+/)
    const pattern = domain.toLowerCase()
    if (!normalizeDomain(pattern.replace(/^(?:\+|\*)?\./, '')) || mappings.has(pattern) || !addresses.length || !addresses.every(validAddress)) return { invalidLine: i + 1 }
    mappings.set(pattern, addresses.length === 1 ? addresses[0] : addresses)
  }
  return { values: Object.fromEntries(mappings) }
}

export function networkIssues(base: Base, rules: Pick<Rule, 'type'>[]) {
  const dns = base.dns
  const issues: Issue[] = []
  const issue = (severity: Issue['severity'], code: string, message: string) => issues.push({ severity, pane: 'settings', id: null, code, message, relatedId: undefined })
  const fail = (code: string, message: string) => issue('error', code, message)
  const ports = [base.port, base.httpPort, base.socksPort, base.controllerPort].filter(Boolean)
  if (new Set(ports).size !== ports.length) fail('base-ports', '启用的监听端口必须各不相同。')
  const hosts = parseMappings(base.hosts, address => ipaddr.isValid(address))
  if (hosts.invalidLine) fail('dns-hosts', 'Hosts 映射第 ' + hosts.invalidLine + ' 行需要唯一的域名和有效 IP 地址。')
  const policy = parseMappings(dns.nameserverPolicy, address => validDnsAddress(address, false))
  if (policy.invalidLine) fail('dns-policy', '按域名指定 DNS 的第 ' + policy.invalidLine + ' 行需要唯一的域名和有效 DNS 地址。')
  if (dns.enabled) {
    if (!dns.nameservers.length) fail('dns-empty', '已启用 DNS，至少填写一个解析服务器。')
    if (!dns.bootstrap.length || dns.bootstrap.some(address => !validDnsAddress(address, true))) fail('dns-bootstrap', '引导 DNS 必须使用 IP 地址或以 IP 为主机名的 DNS 地址。')
    if ([...dns.nameservers, ...dns.proxyNameservers, ...dns.fallback].some(address => !validDnsAddress(address, false))) fail('dns-address', '解析服务器地址格式无效。支持 IP、DoH、DoT、DoQ 和 TCP DNS。')
    if (dns.respectRules && !dns.proxyNameservers.length) fail('dns-respect', 'DNS 遵循路由规则时，请填写代理节点域名解析服务器。')
  }
  if (base.mode !== 'rule' && rules.length) issue('warning', 'base-mode', '选择「规则模式」后，连接将按路由规则匹配。')
  if (base.findProcess === 'off' && rules.some(rule => rule.type.startsWith('PROCESS-'))) {
    issue('warning', 'base-process', '进程识别已关闭，进程规则可能无法匹配。')
  }
  if (base.allowLan) issue('warning', 'base-lan', '已允许局域网访问客户端代理端口，请确认连接到可信网络。')
  return issues
}

function networkConfig(base: Base) {
  const dns = base.dns
  return {
    'mixed-port': base.port, mode: base.mode, 'log-level': base.logLevel,
    ...(base.ipv6 !== undefined ? { ipv6: base.ipv6 } : {}),
    ...(base.advanced?.profile ? { profile: base.advanced.profile } : {}),
    ...(base.advanced?.sniffer ? { sniffer: base.advanced.sniffer } : {}),
    ...(base.httpPort ? { port: base.httpPort } : {}),
    ...(base.socksPort ? { 'socks-port': base.socksPort } : {}),
    ...(base.controllerPort ? { 'external-controller': '127.0.0.1:' + base.controllerPort } : {}),
    ...(base.hosts?.length ? { hosts: parseMappings(base.hosts, address => ipaddr.isValid(address)).values } : {}),
    'allow-lan': base.allowLan, 'tcp-concurrent': base.concurrent, 'unified-delay': base.unifiedDelay,
    'find-process-mode': base.findProcess,
    dns: {
      ...base.advanced?.dns,
      enable: dns.enabled, 'enhanced-mode': dns.mode,
      ...(base.ipv6 !== undefined ? { ipv6: base.ipv6 } : {}),
      nameserver: dns.nameservers, 'default-nameserver': dns.bootstrap,
      ...(dns.useHosts !== undefined ? { 'use-hosts': dns.useHosts } : {}),
      ...(dns.respectRules !== undefined ? { 'respect-rules': dns.respectRules } : {}),
      ...(dns.nameserverPolicy?.length ? { 'nameserver-policy': parseMappings(dns.nameserverPolicy, address => validDnsAddress(address, false)).values } : {}),
      ...(dns.mode === 'fake-ip' && dns.fakeIPFilter.length ? { 'fake-ip-filter': dns.fakeIPFilter } : {}),
      ...(dns.proxyNameservers.length ? { 'proxy-server-nameserver': dns.proxyNameservers } : {}),
      ...(dns.fallback.length ? { fallback: dns.fallback } : {}),
    },
  }
}

export function evaluate(draft: Draft, sourceData: SourceMap, ruleData: ProviderMap, withConfig: true, quality?: QualitySnapshot | null): Projection & { config: MihomoConfig }
export function evaluate(draft: Draft, sourceData: SourceMap, ruleData?: ProviderMap, withConfig?: false, quality?: QualitySnapshot | null): Projection
export function evaluate(draft: Draft, sourceData: SourceMap, ruleData: ProviderMap = {}, withConfig = false, quality: QualitySnapshot | null = null): Projection & { config?: MihomoConfig } {
  const issues: Issue[] = []
  const issue: ReportIssue = (severity, pane, id, code, message, relatedId) => issues.push({ severity, pane, id, code, message, relatedId })
  const rows = []
  const sources = []
  for (const source of draft.sources) {
    const data = sourceData[source.id]
    const nodes = filterNodes(source, data)
    rows.push(...nodes)
    const retained = nodes.filter(row => row.kept).length
    sources.push({ id: source.id, name: source.name, enabled: source.enabled, original: data?.total ?? nodes.length, retained, excluded: nodes.length - retained, unknown: nodes.filter(row => row.region === 'unknown').length, unsupported: data?.rejected?.length ?? 0 })
    if (source.enabled && !nodes.length) {
      issue('error', 'sources', source.id, 'source-empty', '订阅源「' + source.name + '」没有可用节点。请刷新订阅、检查链接或停用该订阅源。')
    } else if (source.enabled && !retained) {
      issue('warning', 'sources', source.id, 'source-filtered', '订阅源「' + source.name + '」的节点均被筛除。')
    }
    if (source.enabled && data?.rejected?.length) {
      issue('warning', 'sources', source.id, 'source-partial', '订阅源「' + source.name + '」有 ' + data.rejected.length + ' 项无法导入，可在订阅源详情查看原因。')
    }
  }
  const retained = rows.filter(row => row.kept)
  if (draft.sources.some(source => source.enabled) && !retained.length) {
    issue('error', 'nodes', null, 'nodes-empty', '没有保留节点，请调整筛选条件或刷新订阅源。')
  }
  if (!draft.sources.some(source => source.enabled)) {
    issue('warning', 'sources', null, 'sources-inactive', '没有启用的订阅源。这份配置不会包含代理节点。')
  }
  const conflicts = mapList(retained, row => row.name)
  const duplicates = mapList(retained, row => row.fingerprint)
  for (const [name, matches] of conflicts) {
    if (matches.length > 1) {
      issue('error', 'nodes', matches[0].sourceId, 'node-conflict', '最终节点名「' + name + '」重名，涉及 ' + [...new Set(matches.map(row => row.sourceName))].join('、') + '。请修改节点名称前缀或手动排除节点。', matches[0].id)
    }
  }
  for (const row of retained) {
    if (reservedNames.has(row.name) || invalidNameChars.test(row.name)) {
      issue('error', 'nodes', row.sourceId, 'node-name', '节点「' + row.name + '」的最终名称使用了保留名称或包含控制字符。请调整名称前缀或排除此节点。', row.id)
    }
  }
  const groups = checkGroups(draft, rows, issue, quality)
  const { rules, ruleProviders } = checkRules(draft, ruleData, issue)
  issues.push(...networkIssues(draft.base, rules))
  const counts = { sources: sources.filter(source => source.enabled).length, nodes: retained.length, groups: groups.filter(group => group.enabled).length, rules: rules.length }
  const result: Projection & { config?: MihomoConfig } = {
    counts, sources, groups, rules, issues,
    nodes: rows.map(({ raw, fingerprint, ...row }) => ({
      ...row,
      collision: row.kept && ((conflicts.get(row.name)?.length ?? 0) > 1 || reservedNames.has(row.name)),
      duplicateCount: row.kept ? Math.max(0, (duplicates.get(fingerprint)?.length ?? 0) - 1) : 0,
      duplicates: row.kept ? (duplicates.get(fingerprint) ?? []).slice(0, 9).filter(other => other.key !== row.key).map(other => ({ key: other.key, source: other.sourceName, name: other.name })) : [],
    })),
  }
  if (withConfig) {
    const activeGroup = new Map(draft.groups.filter(group => group.enabled).map(group => [group.id, group]))
    result.config = {
      ...networkConfig(draft.base),
      proxies: retained.map(row => ({ ...row.raw.connection, name: row.name })),
      'proxy-groups': groups.filter(group => group.enabled).map(group => {
        const settings = activeGroup.get(group.id)!
        const config = { name: group.name, type: group.type, proxies: group.members.map(member => member.name), ...(settings.disableUdp ? { 'disable-udp': true } : {}) }
        if (group.type === 'select') return config
        return {
          ...config, url: settings.testUrl || 'https://cp.cloudflare.com/generate_204',
          interval: settings.seconds, lazy: settings.lazy,
          ...(group.type === 'url-test' && settings.tolerance != null ? { tolerance: settings.tolerance } : {}),
          ...(group.type === 'load-balance' ? { strategy: settings.strategy } : {}),
        }
      }),
      ...(Object.keys(ruleProviders).length ? { 'rule-providers': ruleProviders } : {}),
      rules: rules.map(rule => rule.type === 'MATCH'
        ? 'MATCH,' + rule.target
        : [rule.type, rule.value, rule.target, ...(rule.noResolve ? ['no-resolve'] : [])].join(',')),
    }
  }
  return result
}

function matchDomain(type: string, value: string, domain: string) {
  if (type === 'DOMAIN') return domain === value
  if (type === 'DOMAIN-SUFFIX') return domain === value || domain.endsWith('.' + value)
  if (type === 'DOMAIN-KEYWORD') return domain.includes(value)
  if (type === 'MATCH') return true
  return null
}

function matchProvider(data: ProviderData | null | undefined, domain: string) {
  if (!data) return null
  if (data.behavior === 'domain') {
    let unknown = false
    for (const pattern of data.payload) {
      if (pattern.startsWith('+.')) {
        if (matchDomain('DOMAIN-SUFFIX', pattern.slice(2), domain)) return true
      } else if (pattern.includes('*') || pattern.startsWith('.')) {
        unknown = true
      } else if (pattern === domain) return true
    }
    return unknown ? null : false
  }
  if (data.behavior === 'ipcidr') return null
  let unknown = false
  for (const entry of data.payload) {
    const [type, value] = entry.split(',')
    const match = matchDomain(type, value, domain)
    if (match) return true
    if (match === null) unknown = true
  }
  return unknown ? null : false
}

export function testDomain(compiled: Pick<Projection, 'rules'>, input: string, ruleData: ProviderMap, mode: string): MatchResult {
  const domain = normalizeDomain(input)
  if (!domain) return { error: '请输入域名，例如 api.github.com。' }
  if (mode !== 'rule') return { domain, match: null, uncertain: [], mode, message: '要按路由规则匹配，请在基础设置中选择「规则模式」。' }
  const uncertain = []
  for (const rule of compiled.rules) {
    const match = rule.type === 'RULE-SET'
      ? matchProvider(ruleData[rule.serviceId], domain)
      : matchDomain(rule.type, rule.value, domain)
    if (match) return { domain, match: rule, uncertain }
    if (match === null) uncertain.push(rule)
  }
  return { domain, match: null, uncertain }
}
