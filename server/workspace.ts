import type { Diff, Draft, EntryKind, Library, Metadata, Profile, Projection, Provider, ProviderData, ProviderMap, ProviderRecord, Source, SourceData, SourceMap, SourceNodes, SourceRecord, SourceSummary, SubscriptionInfo, UpdateLog, Version, VersionSummary, WorkspaceState, WorkspaceStatus } from '../shared/model.ts'
import type { Dataset, DocumentRow, StoredRecord } from './records.ts'
import type { Store } from './store.ts'
import type { RemoteOptions, Secrets } from './remote.ts'
import type { Verifier } from './core.ts'
import type { LoadRuleSetList } from './rule-set-preview.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { stringify } from 'yaml'
import { z } from 'zod'
import { blankDraft } from '../shared/catalog.ts'
import { calendarFormatter, reminderKey, upcomingRenewals } from '../shared/subscription.ts'
import { draftDataset, evaluate, filterNodes, structuralGroupIssues } from '../shared/config.ts'
import { createRuleSetMatcher } from './rule-set-preview.ts'
import { compareDigest, configHasSubscriptionSecret, digest, parseProvider, parseSource, safeYaml } from './parse.ts'
import { download, hasSecret, subscriptionSecrets } from './remote.ts'
import { draft as draftSchema, id, library as librarySchema, nodeNote, objectValue, provider as providerSchema, read, source as sourceSchema, url as urlSchema, UserError } from './schema.ts'

type ProfileId = string | null | undefined
type Body = Record<string, unknown>
type SourceKey = `source/${string}`
type ProviderKey = `provider/${string}`
type SourceEntry = Pick<Source, 'id' | 'url'>
type ProviderEntry = { id: string; provider: Provider | null }
type Job = { id: string; name: string; url: string; minutes: number; enabled: boolean; paused: boolean; recipe: boolean } &
  ({ kind: 'source'; key: SourceKey; local?: boolean } | { kind: 'provider'; key: ProviderKey; local?: never; format: Provider['format']; behavior: Provider['behavior'] })
interface QueueEntry { profileId: string; job: Job; trigger: string; key: string; snapshot: number }
interface Probe { data: Dataset; expires: number; subscriptionInfo: SubscriptionInfo | null }
type SourceFields = Omit<SourceRecord, 'status' | 'next'>
type SourceBrief = Omit<SourceSummary, 'status' | 'next'>
type ProviderFields = Omit<ProviderRecord, 'status' | 'next'>
type RecordView = { kind: 'source'; summary: SourceBrief; full?: SourceFields } | { kind: 'provider'; summary: ProviderFields }
type Snapshot = { metadata: Metadata; status: WorkspaceStatus }
type Compilation = { yaml: string | null; view: Projection }
type Download = Awaited<ReturnType<typeof download>>
const sourceData = (data?: Dataset | null) => data && 'nodes' in data ? data : null
const providerData = (data?: Dataset | null) => data && 'payload' in data ? data : null
export const timestamp = () => new Date().toISOString()
export const versionSpace = (profile: Profile) => `versions/${profile.id}` as const
export const dataSpace = (profile: Profile) => `datasets/${profile.id}` as const
export const logSpace = (profile: Profile) => `updates/${profile.id}` as const
export const noteSpace = (profile: Profile) => `notes/${profile.id}` as const
const versionKey = (seq: unknown) => String(seq).padStart(12, '0')
const defaultLibrary: Library = { filters: [], groups: [], providers: [] }
const localInputSchema = z.object({ format: z.enum(['yaml', 'links']), text: z.string().min(1) })
const errorMessage = (error: unknown) => error instanceof UserError ? error.message : '服务端处理失败，请稍后重试。'

export function makeProfile(title: string, draft = blankDraft()): Profile {
  return { id: randomUUID(), title, draft, revision: 1, publishedRevision: null, active: null, token: null, revoked: false, readThrough: null }
}

export function datasetKey(kind: 'source', entry: SourceEntry): SourceKey
export function datasetKey(kind: 'provider', entry: ProviderEntry): ProviderKey
export function datasetKey(...[kind, entry]: ['source', SourceEntry] | ['provider', ProviderEntry]): SourceKey | ProviderKey {
  if (kind === 'source') return `source/${entry.id}/${digest(entry.url)}`
  const { url, format, behavior } = entry.provider!
  return `provider/${entry.id}/${digest([url, format, behavior].join('\n'))}`
}

function recordFor(kind: 'source', entry: Source, recipe?: boolean): Extract<Job, { kind: 'source' }>
function recordFor(kind: 'provider', entry: Draft['services'][number], recipe?: boolean): Extract<Job, { kind: 'provider' }>
function recordFor(...[kind, entry, recipe = false]: ['source', Source, boolean?] | ['provider', Draft['services'][number], boolean?]): Job {
  if (kind === 'source') return { kind, id: entry.id, name: entry.name, url: entry.url, minutes: entry.minutes, enabled: entry.enabled, paused: entry.local || entry.paused, local: entry.local, key: datasetKey(kind, entry), recipe }
  return { kind, id: entry.id, name: entry.name, ...entry.provider!, enabled: entry.enabled, paused: false, key: datasetKey(kind, entry), recipe }
}

function jobsFor(draft: Draft, recipe = false): Job[] {
  return [
    ...draft.sources.map(entry => recordFor('source', entry, recipe)),
    ...draft.services.filter(entry => entry.provider).map(entry => recordFor('provider', entry, recipe)),
  ]
}

function nextAttempt(record: { lastAttempt?: string | null } | null, minutes: number) {
  return record?.lastAttempt ? new Date(Date.parse(record.lastAttempt) + minutes * 60000).toISOString() : null
}

function stripUrls(draft: Draft): Draft {
  return {
    ...draft,
    sources: draft.sources.map(({ url, ...source }) => ({ ...source, url: '', urlStored: Boolean(url) })),
    services: draft.services.map(service => ({
      ...service,
      provider: service.provider ? { ...service.provider, url: '', urlStored: Boolean(service.provider.url) } : null,
    })),
  }
}

function publicationRecipe(draft: Draft): Draft {
  return { ...draft, sources: draft.sources.map(({ renewalDate, ...source }) => source) }
}

function redact<T>(value: T, secrets: Secrets): T
function redact(value: unknown, secrets: Secrets): unknown {
  if (typeof value === 'string') return hasSecret(value, secrets) ? '（已遮挡敏感内容）' : value
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(child => redact(child, secrets))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]))
}

function publicSource(data: SourceData, secrets: Secrets): SourceData {
  return {
    total: data.total, format: data.format, rejected: redact(data.rejected, secrets),
    nodes: data.nodes.map(({ name, id, type, region, fingerprint }) => ({ name: redact(name, secrets), id, type, region, fingerprint })),
  }
}

function publicProvider(data: ProviderData): ProviderData {
  return { behavior: data.behavior, count: data.payload.length, payload: data.payload.length ? [''] : [] }
}

function sourceFields(record: StoredRecord | null, secrets: Secrets): SourceFields {
  const saved = sourceData(record?.good)
  const good = saved ? publicSource(saved, secrets) : null
  const candidate = record?.pending?.accepted ? publicSource(record.pending.data, secrets) : null
  return {
    lastAttempt: record?.lastAttempt ?? null, lastSuccess: record?.lastSuccess ?? null,
    error: redact(record?.error ?? null, secrets), good, hasData: Boolean(good),
    nodesVersion: good || candidate ? digest(JSON.stringify([good, candidate])) : null,
    subscriptionInfo: record?.subscriptionInfo ?? null,
    pending: record?.pending ? {
      accepted: record.pending.accepted, count: record.pending.data.nodes.length,
      reason: redact(record.pending.reason, secrets), diff: redact(record.pending.diff, secrets),
      ...(candidate ? { data: candidate } : {}),
    } : null,
  }
}

function computeDiff(previous: Dataset | null | undefined, data: Dataset, kind: EntryKind): Diff {
  if (kind === 'provider') {
    const before = new Set(providerData(previous)?.payload ?? [])
    const after = new Set(providerData(data)?.payload ?? [])
    return {
      before: before.size, after: after.size,
      added: [...after].filter(value => !before.has(value)).length,
      removed: [...before].filter(value => !after.has(value)).length,
      changed: 0,
    }
  }
  const before = new Map((sourceData(previous)?.nodes ?? []).map(node => [node.id, node]))
  const after = new Map((sourceData(data)?.nodes ?? []).map(node => [node.id, node]))
  const added = [...after.values()].filter(node => !before.has(node.id))
  const removed = [...before.values()].filter(node => !after.has(node.id))
  const changed = [...after.values()].filter(node => before.has(node.id) && before.get(node.id)!.fingerprint !== node.fingerprint)
  return {
    before: before.size, after: after.size, added: added.length, removed: removed.length, changed: changed.length,
    addedNames: added.slice(0, 100).map(node => node.name),
    removedNames: removed.slice(0, 100).map(node => node.name),
    changedNames: changed.slice(0, 100).map(node => node.name),
  }
}

interface WorkspaceOptions { store: Store; verify: Verifier; remote: RemoteOptions; loadRuleSetList?: LoadRuleSetList; tickMs?: number }
export type Workspace = ReturnType<typeof createWorkspace>
export function createWorkspace({ store, verify, remote, loadRuleSetList, tickMs = 15000 }: WorkspaceOptions) {
  if (!store.list('profiles', 1).length) {
    const profile = makeProfile('默认配置')
    store.set('profiles', profile.id, profile)
  }
  const probes = new Map<string, Probe>()
  const matchDomain = createRuleSetMatcher(loadRuleSetList)
  const running = new Map<string, string>()
  const pending: QueueEntry[] = []
  const work = new Set<Promise<void>>()
  const snapshots = new Map<string, Snapshot>()
  const recordSummaries = new Map<string, Map<string, RecordView>>()
  let defaultProfileId: string | undefined
  store.onWrite((space, key) => {
    const profileId = space?.split('/')[1]
    if (profileId) snapshots.delete(profileId)
    else snapshots.clear()
    if (!space || space === 'profiles') defaultProfileId = undefined
    // Subscription URLs also determine how names and diagnostics are redacted.
    if (!space || (space === 'system' && (!key || key === 'sourceUrls'))) recordSummaries.clear()
    else if (key === undefined) recordSummaries.delete(space)
    else recordSummaries.get(space)?.delete(key)
  })
  let generation = 0
  let serialization: Promise<unknown> = Promise.resolve()
  const mutate = <T>(action: () => T) => {
    const result = serialization.then(action)
    serialization = result.catch(() => {})
    return result
  }

  function profileFor(profileId?: ProfileId) {
    const profile = profileId ? store.get('profiles', profileId) : store.list('profiles', 1)[0]?.[1]
    if (!profile) throw new UserError('配置方案不存在。', 404)
    return profile
  }
  const activeVersion = (profile: Profile) => profile.active ? store.get(versionSpace(profile), versionKey(profile.active)) : null

  function getAllSecrets(extraUrls: string[] = []) {
    const saved = store.get('system', 'sourceUrls') ?? []
    return subscriptionSecrets([...saved, ...extraUrls])
  }

  function rememberUrls(urls?: string[]) {
    if (!urls?.length) return
    const previous = store.get('system', 'sourceUrls') ?? []
    const next = [...new Set([...previous, ...urls])]
    if (next.length !== previous.length) store.set('system', 'sourceUrls', next)
  }

  function dataFor(profile: Profile, draft: Draft, useDraft: boolean, replacement?: { key: string; data: Dataset } | null, owner?: string) {
    const nodes: SourceMap = {}
    const providers: ProviderMap = Object.fromEntries(draft.services.filter(service => service.inlineRules)
      .map(service => [service.id, { behavior: 'classical', payload: service.inlineRules! }]))
    for (const job of jobsFor(draft)) {
      const record = store.get(dataSpace(profile), job.key)
      const sample = replacement?.key === job.key ? replacement.data
        : useDraft ? draftDataset(record) ?? (owner ? takeProbe(probes, owner, profile, job)?.data : null) : record?.good
      if (job.kind === 'source') nodes[job.id] = sourceData(sample)
      else providers[job.id] = providerData(sample)
    }
    return { nodes, providers }
  }

  async function compile(profile: Profile, recipe: Draft, useDraft: boolean, replacement?: { key: string; data: Dataset }): Promise<Compilation> {
    const { nodes, providers } = dataFor(profile, recipe, useDraft, replacement)
    const compiled = evaluate(recipe, nodes, providers, true)
    const secrets = getAllSecrets([
      ...recipe.sources.map(source => source.url),
      ...Object.values(nodes).flatMap(data => data?.urls ?? []),
    ])
    if (configHasSubscriptionSecret(compiled.config, secrets)) {
      compiled.issues.push({ severity: 'error', code: 'privacy', pane: 'sources', id: null, message: '成品配置中含有完整的订阅地址，或名称、前缀、规则等字段含有下载令牌。请检查后重新发布。' })
    }
    const yaml = compiled.issues.some(issue => issue.severity === 'error')
      ? null
      : stringify(compiled.config, { lineWidth: 0, aliasDuplicateObjects: false })
    const coreIssue = yaml ? await verify(yaml, compiled) : null
    if (coreIssue) compiled.issues.push(coreIssue)
    const { config, ...projection } = compiled
    const view = redact({ ...projection, nodes: projection.nodes.filter(node => node.kept) }, secrets)
    return { yaml: coreIssue ? null : yaml, view }
  }

  function insertVersion(profile: Profile, recipe: Draft, compiled: Compilation, kind: Version['kind'], parent: number | null = null) {
    const version = {
      seq: (store.history(versionSpace(profile), 1, 0)[0]?.seq ?? 0) + 1,
      at: timestamp(), kind, parent, counts: compiled.view.counts, yaml: compiled.yaml!,
      recipe, view: compiled.view,
    }
    store.set(versionSpace(profile), versionKey(version.seq), version)
    profile.active = version.seq
    store.set('profiles', profile.id, profile)
    return version
  }

  function summarize(version: Version | null): VersionSummary | null {
    if (!version) return null
    const { yaml, recipe, view, ...summary } = version
    return summary
  }

  function plan(profile: Profile, active = activeVersion(profile)) {
    const merged = new Map(jobsFor(profile.draft).map(job => [job.key, job]))
    if (!active || active.kind === 'rollback') return [...merged.values()]
    for (const job of jobsFor(active.recipe, true).filter(job => job.enabled)) {
      const edit = merged.get(job.key)
      if (!edit) merged.set(job.key, job)
      else if (edit.enabled) merged.set(job.key, { ...edit, recipe: true })
      else merged.set(job.key, { ...edit, recipe: true, paused: true })
    }
    return [...merged.values()]
  }

  function checkRevision(profile: Profile, revision: unknown) {
    if (profile.revision !== revision) {
      throw new UserError('配置已在另一处更新。请重新打开编辑页面后重试。', 409)
    }
  }

  function parseDownload(job: Job, response: Download): Dataset {
    return job.kind === 'source' ? parseSource(response.bytes, response.urls) : parseProvider(response.bytes, job)
  }

  function persistLog(profile: Profile, job: Job, data: Omit<UpdateLog, 'id' | 'at' | 'name' | 'kind' | 'entryId'>) {
    const log = {
      id: randomUUID(), entryId: job.id, name: job.name, kind: job.kind, at: timestamp(),
      ...data,
    }
    store.set(logSpace(profile), log.at + '/' + log.id, log)
  }

  function metadataFor(profile: Profile, secrets: Secrets): Metadata {
    const library = store.get('system', 'library') ?? defaultLibrary
    return {
      title: redact(profile.title, secrets),
      profiles: store.list('profiles').map(([, profile]) => ({ id: profile.id, title: redact(profile.title, secrets) })),
      draft: redact(stripUrls(profile.draft), secrets),
      notes: Object.fromEntries(store.list(noteSpace(profile)).map(([key, note]) => [key, redact(note, secrets)])),
      library: { ...redact(library, secrets), providers: library.providers.map(({ url, ...entry }) => ({ ...redact(entry, secrets), url: '', urlStored: Boolean(url) })) },
    }
  }

  function readRecord(profile: Profile, job: Job, secrets: Secrets, includeNodes: boolean): RecordView {
    const space = dataSpace(profile)
    if (!recordSummaries.has(space)) recordSummaries.set(space, new Map())
    const cache = recordSummaries.get(space)!
    const cached = cache.get(job.key)
    if (!includeNodes && cached) return cached
    const record = store.get(space, job.key)
    if (job.kind === 'provider') {
      const data = providerData(record?.good)
      const summary: ProviderFields = {
        lastAttempt: record?.lastAttempt ?? null, lastSuccess: record?.lastSuccess ?? null,
        error: redact(record?.error ?? null, secrets), good: data ? publicProvider(data) : null, hasData: Boolean(data), pending: null,
      }
      const view = { kind: job.kind, summary }
      cache.set(job.key, view)
      return view
    }
    const full = sourceFields(record, secrets)
    const { good, pending, ...fields } = full
    const summary = { ...fields, pending: pending && { accepted: pending.accepted, count: pending.count, reason: pending.reason } }
    const view = { kind: job.kind, summary }
    cache.set(job.key, view)
    return { ...view, full }
  }

  function workspaceSnapshot(profileId?: ProfileId, includeNodes = false): Snapshot {
    const cached = snapshots.get(profileId || defaultProfileId || '')
    if (cached && !includeNodes) return cached
    const profile = profileFor(profileId)
    if (!profileId) defaultProfileId = profile.id
    const secrets = getAllSecrets()
    const metadata = metadataFor(profile, secrets)
    const active = activeVersion(profile)
    const jobs = plan(profile, active)
    const keys = new Set(jobsFor(profile.draft).map(job => job.key))
    const summaries = recordSummaries.get(dataSpace(profile))
    if (summaries) {
      const liveKeys = new Set<string>(jobs.map(job => job.key))
      for (const key of summaries.keys()) {
        if (!liveKeys.has(key)) summaries.delete(key)
      }
    }
    const sources: WorkspaceStatus['sources'] = Object.create(null)
    const fullSources: WorkspaceState['sources'] = Object.create(null)
    const providers: WorkspaceStatus['providers'] = Object.create(null)
    const publishedOnly: WorkspaceStatus['publishedOnly'] = []
    for (const job of jobs) {
      const inDraft = keys.has(job.key)
      const record = readRecord(profile, job, secrets, includeNodes && inDraft && job.kind === 'source')
      const { summary } = record
      const timing = {
        status: running.get(profile.id + '/' + job.key) ?? (summary.error ? 'failed' : summary.lastSuccess ? 'ready' : 'new'),
        next: job.enabled && !job.paused ? nextAttempt(summary, job.minutes) : null,
      }
      if (!inDraft) {
        const { lastAttempt, lastSuccess, error, hasData } = summary
        publishedOnly.push({ id: job.id, kind: job.kind, local: job.local, name: redact(job.name, secrets), lastAttempt, lastSuccess, error, hasData, ...timing })
      } else if (record.kind === 'source') {
        sources[job.id] = { ...record.summary, ...timing }
        if (record.full && includeNodes) fullSources[job.id] = { ...record.full, ...timing }
      } else providers[job.id] = { ...record.summary, ...timing }
    }
    const recent = store.list(logSpace(profile), 1)[0]?.[1]
    const status = {
      id: profile.id, revision: profile.revision, metadataVersion: digest(JSON.stringify(metadata)),
      sources, providers, publishedOnly, current: summarize(active), dirty: profile.revision !== profile.publishedRevision,
      hasLink: Boolean(profile.token), revoked: profile.revoked, unread: Boolean(recent && recent.at > (profile.readThrough ?? '')),
    }
    const versioned = { ...status, statusVersion: digest(JSON.stringify(status)) }
    snapshots.set(profile.id, { metadata, status: versioned })
    return { metadata, status: includeNodes ? { ...versioned, sources: fullSources } : versioned }
  }

  function state(profileId?: ProfileId, includeNodes?: true): WorkspaceState
  function state(profileId: ProfileId, includeNodes: boolean): Metadata & WorkspaceStatus
  function state(profileId?: ProfileId, includeNodes = true): Metadata & WorkspaceStatus {
    const { metadata, status } = workspaceSnapshot(profileId, includeNodes)
    return { ...metadata, ...status }
  }

  function sourceNodes(profileId: ProfileId, sourceId: string | null): SourceNodes {
    const profile = profileFor(profileId)
    const source = profile.draft.sources.find(entry => entry.id === sourceId)
    if (!source) throw new UserError('未找到该订阅源。', 404)
    const full = sourceFields(store.get(dataSpace(profile), datasetKey('source', source)), getAllSecrets())
    return { nodesVersion: full.nodesVersion, good: full.good, candidate: full.pending?.data ?? null }
  }

  function takeProbe(profiles: Map<string, Probe>, owner: string, profile: Profile, job: { key: string }) {
    const probe = profiles.get(owner + '/' + profile.id + '/' + job.key)
    return probe && probe.expires > Date.now() ? probe : null
  }

  function parseLocalInput(input: unknown, allowPartial: boolean) {
    const { format, text } = read(localInputSchema, input)
    if (!text.trim()) throw new UserError('请填写需要导入的内容。')
    const data = parseSource(Buffer.from(text), [], format)
    if (!data.nodes.length || (data.rejected.length && !allowPartial)) {
      throw new UserError(data.nodes.length ? '部分条目无法导入，请核对预览后保存。' : '没有可导入的节点，请检查输入内容。', 422,
        publicSource(data, getAllSecrets()))
    }
    return data
  }

  async function probe(profileId: ProfileId, owner: string, body: Body) {
    const profile = profileFor(profileId)
    const kind = body.kind
    if (kind !== 'source' && kind !== 'provider') throw new UserError('无法识别测试类型。')
    const entryId = read(id, body.id)
    if (kind === 'source' && body.input !== undefined) {
      return publicSource(parseLocalInput(body.input, true), getAllSecrets())
    }
    const saved = jobsFor(profile.draft).find(job => job.kind === kind && job.id === entryId)
    const cached = kind === 'provider' && body.catalogId
      ? (store.get('system', 'library') ?? defaultLibrary).providers.find(entry => entry.id === body.catalogId)
      : null
    const url = read(urlSchema, body.url || cached?.url || saved?.url || '')
    const provider = kind === 'provider'
      ? read(providerSchema, { url, behavior: body.behavior, format: body.format, minutes: body.minutes })
      : null
    const key = provider ? datasetKey('provider', { id: entryId, provider }) : datasetKey('source', { id: entryId, url })
    if (!url) throw new UserError('请先填写链接。')
    const response = await download(url, remote)
    const data = provider ? parseProvider(response.bytes, provider) : parseSource(response.bytes, response.urls)
    if ('nodes' in data && !data.nodes.length) {
      throw new UserError(data.total ? '未找到可导入节点，请检查协议或订阅格式。' : '订阅未包含节点。', 422,
        publicSource(data, getAllSecrets(data.urls)))
    }
    const expires = Date.now() + 10 * 60000
    for (const [key, value] of probes) if (value.expires < Date.now()) probes.delete(key)
    while (probes.size >= 24) probes.delete(probes.keys().next().value!)
    probes.set(owner + '/' + profile.id + '/' + key, { data, expires, subscriptionInfo: response.subscriptionInfo })
    if (!('nodes' in data)) return publicProvider(data)
    const secrets = getAllSecrets(data.urls)
    const savedData = sourceData(draftDataset(store.get(dataSpace(profile), key)))
    return {
      ...publicSource(data, secrets),
      ...(kind === 'source' && savedData ? { savedData: publicSource(savedData, secrets) } : {}),
    }
  }

  function resolveDraft(profile: Profile, input: unknown): Draft {
    const draft = read(draftSchema, input)
    const catalog = store.get('system', 'library') ?? defaultLibrary
    const catalogByService = new Map((input as Draft).services.map(service => [service.id, service.provider?.catalogId]))
    for (const source of draft.sources) {
      if (source.local) {
        source.url = ''
        source.paused = true
        continue
      }
      source.url ||= profile.draft.sources.find(item => item.id === source.id)?.url ?? ''
      if (!source.url) throw new UserError('请为订阅源填写订阅地址。')
    }
    for (const service of draft.services) {
      if (!service.provider) continue
      const fromCatalog = catalog.providers.find(item => item.id === catalogByService.get(service.id))
      service.provider.url ||= fromCatalog?.url ?? profile.draft.services.find(item => item.id === service.id)?.provider?.url ?? ''
      if (!service.provider.url) throw new UserError('请为规则集填写地址。')
    }
    return draft
  }

  function saveDraft(profileId: ProfileId, owner: string, body: Body) {
    return mutate(() => {
      const profile = profileFor(profileId)
      checkRevision(profile, body.revision)
      const draft = resolveDraft(profile, body.draft)
      const structural = structuralGroupIssues(draft)
      if (structural.size) throw new UserError([...structural.values()][0], 422, { id: [...structural.keys()][0] })
      const removedGroups = new Set(profile.draft.groups.filter(previous => !draft.groups.some(group => group.id === previous.id)).map(group => group.id))
      if (draft.services.some(service => removedGroups.has(service.target))) throw new UserError('代理组仍被路由规则使用，请先迁移引用。', 422)
      const localData = new Map<string, SourceData>()
      for (const source of draft.sources.filter(entry => entry.local)) {
        const saved = store.get(dataSpace(profile), datasetKey('source', source))?.good
        const nodes = objectValue(body.localNodes)?.[source.id]
        const input = objectValue(body.localInputs)?.[source.id]
        if (saved && !nodes && input === undefined) continue
        let imported
        if (input !== undefined) {
          imported = parseLocalInput(input, objectValue(input)?.acceptPartial === true)
        } else {
          if (!Array.isArray(nodes) || !nodes.length || nodes.length > 16000) throw new UserError('本地来源需要 1 到 16,000 个节点。')
          imported = parseSource(Buffer.from(JSON.stringify({ proxies: nodes })), [])
          if (imported.rejected.length) throw new UserError('本地节点包含无法导入的连接参数。', 422)
        }
        if (saved && compareDigest(saved.nodes) !== compareDigest(imported.nodes)) throw new UserError('替换本地节点时，请使用新的来源标识。', 409)
        localData.set(source.id, imported)
      }
      store.transaction(() => {
        for (const job of jobsFor(draft)) {
          const probe = job.local ? null : takeProbe(probes, owner, profile, job)
          const data = job.local ? localData.get(job.id) : probe?.data
          if (!data || store.get(dataSpace(profile), job.key)?.good) continue
          const at = timestamp()
          store.set(dataSpace(profile), job.key, {
            good: data, lastSuccess: at, lastAttempt: at, error: null, pending: null,
            ...(job.kind === 'source' && probe?.subscriptionInfo ? { subscriptionInfo: probe.subscriptionInfo } : {}),
          })
          rememberUrls(sourceData(data)?.urls)
          persistLog(profile, job, { outcome: 'success', trigger: job.local ? 'import' : 'probe', message: job.local ? '已导入本地节点。' : '测试成功并保存。', diff: computeDiff(null, data, job.kind) })
        }
        rememberUrls(draft.sources.map(source => source.url).filter(Boolean))
        if (compareDigest(draft) !== compareDigest(profile.draft)) {
          const onlyRenewals = profile.revision === profile.publishedRevision
            && compareDigest(publicationRecipe(profile.draft)) === compareDigest(publicationRecipe(draft))
          profile.draft = draft
          profile.revision++
          if (onlyRenewals) profile.publishedRevision = profile.revision
          store.set('profiles', profile.id, profile)
        }
      })
      return state(profile.id)
    })
  }

  function check(profileId: ProfileId) {
    const profile = profileFor(profileId)
    return compile(profile, profile.draft, true).then(result => ({ revision: profile.revision, ...result.view }))
  }

  function publish(profileId: ProfileId, revision: unknown) {
    return mutate(async () => {
      const profile = profileFor(profileId)
      checkRevision(profile, revision)
      const result = await compile(profile, profile.draft, true)
      if (!result.yaml) throw new UserError('检查未通过，当前订阅继续使用上一份成品。', 422, result.view)
      store.transaction(() => {
        for (const job of jobsFor(profile.draft).filter(job => job.enabled)) {
          const record = store.get(dataSpace(profile), job.key)
          if (record?.pending?.accepted) {
            store.set(dataSpace(profile), job.key, { ...record, lastSuccess: timestamp(), good: record.pending.data, pending: null, error: null })
          }
        }
        profile.publishedRevision = profile.revision
        if (!profile.revoked && !profile.token) profile.token = randomBytes(32).toString('base64url')
        insertVersion(profile, publicationRecipe(profile.draft), result, 'publish')
      })
      return state(profile.id)
    })
  }

  function rollback(profileId: ProfileId, seq: unknown) {
    return mutate(async () => {
      const profile = profileFor(profileId)
      const version = store.get(versionSpace(profile), versionKey(seq))
      if (!version) throw new UserError('未找到该历史版本。', 404)
      const coreIssue = await verify(version.yaml, version.view)
      if (coreIssue) throw new UserError('目标历史版本未通过校验，当前成品继续可用。', 422)
      if (configHasSubscriptionSecret(safeYaml(version.yaml), getAllSecrets())) {
        throw new UserError('该历史版本与目前已知的上游订阅凭证冲突。', 422)
      }
      store.transaction(() => {
        profile.publishedRevision = null
        insertVersion(profile, version.recipe, version, 'rollback', version.seq)
      })
      return state(profile.id)
    })
  }

  async function finishJob(profileId: string, job: Job, trigger: string, snapshot: number, data?: Dataset, failure?: string, subscriptionInfo?: SubscriptionInfo | null) {
    return mutate(async () => {
      if (snapshot !== generation) return
      const profile = store.get('profiles', profileId)
      const current = profile && plan(profile).find(entry => entry.key === job.key)
      if (!profile || !current) return
      const record = store.get(dataSpace(profile), job.key) ?? {}
      const active = activeVersion(profile)
      const sourceSample = sourceData(data)
      const diff = data ? computeDiff(record.good, data, job.kind) : null
      let message = failure
      let result: Compilation | undefined
      if (!message && job.kind === 'source' && sourceSample && diff) {
        const frozen = active?.recipe.sources.find(source => datasetKey('source', source) === job.key && source.enabled)
        const draft = profile.draft.sources.find(source => datasetKey('source', source) === job.key)
        const source = frozen ?? draft
        const counted = (dataset?: Dataset | null) => source ? filterNodes(source, sourceData(dataset)).filter(node => node.kept).length : 0
        const before = counted(record.good)
        const after = counted(data)
        if (!sourceSample.nodes.length) {
          message = sourceSample.total ? '订阅有 ' + sourceSample.total + ' 项，但没有可导入节点。' : '上游返回空节点列表。'
        } else if (record.good && (diff.after * 2 < diff.before || (before > 0 && (after === 0 || after * 2 < before)))) {
          message = '节点异常减少（可导入 ' + diff.before + ' → ' + diff.after + '，保留 ' + before + ' → ' + after + '）。请确认候选或重试。'
        }
      }
      if (data && !message && current.recipe && active && active.kind !== 'rollback') {
        result = await compile(profile, active.recipe, false, { key: job.key, data })
        if (!result.yaml) {
          message = '更新未通过配置检查。' + (result.view.issues.find(issue => issue.severity === 'error')?.message ?? '')
        }
      }
      store.transaction(() => {
        rememberUrls(sourceSample?.urls)
        if (job.kind === 'source' && (subscriptionInfo || !message)) record.subscriptionInfo = subscriptionInfo
        if (message) {
          const pending = job.kind === 'source' && sourceSample?.nodes.length && !record.pending?.accepted
            ? { accepted: false, data: sourceSample, diff, reason: message }
            : record.pending
          store.set(dataSpace(profile), job.key, {
            ...record, error: message, pending, ...(sourceSample?.rejected?.length ? { lastRejected: sourceSample.rejected } : {}),
          })
          persistLog(profile, job, { outcome: 'failed', trigger, message, diff, rejected: sourceSample?.rejected ?? [], usedOld: Boolean(record.good) })
          return
        }
        const changed = active && result?.yaml && result.yaml !== active.yaml
        if (changed && result) insertVersion(profile, active.recipe, result, 'auto', active.seq)
        store.set(dataSpace(profile), job.key, { ...record, good: data, pending: record.pending?.accepted ? record.pending : null, lastSuccess: timestamp(), error: null })
        persistLog(profile, job, {
          outcome: 'success', trigger, message: changed ? '已更新成品订阅。' : '上游数据已刷新。',
          diff, rejected: sourceSample?.rejected ?? [],
        })
      })
    })
  }

  async function runJob({ profileId, job, trigger, key, snapshot }: QueueEntry) {
    try {
      if (snapshot !== generation) return
      running.set(key, 'running')
      snapshots.delete(profileId)
      const profile = store.get('profiles', profileId)
      if (!profile || !plan(profile).some(entry => entry.key === job.key)) return
      const record = store.get(dataSpace(profile), job.key) ?? {}
      store.set(dataSpace(profile), job.key, { ...record, lastAttempt: timestamp() })
      let data
      let failure
      let subscriptionInfo
      try {
        const response = await download(job.url, remote)
        subscriptionInfo = response.subscriptionInfo
        data = parseDownload(job, response)
      } catch (error) { failure = errorMessage(error) }
      await finishJob(profileId, job, trigger, snapshot, data, failure, subscriptionInfo)
    } finally {
      if (snapshot === generation) {
        running.delete(key)
        snapshots.delete(profileId)
      }
    }
  }

  function drain() {
    while (work.size < 4 && pending.length) {
      const task = runJob(pending.shift()!)
      work.add(task)
      task.catch(() => console.error('SubMeld: an upstream task could not be committed.')).finally(() => {
        work.delete(task)
        drain()
      })
    }
  }

  function queueJob(profile: Profile, job: Job, trigger: string) {
    const key = profile.id + '/' + job.key
    if (running.has(key)) return false
    running.set(key, 'queued')
    snapshots.delete(profile.id)
    pending.push({ profileId: profile.id, job, key, trigger, snapshot: generation })
    return true
  }

  function tick() {
    const now = timestamp()
    for (const [, profile] of store.list('profiles')) {
      for (const job of plan(profile).filter(job => job.enabled && !job.paused)) {
        const record = store.get(dataSpace(profile), job.key)
        const next = nextAttempt(record, job.minutes)
        if (!next || next <= now) queueJob(profile, job, 'schedule')
      }
    }
    drain()
  }
  const timer = tickMs > 0 ? setInterval(() => {
    try { tick() } catch { console.error('SubMeld: scheduler could not read its work queue.') }
  }, tickMs).unref() : null

  return {
    state, status: (profileId?: ProfileId) => workspaceSnapshot(profileId).status, sourceNodes,
    sourceAddress(profileId: ProfileId, sourceId: string | null) {
      const source = profileFor(profileId).draft.sources.find(entry => entry.id === sourceId && !entry.local)
      if (!source) throw new UserError('未找到该订阅源。', 404)
      return { url: source.url }
    },
    probe, saveDraft, check, publish, rollback, tick, profileFor, activeVersion,
    claimRenewalReminders(profileId: ProfileId, body: Body) {
      const timeZone = read(z.string().min(1).max(100), body.timeZone)
      const requested = new Set(read(z.array(z.string().max(75)).max(200), body.dates))
      let format
      try { format = calendarFormatter(timeZone) } catch { throw new UserError('无法识别当前时区。') }
      return mutate(() => {
        const profile = profileFor(profileId)
        const records = workspaceSnapshot(profile.id).status.sources
        const upcoming = upcomingRenewals(profile.draft.sources, records, format).filter(item => requested.has(reminderKey(item)))
        // Keep recent dates across edits and across devices on opposite sides of midnight.
        const cutoff = format.format(Date.now() - 2 * 86400000)
        const seen = (profile.renewalNotices ?? []).filter(item => item.date >= cutoff)
        const fresh = upcoming.filter(({ id, date, expire }) => !seen.some(item => item.id === id
          && (item.date === date || (expire != null && item.expire === expire))))
        if (fresh.length) {
          profile.renewalNotices = seen.concat(fresh.map(({ id, date, expire }) => ({ id, date, expire })))
          store.set('profiles', profile.id, profile)
        }
        return fresh.map(({ id, date }) => ({ id, date }))
      })
    },
    async stop() {
      if (timer) clearInterval(timer)
      pending.length = 0
      await Promise.allSettled([...work])
      await serialization
    },
    async refresh(profileId: ProfileId, body: Body) {
      const profile = profileFor(profileId)
      const kind = body.kind === 'provider' ? 'provider' : 'source'
      const jobs = plan(profile).filter(job => job.kind === kind && !job.local && (body.id ? body.id === job.id : job.enabled))
      if (!jobs.length) throw new UserError('没有可刷新的订阅。', 404)
      const count = jobs.filter(job => queueJob(profile, job, 'manual')).length
      drain()
      return { queued: count }
    },
    candidate(profileId: ProfileId, sourceId: unknown, accept: boolean) {
      return mutate(() => {
        const profile = profileFor(profileId)
        const entry = profile.draft.sources.find(source => source.id === sourceId)
        if (!entry) throw new UserError('未找到该订阅源。', 404)
        const key = datasetKey('source', entry)
        const record = store.get(dataSpace(profile), key)
        if (!record?.pending) throw new UserError('该订阅源当前没有候选结果。', 404)
        record.pending.accepted = accept
        profile.revision++
        store.transaction(() => {
          store.set(dataSpace(profile), key, record)
          store.set('profiles', profile.id, profile)
        })
        return state(profile.id)
      })
    },
    async match(profileId: ProfileId, owner: string, body: Body) {
      const profile = profileFor(profileId)
      const draft = body.draft ? resolveDraft(profile, body.draft) : profile.draft
      const input = String(body.domain ?? '').slice(0, 2048)
      const { nodes, providers } = dataFor(profile, draft, true, null, owner)
      const projection = evaluate(draft, nodes, providers)
      return redact({
        ...(body.draft && !input.trim() ? { checkedOnly: true } : await matchDomain(projection, input, providers, draft.base.mode)),
        issues: projection.issues.filter(issue => issue.pane === 'rules' && (!body.serviceId || issue.id === body.serviceId)).slice(0, 10),
      }, getAllSecrets(draft.sources.map(source => source.url)))
    },
    providerContent(profileId: ProfileId, serviceId: string | null, offset: number, query: string) {
      const profile = profileFor(profileId)
      const service = profile.draft.services.find(service => service.id === serviceId && service.provider)
      if (!service) throw new UserError('没有找到已保存的规则集。', 404)
      const record = store.get(dataSpace(profile), datasetKey('provider', service))
      if (!record?.good) throw new UserError('规则集尚无有效内容，请先测试或刷新。', 404)
      const payload = record.good.payload.filter(line => line.toLowerCase().includes(query.toLowerCase()))
      return { total: payload.length, entries: redact(payload.slice(offset, offset + 50), getAllSecrets()), at: record.lastSuccess }
    },
    current(profileId: ProfileId) {
      const profile = profileFor(profileId)
      return activeVersion(profile)?.view ?? null
    },
    history(profileId: ProfileId, offset: number) {
      return store.history(versionSpace(profileFor(profileId)), 31, offset)
    },
    logs(profileId: ProfileId, offset: number) {
      return redact(store.list(logSpace(profileFor(profileId)), 51, offset).map(([, log]) => log), getAllSecrets())
    },
    readLogs(profileId: ProfileId) {
      return mutate(() => {
        const profile = profileFor(profileId)
        profile.readThrough = timestamp()
        store.set('profiles', profile.id, profile)
        return { ok: true }
      })
    },
    link(profileId: ProfileId, action?: string) {
      return mutate(() => {
        const profile = profileFor(profileId)
        if (action === 'rotate') {
          profile.token = randomBytes(32).toString('base64url')
          profile.revoked = false
          store.set('profiles', profile.id, profile)
        } else if (action === 'revoke') {
          profile.token = null
          profile.revoked = true
          store.set('profiles', profile.id, profile)
        }
        return { token: profile.token, active: Boolean(profile.active), revoked: profile.revoked }
      })
    },
    subscription(token: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
      const profile = store.list('profiles').find(([, entry]) => entry.token === token)?.[1]
      return profile && activeVersion(profile)?.yaml
    },
    note(profileId: ProfileId, body: Body) {
      return mutate(() => {
        const profile = profileFor(profileId)
        const sourceId = read(id, body.sourceId)
        const nodeId = read(id, body.nodeId)
        const note = read(nodeNote, body)
        store.set(noteSpace(profile), sourceId + '/' + nodeId, note)
        return { ok: true }
      })
    },
    library(profileId: ProfileId, input: unknown) {
      return mutate(() => {
        const saved = store.get('system', 'library') ?? defaultLibrary
        const library = read(librarySchema, input)
        library.providers = library.providers.map(entry => ({ ...entry, url: entry.url || saved.providers.find(item => item.id === entry.id)?.url || '' }))
        if (library.providers.some(entry => !entry.url)) throw new UserError('请为目录中的规则集填写地址。')
        store.set('system', 'library', library)
        return state(profileId)
      })
    },
    profiles(profileId: ProfileId, input: Body) {
      return mutate(() => {
        const profile = profileFor(profileId)
        const title = () => read(z.string().trim().min(1).max(64), input.title)
        if (input.action === 'rename') {
          profile.title = title()
          store.set('profiles', profile.id, profile)
          return state(profile.id)
        }
        if (input.action === 'delete') {
          const other = store.list('profiles').find(([key]) => key !== profile.id)
          if (!other) throw new UserError('应至少保留一个配置方案。')
          store.transaction(() => {
            store.remove('profiles', profile.id)
            for (const space of [dataSpace(profile), versionSpace(profile), logSpace(profile), noteSpace(profile)]) store.clear(space)
          })
          return state(other[0])
        }
        if (input.action !== 'create' && input.action !== 'clone') throw new UserError('未知的方案操作。')
        if (store.list('profiles').length >= 30) throw new UserError('最多可保存 30 个独立配置方案。')
        const next = makeProfile(title(), input.action === 'clone' ? profile.draft : blankDraft())
        store.transaction(() => {
          store.set('profiles', next.id, next)
          if (input.action === 'clone') {
            for (const job of jobsFor(next.draft)) {
              const data = store.get(dataSpace(profile), job.key)
              if (data) store.set(dataSpace(next), job.key, data)
            }
            for (const [key, note] of store.list(noteSpace(profile))) store.set(noteSpace(next), key, note)
          }
        })
        return state(next.id)
      })
    },
    sourceExport(profileId: ProfileId) {
      const profile = profileFor(profileId)
      const sources = profile.draft.sources
      const localNodes = Object.fromEntries(sources.filter(source => source.local).map(source => {
        const data = draftDataset(store.get(dataSpace(profile), datasetKey('source', source)))
        if (!data?.nodes.length) throw new UserError('本地来源缺少已保存的节点。', 422)
        return [source.id, data.nodes.map(node => ({ ...node.connection, name: node.name }))]
      }))
      return { version: 1, sources, ...(Object.keys(localNodes).length ? { localNodes } : {}) }
    },
    async sourceImport(profileId: ProfileId, owner: string, body: Body) {
      const profile = profileFor(profileId)
      const originals = read(z.array(sourceSchema).max(200), body.sources)
      const sources = originals.map(source => ({ ...source, id: randomUUID() }))
      if (sources.some(source => !source.local && !source.url)) throw new UserError('文件中的订阅源缺少有效订阅地址。')
      const localNodes = Object.fromEntries(sources.flatMap((source, i) => source.local ? [[source.id, objectValue(body.localNodes)?.[originals[i].id]]] : []))
      return saveDraft(profileId, owner, { revision: body.revision, localNodes, draft: { ...profile.draft, sources: [...profile.draft.sources, ...sources] } })
    },
    replaceDocuments(documents: DocumentRow[]) {
      return mutate(() => {
        generation++
        running.clear()
        pending.length = 0
        probes.clear()
        store.transaction(() => {
          for (const [space, key] of store.all()) if (space !== 'auth') store.remove(space, key)
          for (const [space, key, value] of documents) store.set(space, key, value)
        })
        return state()
      })
    },
  }
}
