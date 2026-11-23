import type { QualityReport } from './quality.ts'
import type { Surface } from './quality-options.ts'

export const platformSurfaces = {
  ChatGPT: ['chatgptWeb', 'chatgptApp'], Gemini: ['gemini'], Claude: ['claudeWeb', 'claudeApi'], Grok: ['grok'],
} as const satisfies Record<string, readonly Surface[]>
export type Platform = keyof typeof platformSurfaces
export type QualitySort = 'https' | 'tls' | 'loss' | 'speed' | 'ai' | Platform

export interface NodeQuality {
  available: boolean
  httpsMs: number | null
  tlsMs: number | null
  lossRate: number | null
  speedMbps: number | null
  speedFailed: boolean
  reachable: Surface[] | null
}
export interface QualitySnapshot { reportId: string; rows: Record<string, NodeQuality> }
export function qualitySnapshot(report: QualityReport): QualitySnapshot {
  const rows: QualitySnapshot['rows'] = {}
  for (const r of report.results) {
    const speedFailed = r.speed?.stop === 'error' || Boolean(r.speed && !r.speed.bytes)
    rows[r.key] = {
      available: r.available, httpsMs: r.httpsMedianMs, tlsMs: r.tlsMedianMs, lossRate: r.lossRate,
      speedMbps: r.speed && !speedFailed ? r.speed.averageBps * 8 / 1_000_000 : null, speedFailed,
      reachable: r.ai ? (Object.keys(r.ai) as Surface[]).filter(key => r.ai![key].state === 'reachable' && !r.ai![key].needsReview) : null,
    }
  }
  return { reportId: report.jobId, rows }
}

export function qualityValue(row: NodeQuality, sort: QualitySort): number | null {
  if (sort === 'https') return row.httpsMs
  if (sort === 'tls') return row.tlsMs
  if (sort === 'loss') return row.lossRate
  if (sort === 'speed') return row.speedMbps
  if (!row.reachable) return null
  const score = (channels: readonly Surface[]) => channels.filter(s => row.reachable!.includes(s)).length / channels.length
  return sort === 'ai' ? Object.values(platformSurfaces).reduce((total, channels) => total + score(channels), 0) : score(platformSurfaces[sort])
}
export function compareQuality(a: NodeQuality | undefined, b: NodeQuality | undefined, sort: QualitySort) {
  const rank = (r?: NodeQuality) => !r ? 3 : !r.available ? 2 : qualityValue(r, sort) === null ? 1 : 0
  const priority = rank(a) - rank(b)
  if (priority || !a?.available || !b?.available) return priority
  const av = qualityValue(a, sort), bv = qualityValue(b, sort)
  if (av === null || bv === null) return 0
  const value = sort === 'https' || sort === 'tls' || sort === 'loss' ? av - bv : bv - av
  if (value || sort !== 'loss') return value
  return (a.httpsMs ?? Number.MAX_VALUE) - (b.httpsMs ?? Number.MAX_VALUE)
}
