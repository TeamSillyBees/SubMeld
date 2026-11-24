import type { FilteredNode, GroupMember, Pool } from './model.ts'
import { compareQuality, platformSurfaces, qualityValue, type NodeQuality, type QualitySnapshot } from './quality-snapshot.ts'
import { isSubscriptionNotice } from './quality-options.ts'
import { RE2JS } from 're2js'

export const maxPatternLength = 256

// Older drafts and published plans store one source ID, or '' for all sources.
export function memberSourceIds(member: GroupMember | Partial<Pool>) {
  return ('sourceIds' in member ? member.sourceIds : undefined) ?? ('sourceId' in member && member.sourceId ? [member.sourceId] : [])
}

export function poolCondition(member: Partial<Pool> = {}) {
  return {
    kind: 'pool' as const,
    sourceIds: [...new Set(memberSourceIds(member))].sort(),
    regions: [...new Set(member.regions ?? [])].sort(),
    includeRegex: member.includeRegex ?? '',
    excludeRegex: member.excludeRegex ?? '',
    ...(member.quality && { quality: member.quality }),
    ...(member.search && { search: member.search }), ...(member.noteMatches && { noteMatches: member.noteMatches }),
    ...(member.nodeKeys && { nodeKeys: member.nodeKeys }),
  }
}

export function compilePoolPattern(pattern?: string): { regex?: RE2JS; error?: string } {
  if (!pattern) return {}
  if (pattern.length > maxPatternLength) return { error: '表达式最多 ' + maxPatternLength + ' 个字符。' }
  try {
    return { regex: RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE) }
  } catch (error) {
    if (error instanceof Error && error.message.includes('missing closing ]')) return { error: '字符组缺少右方括号 ]。' }
    if (error instanceof Error && error.message.includes('missing closing )')) return { error: '分组缺少右括号 )。' }
    return { error: '表达式不符合 RE2 语法，请检查分组、转义和重复符号。' }
  }
}

export function compilePoolFilter(member: Pool) {
  const sources = new Set(memberSourceIds(member))
  const regions = new Set(member.regions)
  const include = compilePoolPattern(member.includeRegex)
  const exclude = compilePoolPattern(member.excludeRegex)
  const keys = member.nodeKeys && new Set(member.nodeKeys)
  const noteMatches = new Set(member.noteMatches)
  const query = member.search?.toLowerCase().trim()
  return {
    includeError: include.error,
    excludeError: exclude.error,
    matches: (node: Pick<FilteredNode, 'kept' | 'sourceId' | 'region' | 'name'> & Partial<Pick<FilteredNode, 'key' | 'originalName'>>) => node.kept && !include.error && !exclude.error
      && (!sources.size || sources.has(node.sourceId))
      && (!regions.size || regions.has(node.region))
      && (!keys || !!node.key && keys.has(node.key))
      && (!query || node.name.toLowerCase().includes(query) || node.originalName?.toLowerCase().includes(query) || !!node.key && noteMatches.has(node.key))
      && (!include.regex || include.regex.test(node.name))
      && (!exclude.regex || !exclude.regex.test(node.name)),
  }
}

export type QualityCondition = NonNullable<Pool['quality']>
export const qualityPresets: Record<string, { name: string; condition: QualityCondition }> = {
  alive: { name: '可用节点', condition: { alive: true } },
  lowLatency: { name: '低延迟', condition: { alive: true, maxLatencyMs: 250, maxLossRate: 0.1 } },
  streaming: { name: '流畅视频', condition: { alive: true, minBandwidthMbps: 20, maxLossRate: 0.05 } },
  ai: { name: 'AI 网页', condition: { alive: true, maxLossRate: 0.3, platforms: ['chatgptWeb', 'gemini', 'claudeWeb', 'grok'] } },
}
export function skippedMetrics(q: QualityCondition, config?: QualitySnapshot['config']) {
  return {
    bandwidth: config?.bandwidth === false && q.minBandwidthMbps != null,
    ai: config?.ai === false && Boolean(q.platforms?.length || q.aiPlatforms?.length),
  }
}
export function qualityReason(q: QualityCondition, r?: NodeQuality, config?: QualitySnapshot['config'], allowChallenge = false) {
  const bandwidth = config?.bandwidth === false ? undefined : q.minBandwidthMbps
  const surfaces = config?.ai === false ? undefined : q.platforms
  const platforms = config?.ai === false ? undefined : q.aiPlatforms
  const hasCriteria = q.alive || q.maxLatencyMs != null || q.maxLossRate != null || q.maxJitterMs != null || bandwidth != null || surfaces?.length || platforms?.length || q.exitRegions?.length
  if (!r) return hasCriteria ? 'untested' : null
  if (!r.available && hasCriteria) return 'unavailable'
  if (q.maxLatencyMs != null && r.httpsMs != null && r.httpsMs > q.maxLatencyMs) return 'latency'
  if (q.maxLossRate != null && r.lossRate != null && r.lossRate > q.maxLossRate) return 'loss'
  if (q.maxJitterMs != null && r.jitterMs != null && r.jitterMs > q.maxJitterMs) return 'jitter'
  if (bandwidth != null && (r.speedFailed || r.speedMbps != null && r.speedMbps < bandwidth)) return 'bandwidth'
  if (q.exitRegions?.length && r.exitRegion && q.exitRegions.includes(r.exitRegion) === !!q.excludeExitRegions) return 'region'
  if (surfaces?.length && r.reachable && surfaces.some(s => !r.reachable!.includes(s) && !(allowChallenge && r.surfaceIssues?.[s] === 'degraded_challenge'))) return 'platform'
  const levels = platforms?.map(p => qualityValue(r, p)) ?? []
  if (levels.some(level => level !== null && level < (q.minUnlockLevel ?? 2))) return 'platform'
  if (platforms?.some(p => platformSurfaces[p].some(s => r.surfaceIssues?.[s] === 'region_restricted'))) return 'platform'
  if (q.maxLatencyMs != null && r.httpsMs == null || q.maxLossRate != null && r.lossRate == null ||
      q.maxJitterMs != null && r.jitterMs == null || bandwidth != null && r.speedMbps == null ||
      q.exitRegions?.length && !r.exitRegion || surfaces?.length && !r.reachable || levels.includes(null)) return 'untested'
  return null
}
export const funnelStages = ['source', 'name', 'performance', 'regionAi', 'limit'] as const
export type FunnelStage = typeof funnelStages[number]
export function resolvePool<T extends Pick<FilteredNode, 'key' | 'kept' | 'sourceId' | 'name' | 'region'>>(member: Pool, nodes: T[], snapshot: QualitySnapshot | null) {
  const filter = compilePoolFilter(member)
  const sources = new Set(memberSourceIds(member))
  const sourceNodes = nodes.filter(n => !sources.size || sources.has(n.sourceId))
  const removed: { node: T; reason: string; stage: FunnelStage }[] = []
  const candidates = sourceNodes.filter(node => {
    if (filter.matches(node)) return true
    if (member.quality) {
      const reason = !node.kept ? 'source' : member.regions.length && !member.regions.includes(node.region) ? 'nameRegion' : 'name'
      removed.push({ node, reason, stage: 'name' })
    }
    return false
  })
  const reasons: Record<string, number> = {}
  const untested: string[] = []
  const quality = member.quality
  const passed = quality ? candidates.filter(node => {
    const reason = qualityReason(quality, snapshot?.rows[node.key], snapshot?.config)
    if (reason === 'untested') {
      untested.push(node.key)
      if (quality.untestedPolicy === 'include') return true
    }
    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1
      const missingPlatformOrRegion = reason === 'untested' && snapshot?.rows[node.key] &&
        !qualityReason({ ...quality, exitRegions: [], platforms: [], aiPlatforms: [] }, snapshot.rows[node.key], snapshot.config)
      removed.push({ node, reason, stage: reason === 'region' || reason === 'platform' || missingPlatformOrRegion ? 'regionAi' : 'performance' })
    }
    return !reason
  }) : candidates
  const emptied = Boolean(quality && candidates.length && !passed.length)
  let selected = passed
  let relaxation: 'latency' | 'challenge' | null = null
  if (emptied && quality?.relaxWhenEmpty) {
    const withoutLatency = { ...quality, maxLatencyMs: undefined }
    const match = (condition: QualityCondition, allowChallenge: boolean) => candidates.filter(node => {
      const reason = qualityReason(condition, snapshot?.rows[node.key], snapshot?.config, allowChallenge)
      return !reason || reason === 'untested' && quality.untestedPolicy === 'include'
    })
    if (quality.maxLatencyMs != null) {
      selected = match(withoutLatency, false)
      if (selected.length) relaxation = 'latency'
    }
    if (!selected.length && (quality.platforms?.length || quality.aiPlatforms?.length)) {
      selected = match({ ...withoutLatency, minUnlockLevel: 1 }, true)
      if (selected.length) relaxation = 'challenge'
    }
  }
  const relaxed = relaxation !== null
  const fallback = emptied && !relaxed && !!quality?.fallbackWhenEmpty
  if (fallback) selected = candidates
  if (quality?.sortBy) {
    const sort = quality.sortBy
    selected = [...selected].sort((a, b) => compareQuality(snapshot?.rows[a.key], snapshot?.rows[b.key], sort,
      quality.sortReverse, isSubscriptionNotice(a.name), isSubscriptionNotice(b.name)))
  }
  const matches = quality?.topN ? selected.slice(0, quality.topN) : selected
  for (const node of selected.slice(matches.length)) removed.push({ node, reason: 'limit', stage: 'limit' })
  const stageCounts = { source: sourceNodes.length, name: candidates.length,
    performance: candidates.length - removed.filter(r => r.stage === 'performance').length, regionAi: passed.length, limit: matches.length }
  return { ...filter, matches, sourceNodes, candidates, passed, reasons, removed, untested, emptied, fallback, relaxed, relaxation, stageCounts }
}

// An explicitly scoped pool loses missing sources. Losing its last source
// removes the condition, since an empty source selection would match all.
export function membersForSources(members: GroupMember[], availableIds: Set<string>): GroupMember[] {
  return members.flatMap<GroupMember>(member => {
    if (member.kind === 'node') return availableIds.has(member.sourceId) ? [member] : []
    if (member.kind !== 'pool') return [member]
    const ids = memberSourceIds(member)
    const remaining = ids.filter(id => availableIds.has(id))
    if (remaining.length === ids.length) return [member]
    return remaining.length ? [poolCondition({ ...member, sourceIds: remaining })] : []
  })
}
