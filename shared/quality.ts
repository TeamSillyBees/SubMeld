import { z } from 'zod'
import { maxQualityNodes, surfaces, type Surface } from './quality-options.ts'
export { maxQualityNodes, qualityDefaults, surfaces, surfaceNames } from './quality-options.ts'
export type { Surface } from './quality-options.ts'

const integer = (min: number, max: number) => z.number().int().min(min).max(max)
export const qualityConfig = z.strictObject({
  rounds: integer(2, 8), concurrency: integer(1, 12), bandwidth: z.boolean(),
  speedConcurrency: integer(1, 2), seconds: integer(2, 15), mebibytes: integer(1, 32), ai: z.boolean(),
})
export type QualityConfig = z.infer<typeof qualityConfig>
export const aiStates = ['reachable', 'authentication', 'region_restricted', 'region_mismatch', 'challenge', 'ip_blocked', 'rate_limited', 'unknown', 'network_error'] as const
export const evidenceTypes = ['web_entry', 'login_redirect', 'credentials_required', 'region_denied', 'region_disagrees', 'region_unconfirmed', 'cf_challenge', 'ip_denied', 'rate_limit', 'unrecognized', 'network'] as const
const country = z.string().regex(/^[A-Z]{2}$/)
const aiReading = z.strictObject({
  state: z.enum(aiStates), evidence: z.enum(evidenceTypes), httpStatus: integer(100, 599).nullable(),
  needsReview: z.boolean(), providerRegion: country.nullable(),
})
export type AiReading = z.infer<typeof aiReading>
export type AiResults = Record<Surface, AiReading>
const ms = z.number().nonnegative().max(600_000)
export const latencySample = z.strictObject({ tlsMs: ms.nullable(), httpsMs: ms.nullable() })
export type LatencySample = z.infer<typeof latencySample>
const speedReading = z.strictObject({
  bytes: integer(0, 32 * 1024 ** 2), elapsedMs: ms, averageBps: z.number().nonnegative(), peakBps: z.number().nonnegative(),
  perSecondBps: z.array(z.number().nonnegative()).max(15), stop: z.enum(['bytes', 'duration', 'end', 'error']),
})
export type SpeedReading = z.infer<typeof speedReading>
export const qualityKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}\/[A-Za-z0-9_-]{8,64}$/)
const nodeLabel = z.object({ key: qualityKey, name: z.string().max(1024), sourceName: z.string().max(256) })
export const qualityNode = nodeLabel.extend({ connection: z.record(z.string(), z.unknown()) })
export type QualityNode = z.infer<typeof qualityNode>
export const assignmentSchema = z.object({
  schemaVersion: z.literal(1), jobId: z.uuid(), createdAt: z.iso.datetime(), config: qualityConfig, nodes: z.array(qualityNode).min(1).max(maxQualityNodes),
})
export type Assignment = z.infer<typeof assignmentSchema>
export const resultRow = z.strictObject({
  key: qualityKey, available: z.boolean(), error: z.enum(['invalid_node', 'no_response']).nullable(),
  samples: z.array(latencySample).max(8), tlsMedianMs: ms.nullable(), httpsMedianMs: ms.nullable(),
  jitterMs: ms.nullable(), lossRate: z.number().min(0).max(1).nullable(),
  exit: z.strictObject({ ip: z.union([z.ipv4(), z.ipv6()]), region: country.nullable() }).nullable(),
  speed: speedReading.nullable(), ai: z.record(z.enum(surfaces), aiReading).nullable(),
})
export type QualityRow = z.infer<typeof resultRow>
export const stages = ['starting', 'latency', 'bandwidth', 'ai', 'uploading'] as const
export const progressSchema = z.strictObject({ stage: z.enum(stages), done: integer(0, maxQualityNodes), total: integer(0, maxQualityNodes) }).refine(p => p.done <= p.total)
export type Progress = z.infer<typeof progressSchema>
export const reportSchema = z.strictObject({
  schemaVersion: z.literal(1), jobId: z.uuid(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), results: z.array(resultRow).min(1).max(maxQualityNodes),
})
export type AgentReport = z.infer<typeof reportSchema>
export type JobStatus = 'waiting' | 'running' | 'completed' | 'cancelled' | 'expired' | 'failed'
export interface QualityJob {
  id: string; createdAt: string; finishedAt: string | null; expiresAt: string; status: JobStatus
  config: QualityConfig; total: number; progress: Progress; available: number | null
  failure: 'probe_error' | 'disconnected' | null
}
export interface QualityReport extends Omit<AgentReport, 'results'> {
  createdAt: string; config: QualityConfig
  results: (QualityRow & { name: string; sourceName: string })[]
}
export interface ProbeDevice { name: string; platform: 'windows' | 'linux'; lastSeen: string; online: boolean }
export interface DevicePairing { pairing: string; expiresAt: string }
export interface Pairing { job: QualityJob; pairing: string }
