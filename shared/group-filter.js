import { RE2JS } from 're2js'

export const maxPatternLength = 256

// Older drafts and published plans store one source ID, or '' for all sources.
export function memberSourceIds(member) {
  return member.sourceIds ?? (member.sourceId ? [member.sourceId] : [])
}

export function poolCondition(member = {}) {
  return {
    kind: 'pool',
    sourceIds: [...new Set(memberSourceIds(member))].sort(),
    regions: [...new Set(member.regions ?? [])].sort(),
    includeRegex: member.includeRegex ?? '',
    excludeRegex: member.excludeRegex ?? '',
  }
}

export function compilePoolPattern(pattern) {
  if (!pattern) return {}
  if (pattern.length > maxPatternLength) return { error: '表达式最多 ' + maxPatternLength + ' 个字符。' }
  try {
    return { regex: RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE) }
  } catch (error) {
    if (error.message.includes('missing closing ]')) return { error: '字符组缺少右方括号 ]。' }
    if (error.message.includes('missing closing )')) return { error: '分组缺少右括号 )。' }
    return { error: '表达式不符合 RE2 语法，请检查分组、转义和重复符号。' }
  }
}

export function compilePoolFilter(member) {
  const sources = new Set(memberSourceIds(member))
  const regions = new Set(member.regions)
  const include = compilePoolPattern(member.includeRegex)
  const exclude = compilePoolPattern(member.excludeRegex)
  return {
    includeError: include.error,
    excludeError: exclude.error,
    matches: node => node.kept && !include.error && !exclude.error
      && (!sources.size || sources.has(node.sourceId))
      && (!regions.size || regions.has(node.region))
      && (!include.regex || include.regex.test(node.name))
      && (!exclude.regex || !exclude.regex.test(node.name)),
  }
}

// An explicitly scoped pool loses missing sources. Losing its last source
// removes the condition, since an empty source selection would match all.
export function membersForSources(members, availableIds) {
  return members.flatMap(member => {
    if (member.kind === 'node') return availableIds.has(member.sourceId) ? [member] : []
    if (member.kind !== 'pool') return [member]
    const ids = memberSourceIds(member)
    const remaining = ids.filter(id => availableIds.has(id))
    if (remaining.length === ids.length) return [member]
    return remaining.length ? [poolCondition({ ...member, sourceIds: remaining })] : []
  })
}
