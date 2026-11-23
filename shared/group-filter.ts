import type { FilteredNode, GroupMember, Pool } from './model.ts'
import type { NodeQuality, QualitySnapshot } from './quality-snapshot.ts'
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
  ai: { name: 'AI 网页', condition: { platforms: ['chatgptWeb', 'gemini', 'claudeWeb', 'grok'] } },
}
export function qualityReason(q: QualityCondition, r?: NodeQuality) {
  if (!r) return 'untested'
  if (!r.available && (q.alive || q.maxLatencyMs != null || q.maxLossRate != null || q.minBandwidthMbps != null || q.platforms?.length)) return 'unavailable'
  if (q.maxLatencyMs != null && r.httpsMs !== null && r.httpsMs > q.maxLatencyMs) return 'latency'
  if (q.maxLossRate != null && r.lossRate !== null && r.lossRate > q.maxLossRate) return 'loss'
  if (q.minBandwidthMbps != null && (r.speedFailed || r.speedMbps !== null && r.speedMbps < q.minBandwidthMbps)) return 'bandwidth'
  if (q.platforms?.length && r.reachable && q.platforms.some(s => !r.reachable!.includes(s))) return 'platform'
  if (q.maxLatencyMs != null && r.httpsMs === null || q.maxLossRate != null && r.lossRate === null ||
      q.minBandwidthMbps != null && r.speedMbps === null || q.platforms?.length && !r.reachable) return 'untested'
  return null
}
export function resolvePool<T extends Pick<FilteredNode, 'key' | 'kept' | 'sourceId' | 'name' | 'region'>>(member: Pool, nodes: T[], snapshot: QualitySnapshot | null) {
  const filter = compilePoolFilter(member)
  const candidates = nodes.filter(filter.matches)
  const reasons: Record<string, number> = {}
  const untested: string[] = []
  const quality = member.quality
  const passed = quality ? candidates.filter(node => {
    const reason = qualityReason(quality, snapshot?.rows[node.key])
    if (reason === 'untested') {
      untested.push(node.key)
      if (quality.untestedPolicy === 'include') return true
    }
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1
    return !reason
  }) : candidates
  const emptied = Boolean(quality && candidates.length && !passed.length)
  const fallback = emptied && !!quality?.fallbackWhenEmpty
  return { ...filter, matches: fallback ? candidates : passed, candidates, passed, reasons, untested, emptied, fallback }
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
