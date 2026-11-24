import type { AiReading, AiResults, QualityJob, QualityReport, QualityRow } from './quality.ts'
import { aiSkipReason, isSubscriptionNotice, surfaces, type Surface } from './quality-options.ts'

export const platformSurfaces = {
  ChatGPT: ['chatgptWeb', 'chatgptApp'], Gemini: ['gemini'], Claude: ['claudeWeb', 'claudeApi'], Grok: ['grok'],
} as const satisfies Record<string, readonly Surface[]>
export const platforms = ['ChatGPT', 'Gemini', 'Claude', 'Grok'] as const
export type Platform = typeof platforms[number]
export const qualitySorts = ['https', 'tls', 'loss', 'jitter', 'speed', 'ai', ...platforms] as const
export type QualitySort = typeof qualitySorts[number]
export const verdictScores = { unlocked: 3, partial_unlock: 2, degraded_challenge: 1, region_restricted: 0, blocked_or_unreachable: -1 } as const
export type Verdict = keyof typeof verdictScores
export const verdictLabels: Record<Verdict, string> = {
  unlocked: '全入口可达', partial_unlock: '部分入口可达', degraded_challenge: '需浏览器验证', region_restricted: '地区受限', blocked_or_unreachable: '封禁或连接失败',
}
type PlatformResults = Record<Platform, Verdict | null>

export type BaselinePolicy = { mode: 'latest' } | { mode: 'device'; deviceId: string } | { mode: 'fixed'; reportId: string }
export function baselineId(policy: BaselinePolicy | undefined, jobs: QualityJob[], published?: { qualityReportId?: string | null; qualityDeviceId?: string | null } | null) {
  if (policy?.mode === 'fixed') return policy.reportId
  const device = policy?.mode === 'device' ? policy.deviceId : null
  const latest = jobs.filter(j => j.status === 'completed' && (!device || device === j.targetDeviceId))
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '') || b.id.localeCompare(a.id))[0]
  return latest?.id ?? ((!device || device === published?.qualityDeviceId) ? published?.qualityReportId ?? null : null)
}

export interface NodeQuality {
  available: boolean
  httpsMs: number | null
  tlsMs: number | null
  lossRate: number | null
  speedMbps: number | null
  speedFailed: boolean
  reachable: Surface[] | null
  // Published snapshots from earlier releases contain only the fields above.
  jitterMs?: number | null
  exitRegion?: string | null
  exitRegionInferred?: true
  ipStack?: 'ipv4' | 'ipv6' | null
  infoNode?: boolean
  platforms?: PlatformResults | null
  surfaceIssues?: Partial<Record<Surface, AiReading['state']>>
}
export interface QualitySnapshot {
  reportId: string; rows: Record<string, NodeQuality>
  config?: { bandwidth: boolean; ai: boolean }
  targetDeviceName?: string | null; targetDeviceId?: string | null
}

const reached = (r: AiReading) => r.state === 'reachable' && !r.needsReview
export function platformVerdict(ai: AiResults, platform: Platform): Verdict | null {
  const readings = platformSurfaces[platform].map(s => ai[s])
  if (readings.every(reached)) return 'unlocked'
  const restricted = readings.some(r => r.state === 'region_restricted' && !r.needsReview)
  if (restricted) return readings.some(reached) ? null : 'region_restricted'
  if (readings.some(reached)) return 'partial_unlock'
  if (readings.some(r => r.state === 'degraded_challenge' && !r.needsReview)) return 'degraded_challenge'
  return readings.every(r => !r.needsReview && (r.state === 'unavailable' || r.state === 'network_error' || r.state === 'ip_blocked'))
    ? 'blocked_or_unreachable' : null
}
export function inferredExitRegion(row: QualityRow): string | null {
  if (row.exit?.region || !row.available || !row.ai || row.aiSkipped || aiSkipReason(row)) return null
  const regions = Object.values(row.ai).flatMap(r => r.providerRegion && r.evidence !== 'exit_region_fallback' ? [r.providerRegion] : [])
  return regions.length >= 4 && regions.every(region => region === regions[0]) ? regions[0] : null
}
export function qualitySnapshot(report: QualityReport): QualitySnapshot {
  const rows: QualitySnapshot['rows'] = {}
  for (const r of report.results) {
    const speedFailed = r.speed?.stop === 'error' || Boolean(r.speed && !r.speed.bytes)
    // Older probes could copy another node's observations onto a weak link.
    const ai = r.aiSkipped || aiSkipReason(r) ? null : r.ai
    const failed = ai ? surfaces.filter(s => !reached(ai[s])) : []
    const inferred = inferredExitRegion(r)
    rows[r.key] = {
      available: r.available, httpsMs: r.httpsMedianMs, tlsMs: r.tlsMedianMs, lossRate: r.lossRate, jitterMs: r.jitterMs,
      exitRegion: r.exit?.region ?? inferred, ...(inferred && { exitRegionInferred: true }),
      ipStack: r.exit ? (r.exit.ip.includes(':') ? 'ipv6' : 'ipv4') : null,
      infoNode: r.error === 'info_node' || isSubscriptionNotice(r.name),
      speedMbps: r.speed && !speedFailed ? r.speed.averageBps * 8 / 1_000_000 : null, speedFailed,
      reachable: ai ? surfaces.filter(s => reached(ai[s])) : null,
      ...(ai && failed.length > 0 && { surfaceIssues: Object.fromEntries(failed.map(s => [s, ai[s].state === 'reachable' ? 'unknown' : ai[s].state])) }),
      platforms: ai ? Object.fromEntries(platforms.map(p => [p, platformVerdict(ai, p)])) as PlatformResults : null,
    }
  }
  return { reportId: report.jobId, targetDeviceId: report.targetDeviceId ?? null, targetDeviceName: report.targetDeviceName ?? null,
    config: { bandwidth: report.config.bandwidth, ai: report.config.ai }, rows }
}
export function verdictFor(row: NodeQuality, platform: Platform): Verdict | null {
  if (row.platforms !== undefined) return row.platforms?.[platform] ?? null
  const channels = platformSurfaces[platform]
  const count = channels.filter(s => row.reachable?.includes(s)).length
  return count === channels.length ? 'unlocked' : count ? 'partial_unlock' : null
}
export function qualityValue(row: NodeQuality, sort: QualitySort): number | null {
  if (sort === 'https') return row.httpsMs
  if (sort === 'tls') return row.tlsMs
  if (sort === 'loss') return row.lossRate
  if (sort === 'jitter') return row.jitterMs ?? null
  if (sort === 'speed') return row.speedMbps
  if (sort === 'ai') {
    const scores = platforms.flatMap(p => qualityValue(row, p) ?? [])
    return scores.length ? scores.reduce((sum, n) => sum + n, 0) : null
  }
  const verdict = verdictFor(row, sort)
  return verdict === null ? null : verdictScores[verdict]
}

export const higherFirst = (sort: QualitySort) => sort === 'speed' || sort === 'ai' || Object.hasOwn(platformSurfaces, sort)
function metric(a: number | null | undefined, b: number | null | undefined, descending = false) {
  if (a == null || b == null) return Number(a == null) - Number(b == null)
  return descending ? b - a : a - b
}
export const reachablePlatformCount = (r: NodeQuality) => platforms.filter(p => (qualityValue(r, p) ?? -1) >= verdictScores.partial_unlock).length
const fullCount = (r: NodeQuality) => platforms.filter(p => verdictFor(r, p) === 'unlocked').length
function compareAi(a: NodeQuality, b: NodeQuality, descending: boolean) {
  return metric(reachablePlatformCount(a), reachablePlatformCount(b), descending)
    || metric(qualityValue(a, 'ai'), qualityValue(b, 'ai'), descending)
    || metric(fullCount(a), fullCount(b), descending)
}
export function compareQuality(a: NodeQuality | undefined, b: NodeQuality | undefined, sort: QualitySort, reverse = false, aNotice = false, bNotice = false) {
  const rank = (r: NodeQuality | undefined, notice: boolean) => notice || r?.infoNode ? 4 : !r ? 2 : !r.available ? 3 : qualityValue(r, sort) === null ? 1 : 0
  const ar = rank(a, aNotice), br = rank(b, bNotice)
  if (ar || br || !a || !b) return ar - br
  const descending = higherFirst(sort) !== reverse
  const primary = sort === 'ai' ? compareAi(a, b, descending) : metric(qualityValue(a, sort), qualityValue(b, sort), descending)
  if (primary) return primary
  const loss = metric(a.lossRate, b.lossRate), jitter = metric(a.jitterMs, b.jitterMs), latency = metric(a.httpsMs, b.httpsMs)
  if (sort === 'https' || sort === 'tls') return loss || jitter
  if (sort === 'loss') return jitter || latency
  if (sort === 'jitter' || sort === 'speed') return loss || latency
  return (sort === 'ai' ? 0 : compareAi(a, b, true)) || loss || latency
}
