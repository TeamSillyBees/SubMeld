import { randomBytes, randomUUID } from 'node:crypto'

export const E2E_SURFACES = ['chatgptWeb', 'chatgptApp', 'gemini'] as const
export type Surface = typeof E2E_SURFACES[number]

export const E2E_PROBE_PROTOCOL = 4
export const E2E_PROBE_VERSION = '2.0.0'

export interface ProbeCapabilities {
  protocolVersion: number
  agentVersion: string
  mihomoVersion: string | null
  localRegion: string | null
  localIsp: string | null
  ipStack: 'ipv4' | 'ipv6' | 'dual' | null
}

export function defaultV4Capabilities(overrides: Partial<ProbeCapabilities> = {}): ProbeCapabilities {
  return {
    protocolVersion: E2E_PROBE_PROTOCOL,
    agentVersion: E2E_PROBE_VERSION,
    mihomoVersion: 'v1.19.0',
    localRegion: 'JP',
    localIsp: 'E2E Test ISP',
    ipStack: 'dual',
    ...overrides,
  }
}

export function legacyV3Capabilities(overrides: Partial<ProbeCapabilities> = {}): ProbeCapabilities {
  return {
    protocolVersion: 3,
    agentVersion: '1.3.1',
    mihomoVersion: 'v1.19.0',
    localRegion: 'JP',
    localIsp: 'Legacy ISP',
    ipStack: 'dual',
    ...overrides,
  }
}

export function legacyV2Capabilities(overrides: Partial<ProbeCapabilities> = {}): ProbeCapabilities {
  return {
    protocolVersion: 2,
    agentVersion: '1.3.0',
    mihomoVersion: 'v1.18.0',
    localRegion: 'JP',
    localIsp: 'Legacy ISP',
    ipStack: 'ipv4',
    ...overrides,
  }
}

export function credential(): string {
  return randomBytes(32).toString('base64url')
}

export interface ParsedInviteLink {
  origin: string
  profileId: string
  ticket: string
}

export function parseInviteLink(pairing: string): ParsedInviteLink {
  let url: URL
  try {
    url = new URL(pairing)
  } catch {
    throw new Error(`Invalid probe invite link: ${pairing}`)
  }
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  const parts = hash.split('.')
  if (parts.length !== 3 || parts[0] !== 'device' || !parts[1] || !parts[2]) {
    throw new Error(`Unexpected invite hash format in "${pairing}"`)
  }
  return {
    origin: url.origin,
    profileId: parts[1],
    ticket: parts[2],
  }
}

export type AiState =
  | 'reachable'
  | 'unavailable'
  | 'authentication'
  | 'region_restricted'
  | 'region_mismatch'
  | 'challenge'
  | 'degraded_challenge'
  | 'ip_blocked'
  | 'rate_limited'
  | 'unknown'
  | 'network_error'

export type EvidenceType =
  | 'web_entry'
  | 'compliance_json'
  | 'app_gateway'
  | 'http_denied'
  | 'disallowed_isp'
  | 'login_redirect'
  | 'consent_redirect'
  | 'credentials_required'
  | 'region_denied'
  | 'region_policy'
  | 'region_disagrees'
  | 'region_unconfirmed'
  | 'exit_region_fallback'
  | 'cf_challenge'
  | 'bot_challenge'
  | 'ip_denied'
  | 'rate_limit'
  | 'unrecognized'
  | 'network'

export interface AiReading {
  state: AiState
  evidence: EvidenceType
  httpStatus: number | null
  needsReview: boolean
  providerRegion: string | null
}

export type AiResults = Record<Surface, AiReading>

export type RestrictedAiKind = 'region_restricted' | 'ip_blocked' | 'unavailable'
export type UncertainAiKind =
  | 'challenge'
  | 'degraded_challenge'
  | 'unknown'
  | 'network_error'
  | 'authentication'
  | 'rate_limited'
  | 'region_mismatch'

export const aiReading = {
  green(region: string | null = 'US', surface: Surface = 'chatgptWeb'): AiReading {
    const evidence: EvidenceType = surface === 'chatgptWeb'
      ? 'compliance_json'
      : surface === 'chatgptApp'
        ? 'app_gateway'
        : 'web_entry'
    return {
      state: 'reachable',
      evidence,
      httpStatus: 200,
      needsReview: false,
      providerRegion: region,
    }
  },
  restricted(kind: RestrictedAiKind = 'region_restricted', providerRegion: string | null = null): AiReading {
    if (kind === 'ip_blocked') {
      return {
        state: 'ip_blocked',
        evidence: 'ip_denied',
        httpStatus: 403,
        needsReview: false,
        providerRegion: null,
      }
    }
    if (kind === 'unavailable') {
      return {
        state: 'unavailable',
        evidence: 'http_denied',
        httpStatus: 403,
        needsReview: false,
        providerRegion: null,
      }
    }
    return {
      state: 'region_restricted',
      evidence: 'region_denied',
      httpStatus: 403,
      needsReview: false,
      providerRegion,
    }
  },
  uncertain(kind: UncertainAiKind = 'unknown', providerRegion: string | null = null): AiReading {
    switch (kind) {
      case 'challenge':
        return { state: 'challenge', evidence: 'cf_challenge', httpStatus: 403, needsReview: true, providerRegion: null }
      case 'degraded_challenge':
        return { state: 'degraded_challenge', evidence: 'cf_challenge', httpStatus: 403, needsReview: false, providerRegion }
      case 'network_error':
        return { state: 'network_error', evidence: 'network', httpStatus: null, needsReview: false, providerRegion: null }
      case 'authentication':
        return { state: 'authentication', evidence: 'login_redirect', httpStatus: 302, needsReview: true, providerRegion: null }
      case 'rate_limited':
        return { state: 'rate_limited', evidence: 'rate_limit', httpStatus: 429, needsReview: false, providerRegion: null }
      case 'region_mismatch':
        return { state: 'region_mismatch', evidence: 'region_disagrees', httpStatus: 200, needsReview: true, providerRegion }
      case 'unknown':
      default:
        return { state: 'unknown', evidence: 'unrecognized', httpStatus: 403, needsReview: true, providerRegion: null }
    }
  },
}

export function buildAiResults(partial: Partial<AiResults> = {}, defaultRegion: string | null = 'US'): AiResults {
  return {
    chatgptWeb: partial.chatgptWeb ?? aiReading.green(defaultRegion, 'chatgptWeb'),
    chatgptApp: partial.chatgptApp ?? aiReading.green(defaultRegion, 'chatgptApp'),
    gemini: partial.gemini ?? aiReading.green(defaultRegion, 'gemini'),
  }
}

export const aiPresets = {
  allGreen(region: string | null = 'US'): AiResults {
    return buildAiResults({}, region)
  },
  allRestricted(providerRegion: string | null = 'HK'): AiResults {
    return {
      chatgptWeb: aiReading.restricted('region_restricted', providerRegion),
      chatgptApp: aiReading.restricted('ip_blocked', null),
      gemini: aiReading.restricted('unavailable', null),
    }
  },
  mixed(region: string | null = 'US'): AiResults {
    return {
      chatgptWeb: aiReading.green(region, 'chatgptWeb'),
      chatgptApp: aiReading.restricted('region_restricted', 'HK'),
      gemini: aiReading.uncertain('challenge', null),
    }
  },
}

export interface LatencySample {
  tlsMs: number | null
  httpsMs: number | null
  httpStatus?: number
}

export interface SpeedReading {
  bytes: number
  elapsedMs: number
  averageBps: number
  peakBps: number
  perSecondBps: number[]
  stop: 'bytes' | 'duration' | 'end' | 'error'
}

export type QualityError = 'invalid_node' | 'no_response' | 'https_no_response' | 'unexpected_status' | 'info_node'

export interface QualityExit {
  ip: string
  region: string | null
}

export interface QualityRow {
  key: string
  available: boolean
  error: QualityError | null
  samples: LatencySample[]
  tlsMedianMs: number | null
  httpsMedianMs: number | null
  jitterMs: number | null
  lossRate: number | null
  exit: QualityExit | null
  aiSkipped?: 'missing_exit' | 'weak_connection'
  speed: SpeedReading | null
  ai: AiResults | null
}

export interface QualityConfig {
  basic?: boolean
  rounds: number
  concurrency: number
  bandwidth: boolean
  speedConcurrency: number
  seconds: number
  mebibytes: number
  ai: boolean
}

export interface QualityNode {
  key: string
  name: string
  sourceName: string
  connection: Record<string, unknown>
}

export interface Assignment {
  schemaVersion: 1
  jobId: string
  createdAt: string
  config: QualityConfig
  nodes: QualityNode[]
}

export type ProgressStage = 'starting' | 'latency' | 'bandwidth' | 'ai' | 'uploading'

export interface ProgressPayload {
  stage: ProgressStage
  done: number
  total: number
}

export interface AgentReport {
  schemaVersion: 1
  jobId: string
  startedAt: string
  finishedAt: string
  results: QualityRow[]
}

export interface AgentHttpResponse<T = unknown> {
  status: number
  ok: boolean
  body: T
}

const SUBSCRIPTION_NOTICE_RE =
  /(?:^|[\s\]|｜:：】])(?:剩余流量|套餐流量|流量重置|距离下次重置|到期时间|套餐到期|订阅到期|下次重置|traffic remaining|expire(?:s| time)?)(?=$|[\s:：|｜\d])/iu

export function isNoticeNodeName(name: string): boolean {
  return SUBSCRIPTION_NOTICE_RE.test(name)
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100
}

export function summarizeSamples(samples: readonly LatencySample[]): {
  available: boolean
  tlsMedianMs: number | null
  httpsMedianMs: number | null
  jitterMs: number | null
  lossRate: number | null
} {
  if (!samples.length) {
    return {
      available: false,
      tlsMedianMs: null,
      httpsMedianMs: null,
      jitterMs: null,
      lossRate: null,
    }
  }
  const httpsValues = samples.flatMap(s => (typeof s.httpsMs === 'number' ? [s.httpsMs] : []))
  const tlsValues = samples.flatMap(s => (typeof s.tlsMs === 'number' ? [s.tlsMs] : []))
  const httpsMedianMs = median(httpsValues)
  const tlsMedianMs = median(tlsValues)
  let jitterMs: number | null = null
  if (httpsValues.length >= 2) {
    let totalDiff = 0
    for (let i = 1; i < httpsValues.length; i++) {
      totalDiff += Math.abs(httpsValues[i] - httpsValues[i - 1])
    }
    jitterMs = roundMetric(totalDiff / (httpsValues.length - 1))
  } else if (httpsValues.length === 1) {
    jitterMs = 0
  }
  const lossRate = roundMetric((samples.length - httpsValues.length) / samples.length)
  return {
    available: httpsValues.length > 0,
    tlsMedianMs,
    httpsMedianMs,
    jitterMs,
    lossRate,
  }
}

export interface RowSpecOverride {
  available?: boolean
  error?: QualityError | null
  samples?: LatencySample[]
  latencyMs?: number
  tlsMs?: number
  jitterMs?: number | null
  lossRate?: number | null
  exit?: QualityExit | null
  speed?: SpeedReading | null
  speedMbps?: number | null
  ai?: AiResults | null
  aiSkipped?: 'missing_exit' | 'weak_connection'
}

function inferDefaultRegion(nodeName: string): string {
  if (/US|美国|🇺🇸/i.test(nodeName)) return 'US'
  if (/JP|日本|🇯🇵/i.test(nodeName)) return 'JP'
  if (/SG|新加坡|🇸🇬/i.test(nodeName)) return 'SG'
  if (/HK|香港|🇭🇰/i.test(nodeName)) return 'HK'
  if (/DE|德国|🇩🇪/i.test(nodeName)) return 'DE'
  return 'JP'
}

function buildClampedSpeedReading(config: QualityConfig, speedMbps: number): SpeedReading {
  const maxBytes = Math.max(1, config.mebibytes) * 1024 * 1024
  const maxSeconds = Math.max(1, config.seconds)
  const targetBps = Math.max(1000, Math.round((speedMbps * 1_000_000) / 8))
  const elapsedMs = Math.min(maxSeconds * 1000, Math.max(1000, Math.round((maxBytes / targetBps) * 1000)))
  const bytes = Math.min(maxBytes, Math.round((targetBps * elapsedMs) / 1000))
  const secondsCount = Math.max(1, Math.min(maxSeconds, Math.ceil(elapsedMs / 1000)))
  const perSecondBps = Array.from({ length: secondsCount }, () => targetBps)
  return {
    bytes,
    elapsedMs,
    averageBps: targetBps,
    peakBps: Math.round(targetBps * 1.15),
    perSecondBps,
    stop: bytes >= maxBytes ? 'bytes' : 'duration',
  }
}

function allNetworkErrorAi(): AiResults {
  return {
    chatgptWeb: aiReading.uncertain('network_error'),
    chatgptApp: aiReading.uncertain('network_error'),
    gemini: aiReading.uncertain('network_error'),
  }
}

/**
 * Build a `QualityRow` matching SubMeld's `POST /api/quality/agent/complete` contract (`server/quality.ts`).
 *
 * When `config.basic === false` (e.g., `aiOnlyConfig()`), `server/quality.ts` requires
 * `row.available === (row.exit !== null || Object.values(row.ai ?? {}).some(r => r.state !== 'network_error'))`:
 * - Valid restricted/mixed AI-only rows with no exit node should pass `{ exit: null, ai: aiPresets.allRestricted(...) }`
 *   (omitting `available: false` so `available` derives as `true` -> HTTP `200`).
 * - Passing `{ available: false }` without `spec.ai` emits `allNetworkErrorAi()` (`available: false`, `exit: null` -> HTTP `200`).
 * - Explicitly passing `{ available: false, ai: aiPresets.allRestricted(...) }` or `{ available: true, exit: null, ai: allNetworkError }`
 *   preserves `spec.available` to intentionally test HTTP `422` invariant rejection.
 */
export function buildQualityRow(
  node: QualityNode,
  config: QualityConfig,
  spec: RowSpecOverride = {},
): QualityRow {
  const isBasic = config.basic !== false
  const isNotice = spec.error === 'info_node' || (
    spec.error === undefined &&
    (isNoticeNodeName(node.name) || (typeof node.connection?.name === 'string' && isNoticeNodeName(node.connection.name)))
  )
  if (isNotice || spec.error === 'invalid_node') {
    return {
      key: node.key,
      available: false,
      error: isNotice ? 'info_node' : 'invalid_node',
      samples: [],
      tlsMedianMs: null,
      httpsMedianMs: null,
      jitterMs: null,
      lossRate: null,
      exit: null,
      speed: null,
      ai: null,
    }
  }

  const defaultRegion = inferDefaultRegion(node.name)
  const defaultExit: QualityExit = { ip: '198.51.100.10', region: defaultRegion }

  if (!isBasic) {
    const aiSkipped = spec.aiSkipped
    if (aiSkipped === 'missing_exit') {
      return {
        key: node.key,
        available: spec.available ?? false,
        error: spec.error ?? null,
        samples: [],
        tlsMedianMs: null,
        httpsMedianMs: null,
        jitterMs: null,
        lossRate: null,
        exit: spec.exit === undefined ? null : spec.exit,
        aiSkipped,
        speed: null,
        ai: spec.ai === undefined ? null : spec.ai,
      }
    }

    const exit = spec.exit === undefined
      ? (spec.available === false ? null : defaultExit)
      : spec.exit

    let ai: AiResults | null = null
    if (config.ai) {
      if (spec.ai !== undefined) {
        ai = spec.ai
      } else if (aiSkipped) {
        ai = null
      } else if (spec.available === false) {
        ai = allNetworkErrorAi()
      } else {
        ai = aiPresets.allGreen(exit?.region ?? defaultRegion)
      }
    }

    const hasReachableAi = ai !== null && Object.values(ai).some(r => r.state !== 'network_error')
    const available = spec.available ?? (Boolean(exit) || hasReachableAi)

    return {
      key: node.key,
      available,
      error: spec.error ?? null,
      samples: [],
      tlsMedianMs: null,
      httpsMedianMs: null,
      jitterMs: null,
      lossRate: null,
      exit,
      ...(aiSkipped ? { aiSkipped } : {}),
      speed: null,
      ai,
    }
  }

  const rounds = Math.max(2, Math.min(8, config.rounds || 3))
  let samples: LatencySample[]
  if (spec.samples !== undefined) {
    samples = spec.samples.slice(0, rounds)
  } else if (spec.available === false || (spec.error !== undefined && spec.error !== null)) {
    samples = Array.from({ length: rounds }, () => ({ tlsMs: null, httpsMs: null }))
  } else {
    const baseHttps = spec.latencyMs ?? 85
    const baseTls = spec.tlsMs ?? Math.max(5, Math.round(baseHttps * 0.35))
    samples = Array.from({ length: rounds }, (_, idx) => ({
      tlsMs: baseTls + idx,
      httpsMs: baseHttps + idx * 2,
      httpStatus: 204,
    }))
  }

  const summary = summarizeSamples(samples)
  const available = spec.available ?? summary.available
  const error: QualityError | null = spec.error !== undefined
    ? spec.error
    : available
      ? null
      : 'no_response'
  const exit = spec.exit !== undefined ? spec.exit : (available ? defaultExit : null)
  const lossRate = spec.lossRate !== undefined ? spec.lossRate : summary.lossRate
  const httpsMedianMs = summary.httpsMedianMs
  const jitterMs = spec.jitterMs !== undefined ? spec.jitterMs : summary.jitterMs

  let speed: SpeedReading | null = null
  if (config.bandwidth && available) {
    if (spec.speed !== undefined) {
      speed = spec.speed
    } else {
      speed = buildClampedSpeedReading(config, spec.speedMbps ?? 120)
    }
  }

  let ai: AiResults | null = null
  let aiSkipped = spec.aiSkipped
  if (config.ai && available) {
    if (spec.ai !== undefined) {
      ai = spec.ai
    } else if (aiSkipped) {
      ai = null
    } else if ((lossRate ?? 0) >= 0.5 || (httpsMedianMs ?? 0) >= 4000) {
      aiSkipped = 'weak_connection'
    } else {
      ai = aiPresets.allGreen(exit?.region ?? defaultRegion)
    }
  }

  return {
    key: node.key,
    available,
    error,
    samples,
    tlsMedianMs: summary.tlsMedianMs,
    httpsMedianMs,
    jitterMs,
    lossRate,
    exit,
    ...(aiSkipped ? { aiSkipped } : {}),
    speed,
    ai,
  }
}

export function buildAgentReport(
  assignment: Assignment,
  perNode?: (node: QualityNode, index: number) => RowSpecOverride,
  options: { startedAt?: string; finishedAt?: string } = {},
): AgentReport {
  const startedAt = options.startedAt ?? new Date(Date.now() - 500).toISOString()
  const finishedAt = options.finishedAt ?? new Date().toISOString()
  const results = assignment.nodes.map((node, idx) =>
    buildQualityRow(node, assignment.config, perNode ? perNode(node, idx) : {}),
  )
  return {
    schemaVersion: 1,
    jobId: assignment.jobId,
    startedAt,
    finishedAt,
    results,
  }
}

export interface MockProbeOptions {
  origin: string
  profileId: string
  name?: string
  platform?: 'windows' | 'linux'
  secret?: string
  capabilities?: ProbeCapabilities
}

export interface AutoResponderHandle {
  stop(): Promise<void>
}

export interface MockProbeAgent {
  readonly origin: string
  readonly profileId: string
  readonly name: string
  readonly platform: 'windows' | 'linux'
  secret: string
  capabilities: ProbeCapabilities
  getWorkerForJob(jobId: string): string | undefined
  enroll(
    ticket: string,
    overrides?: {
      name?: string
      platform?: 'windows' | 'linux'
      secret?: string
      capabilities?: ProbeCapabilities
    },
  ): Promise<AgentHttpResponse<{ ok: true } | { message: string }>>
  poll(options?: {
    wait?: boolean
    worker?: string
    capabilities?: ProbeCapabilities
    signal?: AbortSignal
  }): Promise<AgentHttpResponse<Assignment | null | { message: string }>>
  progress(
    jobId: string,
    progress: ProgressPayload,
    worker?: string,
  ): Promise<AgentHttpResponse<{ ok: true } | { message: string }>>
  complete(
    jobId: string,
    report: AgentReport,
    worker?: string,
  ): Promise<AgentHttpResponse<{ ok: true } | { message: string }>>
  fail(jobId: string, worker?: string): Promise<AgentHttpResponse<{ ok: true } | { message: string }>>
  cancel(jobId: string, worker?: string): Promise<AgentHttpResponse<{ ok: true } | { message: string }>>
  leave(): Promise<AgentHttpResponse<{ ok: true } | { message: string }>>
  offline(): Promise<AgentHttpResponse<{ ok: true } | { message: string }>>
  pollAndComplete(
    perNode?: (node: QualityNode, index: number) => RowSpecOverride,
    options?: { wait?: boolean; emitProgress?: boolean },
  ): Promise<{
    pollResponse: AgentHttpResponse<Assignment | null | { message: string }>
    assignment: Assignment | null
    report: AgentReport | null
    completeResponse: AgentHttpResponse<{ ok: true } | { message: string }> | null
  }>
  startAutoResponder(
    perNode?: (node: QualityNode, index: number, assignment: Assignment) => RowSpecOverride,
    options?: {
      pollIntervalMs?: number
      wait?: boolean
      emitProgress?: boolean
      onError?: (err: unknown) => void
      onCompleted?: (assignment: Assignment, report: AgentReport) => void
    },
  ): AutoResponderHandle
}

export function createMockProbe(options: MockProbeOptions): MockProbeAgent {
  const origin = options.origin.replace(/\/+$/, '')
  const profileId = options.profileId
  const name = options.name ?? `e2e-probe-${randomUUID().slice(0, 8)}`
  const platform = options.platform ?? (process.platform === 'win32' ? 'windows' : 'linux')
  let secret = options.secret ?? credential()
  let capabilities = options.capabilities ? { ...options.capabilities } : defaultV4Capabilities()
  const activeWorkers = new Map<string, string>()

  async function postAction<T>(
    action: string,
    bearer: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<AgentHttpResponse<T>> {
    const res = await fetch(`${origin}/api/quality/agent/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text }
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      body: parsed as T,
    }
  }

  function resolveWorker(jobId: string, explicitWorker?: string): string {
    return explicitWorker ?? activeWorkers.get(jobId) ?? credential()
  }

  const agent: MockProbeAgent = {
    origin,
    profileId,
    name,
    platform,
    get secret() {
      return secret
    },
    set secret(next: string) {
      secret = next
    },
    get capabilities() {
      return capabilities
    },
    set capabilities(next: ProbeCapabilities) {
      capabilities = next
    },
    getWorkerForJob(jobId: string) {
      return activeWorkers.get(jobId)
    },
    async enroll(ticket, overrides = {}) {
      const nextSecret = overrides.secret ?? secret
      if (overrides.secret) secret = overrides.secret
      if (overrides.capabilities) capabilities = { ...overrides.capabilities }
      return postAction('enroll', ticket, {
        profileId,
        secret: nextSecret,
        name: overrides.name ?? name,
        platform: overrides.platform ?? platform,
        capabilities: overrides.capabilities ?? capabilities,
      })
    },
    async poll(pollOpts = {}) {
      const worker = pollOpts.worker ?? credential()
      const res = await postAction<Assignment | null | { message: string }>(
        'poll',
        secret,
        {
          profileId,
          worker,
          capabilities: pollOpts.capabilities ?? capabilities,
          ...(pollOpts.wait !== undefined ? { wait: pollOpts.wait } : {}),
        },
        pollOpts.signal,
      )
      if (res.ok && res.body && typeof res.body === 'object' && 'jobId' in res.body) {
        activeWorkers.set(res.body.jobId, worker)
      }
      return res
    },
    async progress(jobId, progressPayload, worker) {
      return postAction('progress', resolveWorker(jobId, worker), {
        profileId,
        jobId,
        progress: progressPayload,
      })
    },
    async complete(jobId, report, worker) {
      return postAction('complete', resolveWorker(jobId, worker), {
        profileId,
        jobId,
        report,
      })
    },
    async fail(jobId, worker) {
      return postAction('fail', resolveWorker(jobId, worker), {
        profileId,
        jobId,
      })
    },
    async cancel(jobId, worker) {
      return postAction('cancel', resolveWorker(jobId, worker), {
        profileId,
        jobId,
      })
    },
    async leave() {
      return postAction('leave', secret, { profileId })
    },
    async offline() {
      return postAction('offline', secret, { profileId })
    },
    async pollAndComplete(perNode, opts = {}) {
      const pollResponse = await agent.poll({ wait: opts.wait ?? false })
      if (!pollResponse.ok || !pollResponse.body || !('jobId' in pollResponse.body)) {
        return {
          pollResponse,
          assignment: null,
          report: null,
          completeResponse: null,
        }
      }
      const assignment = pollResponse.body
      if (opts.emitProgress) {
        const total = assignment.nodes.length
        const stage: ProgressStage = assignment.config.basic === false ? 'ai' : 'latency'
        await agent.progress(assignment.jobId, { stage, done: total, total })
        await agent.progress(assignment.jobId, { stage: 'uploading', done: total, total })
      }
      const report = buildAgentReport(assignment, perNode)
      const completeResponse = await agent.complete(assignment.jobId, report)
      return {
        pollResponse,
        assignment,
        report,
        completeResponse,
      }
    },
    startAutoResponder(perNode, opts = {}) {
      let stopped = false
      const pollIntervalMs = opts.pollIntervalMs ?? 50
      let currentAbort: AbortController | null = null

      const loopPromise = (async () => {
        while (!stopped) {
          currentAbort = new AbortController()
          try {
            const pollRes = await agent.poll({
              wait: opts.wait ?? false,
              signal: currentAbort.signal,
            })
            if (stopped) break
            if (pollRes.ok && pollRes.body && 'jobId' in pollRes.body) {
              const assignment = pollRes.body
              if (opts.emitProgress) {
                const total = assignment.nodes.length
                await agent.progress(assignment.jobId, {
                  stage: assignment.config.basic === false ? 'ai' : 'latency',
                  done: total,
                  total,
                })
              }
              const report = buildAgentReport(
                assignment,
                perNode ? (node, idx) => perNode(node, idx, assignment) : undefined,
              )
              const completeRes = await agent.complete(assignment.jobId, report)
              if (completeRes.ok) {
                opts.onCompleted?.(assignment, report)
              } else {
                opts.onError?.(new Error(`Mock probe complete failed with HTTP ${completeRes.status}`))
              }
              continue
            }
          } catch (err) {
            if (!stopped) {
              opts.onError?.(err)
            }
          }
          if (!stopped && pollIntervalMs > 0) {
            await new Promise(resolveSleep => setTimeout(resolveSleep, pollIntervalMs))
          }
        }
      })()

      return {
        async stop() {
          stopped = true
          currentAbort?.abort()
          await loopPromise.catch(() => {})
        },
      }
    },
  }

  return agent
}
