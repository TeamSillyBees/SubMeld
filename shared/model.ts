import type { BaselinePolicy, QualitySnapshot } from './quality-snapshot.ts'
import type { z } from 'zod'
import type * as schema from '../server/schema.ts'

export type Filter = z.output<typeof schema.filter>
export type Source = z.output<typeof schema.source> & { urlStored?: boolean }
export type Group = z.input<typeof schema.group>
export type GroupMember = Group['members'][number]
export type Pool = Extract<GroupMember, { kind: 'pool' }>
export type Provider = z.output<typeof schema.provider> & { urlStored?: boolean; catalogId?: string }
export type Service = Omit<z.input<typeof schema.service>, 'provider'> & { provider: Provider | null }
export type Rule = z.output<typeof schema.rule>
export type Base = z.output<typeof schema.draft>['base']

export interface Draft {
  qualityBaselinePolicy?: BaselinePolicy
  sources: Source[]
  groups: Group[]
  services: Service[]
  rules: Rule[]
  base: Base
}

export type Library = Omit<z.input<typeof schema.library>, 'providers'> & { providers: (Provider & { id: string; name: string })[] }

export type Note = z.output<typeof schema.nodeNote>

export type Connection = Record<string, unknown>

export interface RawNode {
  id: string
  name: string
  type: string
  region: string
  fingerprint: string
  connection?: Connection
}

export interface RejectedItem { item: string; reason: string }

export interface SourceData {
  nodes: RawNode[]
  total: number
  format: string
  rejected: RejectedItem[]
  urls?: string[]
}

export interface ProviderData { behavior: Provider['behavior']; payload: string[]; count?: number }

export type SourceMap = Record<string, SourceData | null | undefined>
export type ProviderMap = Record<string, ProviderData | null | undefined>

export interface SubscriptionInfo {
  upload?: number
  download?: number
  total?: number
  expire?: number
  updatedAt: string
}

export interface Diff {
  before: number
  after: number
  added: number
  removed: number
  changed: number
  addedNames?: string[]
  removedNames?: string[]
  changedNames?: string[]
}

export interface Issue {
  severity: 'error' | 'warning'
  pane: string
  id: string | null
  code: string
  message: string
  relatedId?: string
}

export type ReportIssue = (severity: Issue['severity'], pane: string, id: string | null, code: string, message: string, relatedId?: string) => void
export interface EvaluatedRule extends Rule {
  position: number
  service: string
  target: string
  outlet: string
  catalogKey?: string
}

export interface ProjectedMember { key: string; name: string; kind: 'group' | 'node' | 'builtin' }

export interface FilteredNode {
  key: string
  id: string
  sourceId: string
  sourceName: string
  originalName: string
  name: string
  type: string
  region: string
  kept: boolean
  reasons: string[]
  fingerprint: string
  raw: RawNode
}

export interface NodeView extends Omit<FilteredNode, 'raw' | 'fingerprint'> {
  collision: boolean
  duplicateCount: number
  duplicates: { key: string; source: string; name: string }[]
}

export interface SourceStats {
  id: string
  name: string
  enabled: boolean
  original: number
  retained: number
  excluded: number
  unknown: number
  unsupported: number
}

export interface Counts {
  sources: number
  nodes: number
  groups: number
  rules: number
}

export interface Projection {
  counts: Counts
  sources: SourceStats[]
  groups: (Pick<Group, 'id' | 'name' | 'enabled' | 'type'> & { members: ProjectedMember[] })[]
  rules: EvaluatedRule[]
  issues: Issue[]
  nodes: NodeView[]
}

export type RuleProvider =
  | { type: 'http'; url: string; behavior: string; format: string; path: string; interval: number }
  | { type: 'inline'; behavior: string; payload: string[] }

export interface MihomoConfig extends Record<string, unknown> {
  proxies: (Connection & { name: string })[]
  'proxy-groups': { name: string; type: Group['type']; proxies: string[]; interval?: number; tolerance?: number }[]
  dns: Record<string, unknown>
  'rule-providers'?: Record<string, RuleProvider>
  rules: string[]
}

export interface MatchResult {
  error?: string
  domain?: string
  match?: EvaluatedRule | null
  uncertain?: EvaluatedRule[]
  mode?: string
  message?: string
}

export interface Pending { accepted: boolean; count: number; reason: string }

export interface RecordSummary {
  lastAttempt: string | null
  lastSuccess: string | null
  error: string | null
  hasData: boolean
  status: string
  next: string | null
}

export interface SourceSummary extends RecordSummary {
  nodesVersion: string | null
  subscriptionInfo: SubscriptionInfo | null
  pending: Pending | null
}

export interface SourceRecord extends SourceSummary {
  good: SourceData | null
  pending: (Pending & { diff?: Diff | null; data?: SourceData | null }) | null
}

export interface ProviderRecord extends RecordSummary { good: ProviderData | null; pending: null }

export interface SourceNodes {
  nodesVersion: string | null
  good: SourceData | null
  candidate: SourceData | null
}

export type EntryKind = 'source' | 'provider'

export interface PublishedEntry extends RecordSummary {
  id: string
  kind: EntryKind
  name: string
  local?: boolean
}

export interface VersionSummary {
  seq: number
  at: string
  qualityReportId?: string | null
  qualityDeviceId?: string | null
  kind: 'publish' | 'auto' | 'rollback'
  parent: number | null
  counts: Counts
}

export interface WorkspaceStatus {
  id: string
  revision: number
  metadataVersion: string
  statusVersion: string
  sources: Record<string, SourceSummary>
  providers: Record<string, ProviderRecord>
  publishedOnly: PublishedEntry[]
  current: VersionSummary | null
  dirty: boolean
  hasLink: boolean
  revoked: boolean
  unread: boolean
}

export interface Metadata {
  title: string
  profiles: { id: string; title: string }[]
  draft: Draft
  notes: Record<string, Note>
  library: Library
}

export interface WorkspaceState extends WorkspaceStatus, Metadata { sources: Record<string, SourceRecord> }

export interface UpdateLog {
  id: string
  entryId: string
  name: string
  kind: EntryKind
  at: string
  outcome: string
  trigger: string
  message: string
  diff?: Diff | null
  rejected?: RejectedItem[]
  usedOld?: boolean
}

export interface Profile {
  fixedQualitySnapshot?: QualitySnapshot
  id: string
  title: string
  draft: Draft
  revision: number
  publishedRevision: number | null
  active: number | null
  token: string | null
  revoked: boolean
  readThrough: string | null
  renewalNotices?: { id: string; date: string; expire: number | null }[]
}

export interface Version extends VersionSummary { qualitySnapshot?: QualitySnapshot | null; yaml: string; view: Projection; recipe: Draft }
