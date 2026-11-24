import type { Pool, Source, NodeView } from '../shared/model.ts'
import { useMemo, useState } from 'react'
import { ChevronDown, Filter, Plus } from 'lucide-react'
import { regionLabel, regions } from '../shared/catalog.ts'
import { funnelStages, resolvePool, poolCondition, type FunnelStage } from '../shared/group-filter.ts'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { QualityControl } from './quality.tsx'
import { useProject } from './project.tsx'
import { PoolQuality, reasonNames } from './pool-quality.tsx'
import { maxQualityNodes, surfaceNames } from '../shared/quality-options.ts'
import { platformSurfaces, verdictFor, verdictLabels, verdictScores, type NodeQuality } from '../shared/quality-snapshot.ts'
import { stateLabels } from './node-quality.tsx'
import { Button, CheckOption, Field, FieldLegend, FieldSet, Input, Pager, formatNumber, usePage } from './ui.tsx'

const commonRegions = new Set(['US', 'HK', 'JP', 'SG', 'TW', 'KR', 'GB', 'DE', 'FR', 'CA', 'AU', 'unknown'])
const toggleValue = (items: string[], id: string) => items.includes(id) ? items.filter(item => item !== id) : [...items, id]
const stageNames: Record<FunnelStage, string> = { source: '来源节点', name: '基础匹配', performance: '连接质量', regionAi: '地区与 AI', limit: '最终输出' }

function removalDetail(reason: string, node: NodeView, row: NodeQuality | undefined, q: Pool['quality'], aiEnabled: boolean) {
  if (reason === 'source') return node.reasons.join('、')
  if (reason === 'nameRegion') return regionLabel(node.region)
  if (!row) return ''
  if (reason === 'jitter') return row.jitterMs + ' ms'
  if (reason === 'latency') return row.httpsMs + ' ms'
  if (reason === 'loss' && row.lossRate != null) return Math.round(row.lossRate * 100) + '%'
  if (reason === 'bandwidth') return row.speedMbps != null ? row.speedMbps.toFixed(1) + ' Mbps' : '测速失败'
  if (reason !== 'region' && reason !== 'platform') return ''
  const details = reason === 'region' && row.exitRegion ? [(row.exitRegionInferred ? '推定出口 ' : '实测出口 ') + row.exitRegion] : []
  if (aiEnabled && q) {
    const entries = new Set(q.platforms)
    for (const platform of q.aiPlatforms ?? []) {
      const verdict = verdictFor(row, platform)
      const failed = platformSurfaces[platform].filter(s => row.surfaceIssues?.[s])
      if (!verdict || verdictScores[verdict] < (q.minUnlockLevel ?? 2) || failed.some(s => row.surfaceIssues?.[s] === 'region_restricted')) {
        if (failed.length) failed.forEach(s => entries.add(s))
        else if (verdict) details.push(platform + ' ' + verdictLabels[verdict])
      }
    }
    for (const s of entries) if (!row.reachable?.includes(s)) {
      const issue = row.surfaceIssues?.[s]
      details.push(surfaceNames[s] + ' ' + (issue ? stateLabels[issue] : '未确认可达'))
    }
  }
  return details.join('、')
}

export function GroupFilter({ member, index, sources, nodes, onChange, onNew, headingRef }: { member?: Pool | null; index: number; sources: Source[]; nodes: NodeView[]; onChange: (pool: Pool) => void; onNew: () => void; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const value = useMemo(() => poolCondition(member ?? {}), [member])
  const { quality } = useProject()
  const filter = useMemo(() => resolvePool(value, nodes, quality.snapshot), [value, nodes, quality.snapshot])
  const { matches } = filter
  const readings = useMemo(() => filter.sourceNodes.flatMap(n => quality.snapshot?.rows[n.key] ?? []), [filter, quality.snapshot])
  const [stage, setStage] = useState<FunnelStage | null>(null)
  const removed = useMemo(() => filter.removed.filter(r => r.stage === stage).sort((a, b) => a.reason.localeCompare(b.reason)), [filter, stage])
  const [reasonOffset, setReasonOffset] = usePage(removed.length, 30)
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
    <PoolQuality value={value.quality} markedRegions={value.regions} readings={readings} change={(next, useMeasuredRegions) => {
      setOffset(0)
      onChange({ ...value, regions: useMeasuredRegions ? [] : value.regions, quality: next })
    }} />
    {awaitingQuality ? <p className="field-note muted" role="status">{quality.error ? '重新读取报告后可预览质量条件。' : '正在读取质量报告…'}</p> : <div className="pool-preview">
      {value.quality && <div className="quality-funnel"><div className="funnel-stages" role="group" aria-label="筛选各阶段节点数">{funnelStages.map(key => {
        const count = filter.stageCounts[key]
        const details = filter.removed.some(r => r.stage === key)
        return <button key={key} type="button" disabled={!details} aria-label={stageNames[key] + ' ' + count + (details ? '，查看淘汰原因' : '')}
          onClick={() => { setStage(key); setReasonOffset(0) }}><span>{stageNames[key]}</span><strong>{count}</strong>
          <progress aria-hidden="true" max={Math.max(filter.stageCounts.source, 1)} value={count} /></button>
      })}</div>{filter.fallback && <p>兜底恢复 {matches.length} 个节点</p>}{filter.relaxed && <p>{filter.relaxation === 'latency' ? '取消延迟上限' : '允许浏览器验证'}后保留 {matches.length} 个节点</p>}
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
    <Sheet open={!!stage} onOpenChange={open => { if (!open) setStage(null) }}><SheetContent className="quality-removals">
      <SheetHeader><SheetTitle>{stage && stageNames[stage]}的淘汰原因</SheetTitle><SheetDescription>该阶段筛除 {removed.length} 个节点</SheetDescription></SheetHeader>
      <ul>{removed.slice(reasonOffset, reasonOffset + 30).map(({ node, reason }) => {
        const measured = removalDetail(reason, node, quality.snapshot?.rows[node.key], value.quality, quality.snapshot?.config?.ai !== false)
        return <li key={node.key}><strong>{node.name}</strong><small>{reasonNames[reason]}{measured && ' · ' + measured}</small></li>
      })}</ul>
      {removed.length > 30 && <Pager offset={reasonOffset} count={removed.length} pageSize={30} onChange={setReasonOffset} />}
    </SheetContent></Sheet>
  </section>
}
