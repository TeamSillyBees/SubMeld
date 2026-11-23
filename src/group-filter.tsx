import type { Pool, Source, NodeView } from '../shared/model.ts'
import { useMemo, useState } from 'react'
import { ChevronDown, Filter, Plus } from 'lucide-react'
import { regions } from '../shared/catalog.ts'
import { resolvePool, poolCondition } from '../shared/group-filter.ts'
import { QualityControl } from './quality.tsx'
import { useProject } from './project.tsx'
import { PoolQuality, reasonNames } from './pool-quality.tsx'
import { maxQualityNodes } from '../shared/quality-options.ts'
import { Button, CheckOption, Field, FieldLegend, FieldSet, Input, Pager, formatNumber, usePage } from './ui.tsx'

const commonRegions = new Set(['US', 'HK', 'JP', 'SG', 'TW', 'KR', 'GB', 'DE', 'FR', 'CA', 'AU', 'unknown'])
const toggleValue = (items: string[], id: string) => items.includes(id) ? items.filter(item => item !== id) : [...items, id]

export function GroupFilter({ member, index, sources, nodes, onChange, onNew, headingRef }: { member?: Pool | null; index: number; sources: Source[]; nodes: NodeView[]; onChange: (pool: Pool) => void; onNew: () => void; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const value = useMemo(() => poolCondition(member ?? {}), [member])
  const { quality } = useProject()
  const filter = useMemo(() => resolvePool(value, nodes, quality.snapshot), [value, nodes, quality.snapshot])
  const { matches } = filter
  const [moreRegions, setMoreRegions] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [offset, setOffset] = usePage(matches.length, 20)
  const visibleRegions = regions.filter(([id]) => moreRegions || commonRegions.has(id) || value.regions.includes(id))
  const invalid = Boolean(filter.includeError || filter.excludeError)
  const awaitingQuality = !!value.quality && !quality.ready
  function change<K extends keyof Pool>(key: K, next: Pool[K]) {
    setOffset(0)
    onChange({ ...value, [key]: next })
  }
  return <section className="group-filter">
    <div className="filter-editor-heading">
      <h3 ref={headingRef} tabIndex={-1}><Filter aria-hidden="true" />{member ? '动态筛选 · 列表第 ' + (index + 1) + ' 项' : '新建动态筛选'}</h3>
      {member && <Button size="small" icon={Plus} variant="ghost" onClick={() => { setOffset(0); setExpanded(false); onNew() }}>另加一条筛选</Button>}
    </div>
    <p className="field-note muted">{member ? '订阅更新时，同时匹配来源、地区和名称的节点会加入本组。' : '选择来源、地区或填写正则，即可预览匹配的节点。'}</p>
    <div className="group-filter-columns">
      <FieldSet className="pool-sources"><FieldLegend variant="label">订阅源</FieldLegend>
        {sources.length ? <div className="pool-source-list">{sources.map(source => <CheckOption key={source.id} label={source.name}
          checked={value.sourceIds.includes(source.id)} onCheckedChange={() => change('sourceIds', toggleValue(value.sourceIds, source.id))} />)}</div>
          : <p className="field-note muted">暂无订阅源</p>}
        <p className="field-note muted">留空匹配全部来源</p>
      </FieldSet>
      <FieldSet><FieldLegend variant="label">地区</FieldLegend>
        <div className="pool-region-list">{visibleRegions.map(([id, label]) =>
          <button type="button" key={id} aria-pressed={value.regions.includes(id)} onClick={() => change('regions', toggleValue(value.regions, id))}>
            {id !== 'unknown' && <code>{id}</code>}{label}
          </button>)}</div>
        <div className="pool-region-footer"><span className="field-note muted">留空匹配全部地区</span>
          <Button size="small" variant="ghost" icon={ChevronDown} aria-expanded={moreRegions} onClick={() => setMoreRegions(!moreRegions)}>{moreRegions ? '收起地区' : '更多地区'}</Button></div>
      </FieldSet>
      <div className="pool-patterns">
        <Field label="包含正则（可选）" error={filter.includeError}><Input spellCheck={false}
          value={value.includeRegex} placeholder="例如 IEPL|专线|家宽" onChange={event => change('includeRegex', event.target.value)} /></Field>
        <Field label="排除正则（可选）" error={filter.excludeError}><Input spellCheck={false}
          value={value.excludeRegex} placeholder="例如 测试|过期" onChange={event => change('excludeRegex', event.target.value)} /></Field>
        <p className="field-note muted">按节点名（含前缀）匹配，命中排除正则时跳过。使用 RE2 语法，默认忽略大小写。</p>
      </div>
    </div>
    {(value.search || value.nodeKeys || value.noteMatches?.length) && <p className="field-note">来自节点列表{value.search && ' · 搜索「' + value.search + '」'}{value.nodeKeys && ' · 已限定 ' + value.nodeKeys.length + ' 个节点'}{!!value.noteMatches?.length && ' · 含 ' + value.noteMatches.length + ' 个备注匹配'}</p>}
    <PoolQuality value={value.quality} change={next => change('quality', next)} />
    {awaitingQuality ? <p className="field-note muted" role="status">{quality.error ? '重新读取报告后可预览质量条件。' : '正在读取质量报告…'}</p> : <div className="pool-preview">
      {value.quality && <div className="quality-funnel"><p>基础候选 <strong>{filter.candidates.length}</strong> → 通过质量条件 <strong>{filter.passed.length}</strong>{filter.fallback && ' → 兜底恢复 ' + matches.length + ' 个节点'}</p>
        {!!Object.keys(filter.reasons).length && <p className="field-note muted">{Object.entries(filter.reasons).map(([reason, n]) => reasonNames[reason] + ' ' + n).join(' · ')}</p>}
        {!!filter.untested.length && <QualityControl selected={filter.untested.slice(0, maxQualityNodes)} filtered={filter.untested.slice(0, maxQualityNodes)} supplement bandwidth={value.quality.minBandwidthMbps != null} />}
      </div>}
      <div className="between flex-wrap"><strong role="status">{invalid ? '请修正正则后查看预览' : '匹配 ' + formatNumber(matches.length) + ' 个保留节点'}</strong>
        <div className="actions">{matches.length > 3 && <Button size="small" variant="ghost" aria-expanded={expanded} onClick={() => { setOffset(0); setExpanded(!expanded) }}>{expanded ? '收起预览' : '查看全部匹配'}</Button>}
          {!member && <Button size="small" icon={Plus} onClick={() => onChange(value)}>加入全部保留节点</Button>}</div></div>
      {!invalid && (matches.length ? <ul className="pool-sample">{(expanded ? matches.slice(offset, offset + 20) : matches.slice(0, 3)).map(node =>
        <li key={node.key} title={node.sourceName + ' · ' + node.name}>{node.name}</li>)}</ul> : <p className="field-note muted">当前没有匹配节点，可调整条件或等待来源更新。</p>)}
      {expanded && matches.length > 20 && <Pager offset={offset} count={matches.length} pageSize={20} onChange={setOffset} />}
    </div>}
  </section>
}
