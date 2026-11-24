import { z } from 'zod'
import { surfaces } from '../shared/quality-options.ts'
import { platforms, qualitySorts } from '../shared/quality-snapshot.ts'
import { qualityKey } from '../shared/quality.ts'
import { regions } from '../shared/catalog.ts'
import { compilePoolPattern, maxPatternLength } from '../shared/group-filter.ts'
import { classicalEntry } from '../shared/config.ts'

export function objectValue(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

const text = (max = 256) => z.string().max(max)
const name = text().trim().min(1)
const array = <T extends z.ZodType>(schema: T, max = 200) => z.array(schema).max(max)
const minutes = z.number().int().min(1).max(43200)
const region = z.enum(regions.map(([id]) => id))
export const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
export const url = text(8192).refine(value => {
  if (!value) return true
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
})
export const filter = z.object({
  keep: array(region, 60), exclude: array(region, 60), keywords: array(name, 200),
  manual: array(id, 16000), unknown: z.enum(['auto', 'keep', 'exclude']),
})
export const source = z.object({
  id, name, url, tag: text(), enabled: z.boolean(), paused: z.boolean(), minutes, filter,
  local: z.literal(true).optional(),
  renewalDate: z.iso.date().optional(),
})
const groupPattern = text(maxPatternLength).refine(value => !compilePoolPattern(value).error, '请填写有效的 RE2 正则表达式。')
const qualityCondition = z.strictObject({
  alive: z.boolean().optional(), minAvailability: z.number().min(0).max(1).optional(),
  maxLatencyMs: z.number().min(0).max(600000).optional(),
  maxLossRate: z.number().min(0).max(1).optional(), minBandwidthMbps: z.number().min(0).max(1000000).optional(),
  aiAll: z.boolean().optional(), aiSurfaces: z.array(z.enum(surfaces)).max(surfaces.length).optional(),
  platforms: z.array(z.enum(surfaces)).max(surfaces.length).optional(),
  exitRegions: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250).optional(),
  excludeExitRegions: z.boolean().optional(), maxJitterMs: z.number().min(0).max(600000).optional(),
  aiPlatforms: z.array(z.enum(platforms)).max(platforms.length).optional(), minUnlockLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  sortBy: z.enum(qualitySorts).optional(), sortReverse: z.boolean().optional(), topN: z.number().int().min(1).max(16000).optional(),
  relaxWhenEmpty: z.boolean().optional(),
  untestedPolicy: z.enum(['include', 'exclude']).optional(), fallbackWhenEmpty: z.boolean().optional(),
})
const pool = z.object({
  kind: z.literal('pool'), regions: array(region, 60),
  sourceId: z.union([id, z.literal('')]).optional(), sourceIds: array(id).optional(),
  includeRegex: groupPattern.optional(), excludeRegex: groupPattern.optional(), quality: qualityCondition.optional(),
  search: text(256).optional(), noteMatches: z.array(qualityKey).max(16000).optional(), nodeKeys: z.array(qualityKey).max(16000).optional(),
}).refine(value => (value.sourceIds !== undefined) !== (value.sourceId !== undefined), '请选择来源。')
const member = z.discriminatedUnion('kind', [
  pool,
  z.object({ kind: z.literal('node'), sourceId: id, id }),
  z.object({ kind: z.literal('group'), id }),
  z.object({ kind: z.literal('builtin'), id: z.enum(['DIRECT', 'REJECT', 'REJECT-DROP']) }),
])
export const group = z.object({
  id, name, type: z.enum(['select', 'url-test', 'fallback', 'load-balance']),
  enabled: z.boolean(), members: array(member, 16000), testUrl: url.default(''),
  qualityDeviceId: z.uuid().nullable().optional(),
  seconds: z.number().int().min(10).max(86400).default(300),
  tolerance: z.number().int().min(0).max(60000).nullable().default(50),
  strategy: z.enum(['consistent-hashing', 'round-robin', 'sticky-sessions']).default('consistent-hashing'),
  lazy: z.boolean().default(true), disableUdp: z.boolean().default(false),
})
export const provider = z.object({
  url, behavior: z.enum(['domain', 'ipcidr', 'classical']), format: z.enum(['yaml', 'text']), minutes,
})
export const service = z.object({
  id, name, enabled: z.boolean(), target: text(64), provider: provider.nullable(),
  ruleSet: text(96).regex(/^(?:geosite|geoip)\/[a-z0-9][a-z0-9_.@!+-]*$/i).optional(),
  ruleSetAlias: text(96).regex(/^[a-z0-9][a-z0-9_@!+-]*$/i).optional(),
  inlineRules: array(text(2048).transform((line, ctx) => {
    const entry = classicalEntry(line)
    if (entry) return entry
    ctx.addIssue({ code: 'custom', message: '规则集条目的匹配方式或匹配值无效。' })
    return z.NEVER
  }), 100000).min(1).optional(),
  preset: z.object({ id: text(64), version: z.number().int().positive() }).nullable().default(null),
}).refine(value => [value.ruleSet, value.provider, value.inlineRules].filter(Boolean).length <= 1, '每个服务只能使用一个规则集来源。')
  .refine(value => !value.ruleSetAlias || value.ruleSet, '规则集别名需要对应的目录规则集。')
export const rule = z.object({ id, serviceId: id, type: text(40), value: text(2048), enabled: z.boolean(), noResolve: z.boolean() })
const port = z.number().int().min(0).max(65535)
const mappings = array(text(4096), 512)
const portRange = text(11).regex(/^\d{1,5}-\d{1,5}$/).refine(value => {
  const [first, last] = value.split('-').map(Number)
  return first >= 1 && first <= last && last <= 65535
})
const sniffPorts = z.strictObject({
  ports: array(z.union([port.min(1), portRange]), 64),
  'override-destination': z.boolean().optional(),
})
const advanced = z.strictObject({
  profile: z.strictObject({ 'store-selected': z.boolean().optional(), 'store-fake-ip': z.boolean().optional() }).optional(),
  sniffer: z.strictObject({
    enable: z.boolean(), 'parse-pure-ip': z.boolean().optional(),
    sniff: z.strictObject({ TLS: sniffPorts.optional(), HTTP: sniffPorts.optional(), QUIC: sniffPorts.optional() }),
  }).optional(),
  dns: z.strictObject({
    listen: text(256).optional(), 'use-system-hosts': z.boolean().optional(), 'fake-ip-range': text(64).optional(),
    'fallback-filter': z.strictObject({
      geoip: z.boolean().optional(), 'geoip-code': text(8).optional(), ipcidr: array(text(128), 512).optional(), domain: array(text(256), 512).optional(),
    }).optional(),
  }).optional(),
})
const base = z.object({
  mode: z.enum(['rule', 'global', 'direct']),
  logLevel: z.enum(['silent', 'error', 'warning', 'info', 'debug']),
  port, httpPort: port.optional(), socksPort: port.optional(), controllerPort: port.optional(),
  hosts: mappings.optional(), ipv6: z.boolean().optional(), allowLan: z.boolean(), advanced: advanced.optional(),
  concurrent: z.boolean(), unifiedDelay: z.boolean(), findProcess: z.enum(['strict', 'always', 'off']),
  dns: z.object({
    enabled: z.boolean(), mode: z.enum(['fake-ip', 'redir-host']),
    nameservers: array(text(1024), 64), bootstrap: array(text(1024), 64), proxyNameservers: array(text(1024), 64),
    fakeIPFilter: array(text(), 512), respectRules: z.boolean().optional(), useHosts: z.boolean().optional(), fallback: array(text(1024), 64),
    nameserverPolicy: mappings.optional(),
  }),
})

export const draft = z.object({
  sources: array(source), groups: array(group), services: array(service, 1000),
  rules: array(rule, 15000), base,
}).superRefine((value, ctx) => {
  for (const [field, entries] of Object.entries({ sources: value.sources, groups: value.groups, services: value.services, rules: value.rules })) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
      ctx.addIssue({ code: 'custom', path: [field], message: '包含重复标识' })
    }
  }
})

export const nodeNote = z.object({ favorite: z.boolean(), note: text(512) })
export const library = z.object({
  filters: array(z.object({ id, name, filter }), 100),
  groups: array(z.object({ id, name, groups: array(group) }), 100),
  providers: array(z.object({ id, name, ...provider.shape }), 100),
})

export class UserError extends Error {
  status: number
  detail: unknown
  constructor(message: string, status = 400, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

export function read<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const path = result.error.issues[0]?.path.join('.')
    throw new UserError(path ? '无法保存，请检查字段 ' + path + '。' : '数据格式无效。')
  }
  return result.data
}
