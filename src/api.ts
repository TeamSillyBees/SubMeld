import type {
  Connection, Draft, EntryKind, Issue, Library, MatchResult, Metadata, Note, Projection, Provider,
  ProviderData, Source, SourceData, SourceNodes, UpdateLog, VersionSummary, WorkspaceState, WorkspaceStatus,
} from '../shared/model.ts'

import type { QualitySnapshot } from '../shared/quality-snapshot.ts'
import type { DevicePairing, ProbeDevice, QualityConfig, QualityJob, QualityReport } from '../shared/quality.ts'

export interface Session { authenticated: boolean; configured: boolean; setup?: boolean }
export interface LocalInput { format: 'yaml' | 'links'; text: string; acceptPartial?: boolean }
export interface LinkInfo { url: string | null; active: boolean; revoked: boolean }
export interface ProviderContents { entries: string[]; total: number; at: string | null }
export type ProbeSource = SourceData & { savedData?: SourceData }
export type MatchResponse = MatchResult & { checkedOnly?: boolean; issues: Issue[] }
export type Backup = { type: string; salt: string; iv: string; tag: string; data: string }
interface SourceExport {
  version: number
  sources: Source[]
  localNodes?: Record<string, Connection[]>
}

interface Requests {
  'quality/queue': { targetDeviceId: string; keys: string[]; config: QualityConfig }
  'quality/invite': Record<string, never>
  'quality/revoke': { id: string }
  'quality/rename': { id: string; remark: string }
  'quality/reassign': { id: string; targetDeviceId: string }
  'quality/cancel': { id: string }
  probe: { kind: 'source'; id: string; url?: string; input?: LocalInput } | ({ kind: 'provider'; id: string } & Provider)
  draft: { revision: number; draft: Draft; localInputs?: Record<string, LocalInput>; localNodes?: Record<string, Connection[]> }
  check: { qualityReportId?: string | null; expectedQualityReportId?: string | null }
  match: { domain: string; qualityReportId?: string | null; draft?: Draft; serviceId?: string }
  candidate: { id: string; accept: boolean }
  refresh: { id?: string; kind?: EntryKind }
  publish: { revision: number; qualityReportId?: string | null; expectedQualityReportId?: string | null }
  rollback: { seq: number }
  link: { action: 'rotate' | 'revoke' } | undefined
  profiles: { action: 'create' | 'clone' | 'rename' | 'delete'; title?: string }
  library: Library
  note: Note & { sourceId: string; nodeId: string }
  password: { current: string; password: string }
  'renewal-reminders': { timeZone: string; dates: string[] }
  'updates/read': Record<string, never>
  'sources/import': Omit<SourceExport, 'version'> & { revision: number; version?: number }
  'backup/import': { backup: Backup; passphrase: string }
  'backup/export': { passphrase: string }
}

interface Responses {
  'quality/jobs': QualityJob[]
  'quality/devices': ProbeDevice[]
  'quality/rename': { ok: boolean }
  'quality/reassign': QualityJob
  'quality/invite': DevicePairing
  'quality/revoke': { ok: boolean }
  'quality/queue': QualityJob
  'quality/cancel': QualityJob
  [path: `quality/snapshot?id=${string}`]: QualitySnapshot
  [path: `quality/report?id=${string}`]: QualityReport
  state: WorkspaceState
  'state?nodes=0': Metadata & WorkspaceStatus
  status: WorkspaceStatus
  [path: `source-nodes?id=${string}`]: SourceNodes
  [path: `source-address?id=${string}`]: { url: string }
  [path: `history?offset=${number}`]: VersionSummary[]
  [path: `updates?offset=${number}`]: UpdateLog[]
  [path: `provider-content?id=${string}`]: ProviderContents
  history: VersionSummary[]
  updates: UpdateLog[]
  current: Projection | null
  check: Projection & { revision: number }
  match: MatchResponse
  link: LinkInfo
  'renewal-reminders': { id: string; date: string }[]
  refresh: { queued: number }
  'updates/read': { ok: boolean }
  note: { ok: boolean }
  password: { ok: boolean }
  'backup/export': Backup
  'sources/export': SourceExport
  draft: WorkspaceState
  publish: WorkspaceState
  rollback: WorkspaceState
  profiles: WorkspaceState
  candidate: WorkspaceState
  library: WorkspaceState
  'sources/import': WorkspaceState
  'backup/import': WorkspaceState
}
export type Endpoint = keyof Responses | 'probe'
export type Payload<P extends Endpoint> = P extends keyof Requests ? Requests[P] : undefined
export type ResponseFor<P extends Endpoint, B = Payload<P>> =
  P extends keyof Responses ? Responses[P] : B extends { kind: 'source' } ? ProbeSource : ProviderData

export type Call = <P extends Endpoint, const B extends Payload<P>>(
  path: P,
  ...args: undefined extends Payload<P> ? [body?: B] : [body: B]
) => Promise<ResponseFor<P, B>>

export async function api<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
  const response = await fetch(path, body === undefined ? options : {
    ...options, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (response.ok) return response.json()
  const payload = await response.json().catch(() => null)
  throw Object.assign(new Error(payload?.message ?? '请求失败，请检查服务是否在线。'), { status: response.status, detail: payload?.detail })
}
