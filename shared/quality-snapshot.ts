import type { AiReading, AiResults, AvailabilityStats, LatestNodeQuality, QualityReport, QualityRow } from './quality.ts'
import { aiSkipReason, isSubscriptionNotice, surfaces, type Surface } from './quality-options.ts'
export type { AvailabilityStats, LatestNodeQuality } from './quality.ts'
export type LatestQualityMap = Record<string, Record<string, LatestNodeQuality>>

export const platformSurfaces = {
  ChatGPT: ['chatgptWeb', 'chatgptApp'], Gemini: ['gemini'], Antigravity: ['antigravity'],
} as const satisfies Record<string, readonly Surface[]>
export const platforms = ['ChatGPT', 'Gemini', 'Antigravity'] as const
export type Platform = typeof platforms[number]
export const qualitySorts = ['https', 'tls', 'loss', 'jitter', 'speed', 'availability', 'ai', ...platforms] as const
export type QualitySort = typeof qualitySorts[number]
export const verdictScores = { unlocked: 3, partial_unlock: 2, degraded_challenge: 1, region_restricted: 0, blocked_or_unreachable: -1 } as const
export type Verdict = keyof typeof verdictScores
export const verdictLabels: Record<Verdict, string> = {
  unlocked: '全入口可达', partial_unlock: '部分入口可达', degraded_challenge: '需浏览器验证', region_restricted: '地区受限', blocked_or_unreachable: '封禁或连接失败',
}
type PlatformResults = Record<Platform, Verdict | null>

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
  aiResults?: AiResults | null
  aiSkipped?: 'missing_exit' | 'weak_connection'
  availabilityRate?: number | null
  availability?: AvailabilityStats | null
}
export interface QualitySnapshot {
  reportId?: string; rows: Record<string, NodeQuality>
  config?: { bandwidth: boolean; ai: boolean }
  targetDeviceName?: string | null; targetDeviceId?: string | null
}

export type AiDisplayStatus =
  | { tone: 'success'; label: string }
  | { tone: 'danger'; label: '受限' }
  | { tone: 'warning'; label: '未知' }

export function getAiDisplayStatus(reading: AiReading | null | undefined, exitRegion?: string | null): AiDisplayStatus | null {
  if (!reading) return null
  if (reading.needsReview) return { tone: 'warning', label: '未知' }
  if (reading.state === 'reachable') {
    return { tone: 'success', label: reading.providerRegion || exitRegion || '可用' }
  }
  if (reading.state === 'region_restricted' || reading.state === 'ip_blocked' || reading.state === 'unavailable') {
    return { tone: 'danger', label: '受限' }
  }
  return { tone: 'warning', label: '未知' }
}

const reached = (r: AiReading | null | undefined) => Boolean(r && r.state === 'reachable' && !r.needsReview)
export function platformVerdict(ai: AiResults, platform: Platform): Verdict | null {
  const readings = platformSurfaces[platform].map(s => ai[s]).filter((r): r is AiReading => Boolean(r))
  if (readings.length === 0) return null
  if (readings.length === platformSurfaces[platform].length && readings.every(reached)) return 'unlocked'
  const restricted = readings.some(r => r.state === 'region_restricted' && !r.needsReview)
  if (restricted) return readings.some(reached) ? null : 'region_restricted'
  if (readings.some(reached)) return 'partial_unlock'
  if (readings.some(r => r.state === 'degraded_challenge' && !r.needsReview)) return 'degraded_challenge'
  return readings.length === platformSurfaces[platform].length
    && readings.every(r => !r.needsReview && (r.state === 'unavailable' || r.state === 'network_error' || r.state === 'ip_blocked'))
    ? 'blocked_or_unreachable' : null
}
export function inferredExitRegion(row: QualityRow): string | null {
  const basicSkipped = row.samples.length === 0 && row.error === null
  if (row.exit?.region || (!row.available && !basicSkipped) || !row.ai || row.aiSkipped || aiSkipReason(row)) return null
  const regions = Object.values(row.ai).flatMap(r => r && r.providerRegion && r.evidence !== 'exit_region_fallback' ? [r.providerRegion] : [])
  return regions.length >= 2 && regions.every(region => region === regions[0]) ? regions[0] : null
}
export function qualitySnapshot(report: QualityReport): QualitySnapshot {
  const rows: QualitySnapshot['rows'] = {}
  for (const r of report.results) {
    const speedFailed = r.speed?.stop === 'error' || Boolean(r.speed && !r.speed.bytes)
    // Older probes could copy another node's observations onto a weak link.
    const skipReason = r.aiSkipped ?? (r.ai ? aiSkipReason(r) : null)
    const ai = skipReason ? null : r.ai
    const reachableViaAi = !report.config.basic && Boolean(ai && (r.exit !== null || Object.values(ai).some(v => v && v.state !== 'network_error')))
    const available = r.available || reachableViaAi
    const failed = ai ? surfaces.filter(s => !reached(ai[s])) : []
    const inferred = inferredExitRegion({ ...r, available })
    rows[r.key] = {
      available, httpsMs: r.httpsMedianMs, tlsMs: r.tlsMedianMs, lossRate: r.lossRate, jitterMs: r.jitterMs,
      exitRegion: r.exit?.region ?? inferred, ...(inferred && { exitRegionInferred: true }),
      ipStack: r.exit ? (r.exit.ip.includes(':') ? 'ipv6' : 'ipv4') : null,
      infoNode: r.error === 'info_node' || isSubscriptionNotice(r.name),
      speedMbps: r.speed && !speedFailed ? r.speed.averageBps * 8 / 1_000_000 : null, speedFailed,
      reachable: ai ? surfaces.filter(s => reached(ai[s])) : null,
      ...(ai && failed.length > 0 && { surfaceIssues: Object.fromEntries(failed.map(s => [s, !ai[s] ? 'unknown' : ai[s].state === 'reachable' ? 'unknown' : ai[s].state])) }),
      platforms: ai ? Object.fromEntries(platforms.map(p => [p, platformVerdict(ai, p)])) as PlatformResults : null,
      aiResults: ai,
      ...(skipReason && { aiSkipped: skipReason }),
    }
  }
  return { reportId: report.jobId, targetDeviceId: report.targetDeviceId ?? null, targetDeviceName: report.targetDeviceName ?? null,
    config: { bandwidth: report.config.basic && report.config.bandwidth, ai: report.config.ai }, rows }
}
export function nodeQualityFromLatest(record: LatestNodeQuality): NodeQuality {
  const ai = record.ai && !record.ai.aiSkipped ? record.ai.results : null
  const aiExit = record.ai?.exit ?? null
  const exit = record.basic?.exit ?? aiExit
  const reachableViaAi = record.basic === null
    && Boolean(ai && (aiExit !== null || Object.values(ai).some(v => v && v.state !== 'network_error')))
  const available = record.basic ? record.basic.available : reachableViaAi
  const canInferExit = !exit?.region && Boolean(ai)
    && (record.basic === null || (record.basic.available && !aiSkipReason({ lossRate: record.basic.lossRate, httpsMedianMs: record.basic.httpsMs })))
  const regions = canInferExit && ai
    ? Object.values(ai).flatMap(r => r && r.providerRegion && r.evidence !== 'exit_region_fallback' ? [r.providerRegion] : [])
    : []
  const inferred = regions.length >= 2 && regions.every(region => region === regions[0]) ? regions[0] : null
  const failed = ai ? surfaces.filter(s => !reached(ai[s])) : []
  const exitIp = exit?.ip ?? null
  return {
    available,
    httpsMs: record.basic?.httpsMs ?? null,
    tlsMs: record.basic?.tlsMs ?? null,
    lossRate: record.basic?.lossRate ?? null,
    jitterMs: record.basic?.jitterMs ?? null,
    exitRegion: exit?.region ?? inferred,
    ...(inferred && { exitRegionInferred: true }),
    ipStack: exitIp ? (exitIp.includes(':') ? 'ipv6' : 'ipv4') : null,
    infoNode: record.basic?.infoNode ?? false,
    speedMbps: record.speed && !record.speed.speedFailed ? record.speed.speedMbps : null,
    speedFailed: record.speed?.speedFailed ?? false,
    reachable: ai ? surfaces.filter(s => reached(ai[s])) : null,
    ...(ai && failed.length > 0 && { surfaceIssues: Object.fromEntries(failed.map(s => [s, !ai[s] ? 'unknown' : ai[s].state === 'reachable' ? 'unknown' : ai[s].state])) }),
    platforms: ai ? Object.fromEntries(platforms.map(p => [p, platformVerdict(ai, p)])) as PlatformResults : null,
    aiResults: ai,
    ...(record.ai?.aiSkipped && { aiSkipped: record.ai.aiSkipped }),
    availability: record.availability,
    availabilityRate: record.availability && record.availability.total > 0 ? record.availability.rate : null,
  }
}
export function latestQualitySnapshot(records: Record<string, LatestNodeQuality>, deviceId?: string | null): QualitySnapshot {
  const rows: QualitySnapshot['rows'] = {}
  for (const [key, record] of Object.entries(records)) {
    if (!record.basic && !record.speed && !record.ai && !record.availability) continue
    rows[key] = nodeQualityFromLatest(record)
  }
  return { targetDeviceId: deviceId ?? null, rows }
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
  if (sort === 'availability') return row.availabilityRate ?? (row.availability && row.availability.total > 0 ? row.availability.rate : null)
  if (sort === 'ai') {
    const scores = platforms.flatMap(p => qualityValue(row, p) ?? [])
    return scores.length ? scores.reduce((sum, n) => sum + n, 0) : null
  }
  const verdict = verdictFor(row, sort)
  return verdict === null ? null : verdictScores[verdict]
}

export const higherFirst = (sort: QualitySort) => sort === 'availability' || sort === 'speed' || sort === 'ai' || Object.hasOwn(platformSurfaces, sort)
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
  const rank = (r: NodeQuality | undefined, notice: boolean) => {
    if (notice || r?.infoNode) return 4
    if (!r) return 2
    const value = qualityValue(r, sort)
    if (sort === 'availability') return value !== null ? 0 : !r.available ? 3 : 1
    return !r.available ? 3 : value === null ? 1 : 0
  }
  const ar = rank(a, aNotice), br = rank(b, bNotice)
  if (ar || br || !a || !b) return ar - br
  const descending = higherFirst(sort) !== reverse
  const primary = sort === 'ai' ? compareAi(a, b, descending) : metric(qualityValue(a, sort), qualityValue(b, sort), descending)
  if (primary) return primary
  const loss = metric(a.lossRate, b.lossRate), jitter = metric(a.jitterMs, b.jitterMs), latency = metric(a.httpsMs, b.httpsMs)
  if (sort === 'https' || sort === 'tls') return loss || jitter
  if (sort === 'loss') return jitter || latency
  if (sort === 'jitter' || sort === 'speed') return loss || latency
  if (sort === 'availability') return metric(Number(a.available), Number(b.available), true) || loss || latency
  return (sort === 'ai' ? 0 : compareAi(a, b, true)) || loss || latency
}
