import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import type { AiResults, QualityConfig, QualityError, Surface } from './mock-probe.ts'
import type { MockProxyNode } from './mock-sub-server.ts'

export type RegionCode = 'US' | 'JP' | 'SG' | 'HK' | 'DE' | 'TW' | 'KR' | 'GB' | 'unknown'

export function uniqueId(prefix = 'id'): string {
  const cleanPrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '_')
  const suffix = randomBytes(6).toString('base64url')
  const id = `${cleanPrefix}${suffix}`
  return id.length >= 8 ? id.slice(0, 64) : id.padEnd(8, '0')
}

export interface SourceFilter {
  keep: string[]
  exclude: string[]
  keywords: string[]
  manual: string[]
  unknown: 'auto' | 'keep' | 'exclude'
}

export interface SourceFixture {
  id: string
  name: string
  url: string
  tag: string
  enabled: boolean
  paused: boolean
  minutes: number
  filter: SourceFilter
  local?: true
  renewalDate?: string
}

export function buildFilter(overrides: Partial<SourceFilter> = {}): SourceFilter {
  return {
    keep: [],
    exclude: [],
    keywords: [],
    manual: [],
    unknown: 'auto',
    ...overrides,
  }
}

export function buildSource(overrides: Partial<SourceFixture> = {}): SourceFixture {
  return {
    id: uniqueId('src_'),
    name: 'E2E 订阅源',
    url: '',
    tag: '',
    enabled: true,
    paused: false,
    minutes: 60,
    filter: buildFilter(),
    ...overrides,
  }
}

export function buildProxyNode(
  name: string,
  overrides: Omit<MockProxyNode, 'name'> = {},
): MockProxyNode {
  return {
    name,
    type: 'ss',
    server: 'node.example.net',
    port: 10001,
    cipher: 'aes-128-gcm',
    password: 'e2e-fixture-password',
    ...overrides,
  }
}

export function buildMultiRegionProxies(): MockProxyNode[] {
  return [
    buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
    buildProxyNode('🇺🇸 US-NYC-02', { server: 'us-nyc-02.example.net', port: 10002 }),
    buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10003 }),
    buildProxyNode('🇸🇬 SG-SIN-01', { server: 'sg-sin-01.example.net', port: 10004 }),
    buildProxyNode('🇭🇰 HK-HKG-01', { server: 'hk-hkg-01.example.net', port: 10005 }),
    buildProxyNode('🇩🇪 DE-FRA-01', { type: 'vless', server: 'de-fra-01.example.net', port: 10006, uuid: randomUUID() }),
  ]
}

export function buildInfoProxy(name = '剩余流量：500 GB'): MockProxyNode {
  return buildProxyNode(name, { server: 'info.example.net', port: 10099 })
}

export type QualitySort = 'https' | 'tls' | 'loss' | 'jitter' | 'speed' | 'availability' | 'ai'

export interface QualityCondition {
  // Quick AND toggles
  aiAll?: boolean
  minAvailability?: number
  maxLatencyMs?: number
  maxLossRate?: number
  // Advanced modal fields
  alive?: boolean
  maxJitterMs?: number
  minBandwidthMbps?: number
  aiSurfaces?: Surface[]
  exitRegions?: string[]
  excludeExitRegions?: boolean
  sortBy?: QualitySort
  sortReverse?: boolean
  topN?: number
  untestedPolicy?: 'include' | 'exclude'
  relaxWhenEmpty?: boolean
  fallbackWhenEmpty?: boolean
}

export function buildQualityCondition(overrides: Partial<QualityCondition> = {}): QualityCondition {
  return {
    ...overrides,
  }
}

export interface PoolMember {
  kind: 'pool'
  sourceIds: string[]
  regions: string[]
  includeRegex?: string
  excludeRegex?: string
  quality?: QualityCondition
  search?: string
  noteMatches?: string[]
  nodeKeys?: string[]
}

export type GroupMember =
  | PoolMember
  | { kind: 'node'; sourceId: string; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'builtin'; id: 'DIRECT' | 'REJECT' | 'REJECT-DROP' }

export function buildPoolMember(overrides: Partial<PoolMember> = {}): PoolMember {
  return {
    kind: 'pool',
    sourceIds: [],
    regions: [],
    includeRegex: '',
    excludeRegex: '',
    ...overrides,
  }
}

export interface ProxyGroup {
  id: string
  name: string
  type: 'select' | 'url-test' | 'fallback' | 'load-balance'
  enabled: boolean
  qualityDeviceId?: string | null
  members: GroupMember[]
  testUrl: string
  seconds: number
  tolerance: number | null
  strategy: 'consistent-hashing' | 'round-robin' | 'sticky-sessions'
  lazy: boolean
  disableUdp: boolean
}

export function buildProxyGroup(overrides: Partial<ProxyGroup> = {}): ProxyGroup {
  return {
    id: uniqueId('grp_'),
    name: 'E2E 代理组',
    type: 'select',
    enabled: true,
    qualityDeviceId: null,
    members: [buildPoolMember()],
    testUrl: 'https://www.gstatic.com/generate_204',
    seconds: 300,
    tolerance: 50,
    strategy: 'consistent-hashing',
    lazy: true,
    disableUdp: false,
    ...overrides,
  }
}

export interface BaseConfig {
  mode: 'rule' | 'global' | 'direct'
  logLevel: 'silent' | 'error' | 'warning' | 'info' | 'debug'
  port: number
  allowLan: boolean
  concurrent: boolean
  unifiedDelay: boolean
  findProcess: 'strict' | 'always' | 'off'
  dns: {
    enabled: boolean
    mode: 'fake-ip' | 'redir-host'
    nameservers: string[]
    bootstrap: string[]
    proxyNameservers: string[]
    fakeIPFilter: string[]
    fallback: string[]
  }
}

export function buildBaseConfig(overrides: Partial<BaseConfig> = {}): BaseConfig {
  return {
    mode: 'rule',
    logLevel: 'warning',
    port: 7890,
    allowLan: false,
    concurrent: true,
    unifiedDelay: true,
    findProcess: 'strict',
    dns: {
      enabled: true,
      mode: 'fake-ip',
      nameservers: ['https://1.1.1.1/dns-query', 'https://223.5.5.5/dns-query'],
      bootstrap: ['223.5.5.5', '1.1.1.1'],
      proxyNameservers: ['https://1.1.1.1/dns-query'],
      fakeIPFilter: ['*.lan', '*.local'],
      fallback: [],
    },
    ...overrides,
  }
}

export interface DraftConfig {
  sources: SourceFixture[]
  groups: ProxyGroup[]
  services: unknown[]
  rules: unknown[]
  base: BaseConfig
}

export function buildDraft(overrides: Partial<DraftConfig> = {}): DraftConfig {
  return {
    sources: [],
    groups: [],
    services: [],
    rules: [],
    base: buildBaseConfig(),
    ...overrides,
  }
}

export function buildQualityConfig(overrides: Partial<QualityConfig> = {}): QualityConfig {
  return {
    basic: true,
    rounds: 3,
    concurrency: 6,
    bandwidth: false,
    speedConcurrency: 1,
    seconds: 5,
    mebibytes: 4,
    ai: true,
    ...overrides,
  }
}

export function basicOnlyConfig(overrides: Partial<QualityConfig> = {}): QualityConfig {
  return buildQualityConfig({ basic: true, bandwidth: false, ai: false, ...overrides })
}

export function aiOnlyConfig(overrides: Partial<QualityConfig> = {}): QualityConfig {
  return buildQualityConfig({ basic: false, bandwidth: false, ai: true, ...overrides })
}

export function basicAndAiConfig(overrides: Partial<QualityConfig> = {}): QualityConfig {
  return buildQualityConfig({ basic: true, bandwidth: false, ai: true, ...overrides })
}

export function basicAndBandwidthConfig(overrides: Partial<QualityConfig> = {}): QualityConfig {
  return buildQualityConfig({ basic: true, bandwidth: true, ai: false, ...overrides })
}

export interface QualityScheduleConfig {
  targetDeviceId: string | null
  scope: 'kept' | 'all'
  autoRefreshGroups: boolean
  basic: {
    enabled: boolean
    intervalMinutes: number
    rounds: number
    concurrency: number
    bandwidth: boolean
    lastRunAt: string | null
    lastJobId: string | null
  }
  ai: {
    enabled: boolean
    intervalMinutes: number
    concurrency: number
    lastRunAt: string | null
    lastJobId: string | null
  }
}

export function buildQualitySchedule(overrides: Partial<QualityScheduleConfig> = {}): QualityScheduleConfig {
  return {
    targetDeviceId: overrides.targetDeviceId ?? null,
    scope: overrides.scope ?? 'kept',
    autoRefreshGroups: overrides.autoRefreshGroups ?? true,
    basic: {
      enabled: false,
      intervalMinutes: 1440,
      rounds: 3,
      concurrency: 6,
      bandwidth: false,
      lastRunAt: null,
      lastJobId: null,
      ...(overrides.basic ?? {}),
    },
    ai: {
      enabled: false,
      intervalMinutes: 4320,
      concurrency: 6,
      lastRunAt: null,
      lastJobId: null,
      ...(overrides.ai ?? {}),
    },
  }
}

export interface LegacyPreR1Options {
  sourceId?: string
  nodeId?: string
  nodeKey?: string
  groupId?: string
  reportId?: string
  deviceId?: string
}

export type SqliteSeedTuple = readonly [space: string, key: string, value: unknown]

export function buildLegacyPreR1Documents(
  profileId: string,
  opts: LegacyPreR1Options = {},
): SqliteSeedTuple[] {
  const sourceId = opts.sourceId ?? uniqueId('src_')
  const nodeId = opts.nodeId ?? uniqueId('nod_')
  const nodeKey = opts.nodeKey ?? `${sourceId}/${nodeId}`
  const groupId = opts.groupId ?? uniqueId('grp_')
  const reportId = opts.reportId ?? randomUUID()
  const deviceId = opts.deviceId ?? randomUUID()
  const createdAt = '2026-01-01T00:00:00.000Z'

  const legacySnapshot = {
    reportId,
    createdAt,
    rows: {
      [nodeKey]: {
        key: nodeKey,
        available: true,
        httpsMs: 90,
        tlsMs: 30,
        jitterMs: 5,
        lossRate: 0,
        speedMbps: 100,
        exitRegion: 'US',
        reachable: ['chatgptWeb', 'chatgptApp', 'gemini', 'claudeWeb', 'claudeApi', 'grok'],
        platforms: {
          ChatGPT: 'unlocked',
          Gemini: 'unlocked',
          Claude: 'unlocked',
          Grok: 'region_restricted',
        },
        surfaceIssues: {
          grok: 'region_restricted',
          claudeWeb: 'challenge',
        },
      },
    },
  }

  const legacyDraft = {
    qualityBaselinePolicy: { mode: 'fixed', reportId },
    sources: [
      buildSource({ id: sourceId, name: 'Legacy Source', url: 'https://example.invalid/sub' }),
    ],
    groups: [
      {
        id: groupId,
        name: 'Legacy AI Group',
        type: 'select',
        enabled: true,
        members: [
          {
            kind: 'pool',
            sourceIds: [sourceId],
            regions: [],
            quality: {
              aiPlatforms: ['ChatGPT', 'Claude', 'Grok'],
              platforms: ['chatgptWeb', 'claudeWeb', 'claudeApi', 'grok'],
              sortBy: 'Grok',
            },
          },
        ],
        testUrl: '',
        seconds: 300,
        tolerance: 50,
        strategy: 'consistent-hashing',
        lazy: true,
        disableUdp: false,
      },
    ],
    services: [],
    rules: [],
    base: buildBaseConfig(),
  }

  const legacyProfile = {
    id: profileId,
    title: 'Legacy Profile',
    draft: legacyDraft,
    revision: 1,
    publishedRevision: 1,
    active: 1,
    token: null,
    revoked: false,
    readThrough: null,
    fixedQualitySnapshot: legacySnapshot,
  }

  const counts = { sources: 1, nodes: 0, groups: 1, rules: 0 }
  const legacyVersion = {
    seq: 1,
    at: createdAt,
    kind: 'publish' as const,
    parent: null,
    counts,
    yaml: 'proxies: []\nproxy-groups: []\nrules: []\n',
    qualityReportId: reportId,
    qualitySnapshot: legacySnapshot,
    recipe: legacyDraft,
    view: {
      counts,
      sources: [],
      groups: [],
      rules: [],
      issues: [],
      nodes: [],
    },
  }

  const legacyReport = {
    schemaVersion: 1,
    jobId: reportId,
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    targetDeviceId: deviceId,
    targetDeviceName: 'Legacy Probe v3',
    config: {
      rounds: 3,
      concurrency: 6,
      bandwidth: false,
      speedConcurrency: 1,
      seconds: 5,
      mebibytes: 4,
      ai: true,
    },
    results: [
      {
        key: nodeKey,
        name: '🇺🇸 Legacy Node',
        sourceName: 'Legacy Source',
        available: true,
        error: null,
        samples: [
          { tlsMs: 30, httpsMs: 90, httpStatus: 204 },
          { tlsMs: 31, httpsMs: 92, httpStatus: 204 },
        ],
        tlsMedianMs: 30.5,
        httpsMedianMs: 91,
        jitterMs: 2,
        lossRate: 0,
        exit: { ip: '198.51.100.1', region: 'US' },
        speed: null,
        ai: {
          chatgptWeb: { state: 'reachable', evidence: 'compliance_json', httpStatus: 200, needsReview: false, providerRegion: 'US' },
          chatgptApp: { state: 'reachable', evidence: 'app_gateway', httpStatus: 200, needsReview: false, providerRegion: 'US' },
          gemini: { state: 'reachable', evidence: 'web_entry', httpStatus: 200, needsReview: false, providerRegion: 'US' },
          claudeWeb: { state: 'challenge', evidence: 'cf_challenge', httpStatus: 403, needsReview: true, providerRegion: null },
          claudeApi: { state: 'reachable', evidence: 'web_entry', httpStatus: 200, needsReview: false, providerRegion: 'US' },
          grok: { state: 'region_restricted', evidence: 'region_denied', httpStatus: 403, needsReview: false, providerRegion: 'HK' },
        },
      },
    ],
  }

  const legacyJob = {
    id: reportId,
    createdAt,
    finishedAt: createdAt,
    expiresAt: createdAt,
    status: 'completed',
    config: legacyReport.config,
    total: 1,
    progress: { stage: 'uploading', done: 1, total: 1 },
    available: 1,
    targetDeviceId: deviceId,
    targetDeviceName: 'Legacy Probe v3',
    failure: null,
  }

  const legacyDevice = {
    id: deviceId,
    name: 'Legacy Probe v3',
    remark: '',
    platform: 'linux',
    lastSeenAt: createdAt,
    secretHash: randomBytes(32).toString('hex'),
    protocolVersion: 3,
    agentVersion: '1.3.1',
  }

  const legacyRegistration = {
    name: 'Legacy Registration Probe',
    platform: 'linux',
    lastSeen: createdAt,
    secretHash: randomBytes(32).toString('hex'),
  }

  const legacyLibrary = {
    filters: [],
    providers: [],
    groups: [
      {
        id: uniqueId('tpl_'),
        name: 'Legacy Template',
        groups: [
          {
            id: uniqueId('grp_'),
            name: 'Legacy Template Group',
            type: 'select',
            enabled: true,
            members: [
              {
                kind: 'pool',
                sourceIds: [],
                regions: [],
                quality: {
                  aiPlatforms: ['Claude', 'Grok'],
                  platforms: ['claudeWeb', 'grok'],
                  sortBy: 'Claude',
                },
              },
            ],
            testUrl: '',
            seconds: 300,
            tolerance: 50,
            strategy: 'consistent-hashing',
            lazy: true,
            disableUdp: false,
          },
        ],
      },
    ],
  }

  return [
    ['profiles', profileId, legacyProfile],
    [`versions/${profileId}`, '000000000001', legacyVersion],
    [`quality-reports/${profileId}`, reportId, legacyReport],
    [`quality-jobs/${profileId}`, reportId, legacyJob],
    [`quality-device/${profileId}`, 'registration', legacyRegistration],
    [`quality-device/${profileId}`, 'next', reportId],
    [`quality-devices/${profileId}`, deviceId, legacyDevice],
    ['system', 'library', legacyLibrary],
  ]
}

export interface ParsedMihomoConfig {
  proxies: Array<Record<string, unknown>>
  'proxy-groups': Array<{ name: string; type: string; proxies?: string[]; [key: string]: unknown }>
  rules: string[]
  [key: string]: unknown
}

export function parseMihomoYaml(yamlText: string): ParsedMihomoConfig {
  const parsed = parseYaml(yamlText) as Partial<ParsedMihomoConfig> | null
  assert.ok(parsed && typeof parsed === 'object', 'Expected Mihomo YAML to parse as object')
  assert.ok(Array.isArray(parsed.proxies), 'Expected Mihomo YAML to contain proxies array')
  assert.ok(Array.isArray(parsed['proxy-groups']), 'Expected Mihomo YAML to contain proxy-groups array')
  assert.ok(Array.isArray(parsed.rules), 'Expected Mihomo YAML to contain rules array')
  return parsed as ParsedMihomoConfig
}

export function getYamlGroupProxies(yamlObj: ParsedMihomoConfig, groupName: string): string[] {
  const grp = yamlObj['proxy-groups'].find(g => g.name === groupName)
  assert.ok(grp, `Expected proxy group "${groupName}" in Mihomo YAML`)
  return Array.isArray(grp.proxies) ? grp.proxies : []
}

export function assertYamlGroupContains(
  yamlObj: ParsedMihomoConfig,
  groupName: string,
  expectedNames: readonly string[],
): void {
  const actual = getYamlGroupProxies(yamlObj, groupName)
  for (const expected of expectedNames) {
    assert.ok(
      actual.includes(expected),
      `Expected group "${groupName}" to contain "${expected}", actual: ${JSON.stringify(actual)}`,
    )
  }
}

export function assertYamlGroupExactOrder(
  yamlObj: ParsedMihomoConfig,
  groupName: string,
  expectedNames: readonly string[],
): void {
  const actual = getYamlGroupProxies(yamlObj, groupName)
  assert.deepEqual(actual, [...expectedNames])
}

export interface AvailabilityStats {
  window: boolean[]
  total: number
  success: number
  rate: number
  updatedAt: string
}

export interface LatestNodeQuality {
  nodeKey: string
  deviceId: string
  basic: {
    available: boolean
    httpsMs: number | null
    tlsMs: number | null
    jitterMs: number | null
    lossRate: number | null
    exit: { ip: string | null; region: string | null } | null
    infoNode: boolean
    error: QualityError | null
    updatedAt: string
  } | null
  speed: {
    speedMbps: number | null
    speedFailed: boolean
    updatedAt: string
  } | null
  ai: {
    results: AiResults | null
    aiSkipped?: 'missing_exit' | 'weak_connection'
    updatedAt: string
  } | null
  availability: AvailabilityStats | null
}

export function unwrapLatestForDevice(
  payload: unknown,
  deviceId: string,
): Record<string, LatestNodeQuality> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {}
  }
  const obj = payload as Record<string, unknown>
  if (deviceId in obj && obj[deviceId] && typeof obj[deviceId] === 'object' && !('nodeKey' in (obj[deviceId] as object))) {
    return obj[deviceId] as Record<string, LatestNodeQuality>
  }
  const firstValue = Object.values(obj)[0]
  if (firstValue && typeof firstValue === 'object' && 'nodeKey' in firstValue) {
    const candidate = firstValue as { deviceId?: unknown }
    if ('deviceId' in candidate && candidate.deviceId !== deviceId) {
      return {}
    }
    return obj as Record<string, LatestNodeQuality>
  }
  return {}
}

export function assertAvailabilityStats(
  stats: AvailabilityStats | null | undefined,
  expectedSuccess: number,
  expectedTotal: number,
): void {
  assert.ok(stats, 'Expected AvailabilityStats object to be present')
  assert.ok(Array.isArray(stats.window), 'Expected availability.window array')
  assert.ok(stats.window.length <= 20, `Expected rolling window <= 20, got ${stats.window.length}`)
  assert.equal(stats.total, expectedTotal)
  assert.equal(stats.success, expectedSuccess)
  const expectedRate = expectedTotal > 0 ? expectedSuccess / expectedTotal : 0
  assert.ok(
    Math.abs(stats.rate - expectedRate) < 1e-6,
    `Expected rate ${expectedRate}, got ${stats.rate}`,
  )
}

const LEGACY_AI_STRING_REGEX = /(?:grok|claude)/i

export function assertNoLegacyAiStrings(input: unknown, path = '$'): void {
  if (typeof input === 'string') {
    const match = LEGACY_AI_STRING_REGEX.exec(input)
    assert.ok(
      !match,
      `Legacy AI string "${match?.[0]}" found at ${path}: ${input.slice(0, 200)}`,
    )
    return
  }
  if (Array.isArray(input)) {
    input.forEach((item, idx) => assertNoLegacyAiStrings(item, `${path}[${idx}]`))
    return
  }
  if (input && typeof input === 'object') {
    for (const [key, val] of Object.entries(input)) {
      const match = LEGACY_AI_STRING_REGEX.exec(key)
      assert.ok(
        !match,
        `Legacy AI key "${match?.[0]}" found at ${path}.${key}`,
      )
      assertNoLegacyAiStrings(val, `${path}.${key}`)
    }
  }
}

export function assertThreeSurfaceAi(ai: unknown): asserts ai is AiResults {
  assert.ok(ai && typeof ai === 'object' && !Array.isArray(ai), 'Expected AI results object')
  const keys = Object.keys(ai).sort()
  assert.deepEqual(keys, ['antigravity', 'chatgptApp', 'chatgptWeb', 'gemini'])
}
