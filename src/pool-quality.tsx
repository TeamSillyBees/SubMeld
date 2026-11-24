import { useMemo, useState } from 'react'
import { regions } from '../shared/catalog.ts'
import type { QualityCondition } from '../shared/group-filter.ts'
import { platforms, qualitySorts, type NodeQuality, type QualitySort } from '../shared/quality-snapshot.ts'
import { surfaces, surfaceNames } from '../shared/quality-options.ts'
import { Button, Disclosure, Field, FieldGroup, Input, MultiSelect, NativeSelect, NativeSelectOption, Toggle } from './ui.tsx'
import { QualityBaselinePicker } from './quality-baseline.tsx'
import { qualitySortLabels, SkippedQualityNotice } from './node-quality.tsx'
import { useProject } from './project.tsx'

export const reasonNames: Record<string, string> = {
  unavailable: '节点不可用', latency: '延迟过高', jitter: '抖动过高', loss: '丢包过高', bandwidth: '带宽不足',
  platform: 'AI 入口或等级未达标', region: '出口地区不符', source: '订阅源已排除此节点', nameRegion: '标称地区不符', name: '名称或节点范围不符', limit: '超过保留名额', untested: '缺少测量',
}
type Metric = 'httpsMs' | 'jitterMs' | 'speedMbps'
const percentile = (values: number[], p: number) => values[Math.ceil(values.length * p / 100) - 1]
const display = (v: number) => Number(v.toFixed(2))

export function PoolQuality({ value, readings, markedRegions, change }: {
  value?: QualityCondition; readings: NodeQuality[]; markedRegions: string[]
  change: (value?: QualityCondition, useMeasuredRegions?: boolean) => void
}) {
  const { quality } = useProject()
  const q = value ?? {}
  const [open, setOpen] = useState(false)
  const distribution = useMemo(() => {
    const values = (key: Metric) => readings.flatMap(r => r.available && r[key] != null ? [r[key]!] : []).sort((a, b) => a - b)
    return { httpsMs: values('httpsMs'), jitterMs: values('jitterMs'), speedMbps: values('speedMbps') }
  }, [readings])
  const measured = new Set([...regions.filter(([id]) => id !== 'unknown').map(([id]) => id),
    ...readings.flatMap(r => r.exitRegion ?? []), ...(q.exitRegions ?? [])])
  const names = new Intl.DisplayNames('zh-CN', { type: 'region' })
  const options = [...measured].sort().map(id => [id, id + ' · ' + names.of(id)])
  const median = percentile(distribution.httpsMs, 50)
  const scenes: [string, QualityCondition][] = [
    ['AI 对话', { alive: true, maxLossRate: 0.3, aiPlatforms: ['ChatGPT'], minUnlockLevel: 2, exitRegions: ['CN', 'HK', 'MO', 'RU', 'BY'], excludeExitRegions: true, sortBy: 'ChatGPT', topN: 8, fallbackWhenEmpty: true }],
    ['低延迟高速', { alive: true, maxLossRate: 0.1, ...(median != null && { maxLatencyMs: display(median) }), sortBy: 'https', topN: 10 }],
    ['流媒体区域专线', { alive: true, exitRegions: markedRegions.filter(r => r !== 'unknown') }],
    ['清理死节点', { alive: true, untestedPolicy: 'include' }],
  ]
  function patch(part: Partial<QualityCondition>) { change({ ...q, ...part }) }
  function threshold(label: string, key: 'maxLatencyMs' | 'maxLossRate' | 'maxJitterMs' | 'minBandwidthMbps', max: number, metric?: Metric) {
    const scale = key === 'maxLossRate' ? 100 : 1
    const values = metric ? distribution[metric] : []
    const unit = key === 'minBandwidthMbps' ? 'Mbps' : 'ms'
    const n = q[key]
    return <div className="quality-threshold"><Field label={label}><Input type="number" min={0} max={max} step="any" placeholder="不限"
      value={n == null ? '' : display(n * scale)} onChange={e => {
        const input = e.target.valueAsNumber
        patch({ [key]: Number.isFinite(input) ? Math.max(0, Math.min(max, input)) / scale : undefined })
      }} /></Field>
      {values.length > 0 && <><input type="range" aria-label={label + '滑块'} min={0} max={Math.min(max, Math.max(values.at(-1)!, n ?? 0, 1))} step="any"
        value={n ?? (key === 'minBandwidthMbps' ? 0 : values.at(-1))} onChange={e => patch({ [key]: display(e.target.valueAsNumber) })} />
        <div className="quality-percentiles">{[25, 50, 75].map(p => {
          const v = display(percentile(values, p))
          return <Button key={p} variant="ghost" size="small" aria-label={label + ' P' + p + '，' + v + ' ' + unit} onClick={() => patch({ [key]: v })}>P{p} · {v}</Button>
        })}</div></>}
    </div>
  }
  return <div className="pool-quality">
    <div className="pool-quality-head"><strong>质量条件</strong><QualityBaselinePicker /></div>
    <div className="pool-presets" role="group" aria-label="质量筛选预设">
      <Button size="small" aria-pressed={!value} onClick={() => change(undefined)}>不限质量</Button>
      {scenes.map(([name, condition]) => <Button size="small" key={name} aria-pressed={JSON.stringify(q) === JSON.stringify(condition)} onClick={() => {
        const media = name === '流媒体区域专线'
        change(condition, media)
        if (media) setOpen(true)
      }}>{name}</Button>)}
    </div>
    {value && <p className="field-note muted">{[
      q.alive && '仅可用', q.maxLatencyMs != null && 'HTTPS ≤ ' + q.maxLatencyMs + ' ms', q.maxJitterMs != null && '抖动 ≤ ' + q.maxJitterMs + ' ms',
      q.maxLossRate != null && '丢包 ≤ ' + display(q.maxLossRate * 100) + '%', q.minBandwidthMbps != null && '带宽 ≥ ' + q.minBandwidthMbps + ' Mbps',
      q.exitRegions?.length && (q.excludeExitRegions ? '排除出口 ' : '出口 ') + q.exitRegions.join('/'),
      ...(q.platforms ?? []).map(k => surfaceNames[k]), ...(q.aiPlatforms ?? []).map(p => qualitySortLabels[p] + ' ≥ ' + (q.minUnlockLevel ?? 2) + ' 分'),
      q.sortBy && '按' + qualitySortLabels[q.sortBy] + '排序', q.topN && '前 ' + q.topN + ' 个',
    ].filter(Boolean).join(' · ') || '全部候选节点'}</p>}
    <SkippedQualityNotice condition={value} config={quality.snapshot?.config} />
    <Disclosure title="自定义阈值与兜底" open={open} onOpenChange={setOpen}><div className="quality-device">
      <Toggle label="仅保留可用节点" checked={!!q.alive} onChange={alive => patch({ alive })} />
      <FieldGroup className="form-grid">{threshold('最大 HTTPS 延迟（ms）', 'maxLatencyMs', 600000, 'httpsMs')}
        {threshold('最大抖动（ms）', 'maxJitterMs', 600000, 'jitterMs')}
        {threshold('最低带宽（Mbps）', 'minBandwidthMbps', 1000000, 'speedMbps')}{threshold('最大丢包率（%）', 'maxLossRate', 100)}</FieldGroup>
      <MultiSelect label="出口地区" options={options} values={q.exitRegions ?? []} onChange={exitRegions => patch({ exitRegions })} placeholder="不限出口地区" />
      {readings.some(r => r.exitRegionInferred) && <p className="field-note muted">部分节点的出口地区由至少四个一致的平台入口观测推定。</p>}
      {!!q.exitRegions?.length && <Toggle label="排除选中的出口地区" checked={!!q.excludeExitRegions} onChange={excludeExitRegions => patch({ excludeExitRegions })} />}
      <div><strong>AI 平台</strong><div className="pool-presets" role="group" aria-label="要求解锁的平台">{platforms.map(p => {
        const selected = q.aiPlatforms?.includes(p)
        return <Button size="small" key={p} aria-pressed={!!selected} onClick={() => patch({ aiPlatforms: selected ? q.aiPlatforms?.filter(v => v !== p) : [...(q.aiPlatforms ?? []), p] })}>{qualitySortLabels[p]}</Button>
      })}</div></div>
      {!!q.aiPlatforms?.length && <Field label="最低解锁等级"><NativeSelect value={q.minUnlockLevel ?? 2} onChange={e => patch({ minUnlockLevel: Number(e.target.value) as 1 | 2 | 3 })}>
        <NativeSelectOption value={3}>3 · 全入口可达</NativeSelectOption><NativeSelectOption value={2}>2 · 允许部分入口可达</NativeSelectOption><NativeSelectOption value={1}>1 · 允许浏览器验证</NativeSelectOption>
      </NativeSelect></Field>}
      <Disclosure compact title="指定 Web、App 或 API 入口"><div className="pool-presets" role="group" aria-label="必须可达的平台入口">{surfaces.map(s => {
        const selected = q.platforms?.includes(s) ?? false
        return <Button size="small" key={s} aria-pressed={selected} onClick={() => patch({ platforms: selected ? q.platforms?.filter(v => v !== s) : [...(q.platforms ?? []), s] })}>{surfaceNames[s]}</Button>
      })}</div></Disclosure>
      <FieldGroup className="form-grid"><Field label="组内排序"><NativeSelect value={q.sortBy ?? ''} onChange={e => patch({ sortBy: e.target.value as QualitySort || undefined, sortReverse: false })}>
        <NativeSelectOption value="">订阅顺序</NativeSelectOption>{qualitySorts.map(k => <NativeSelectOption key={k} value={k}>{qualitySortLabels[k]}优先</NativeSelectOption>)}
      </NativeSelect></Field>
      <Field label="最多保留节点数"><Input type="number" min={1} max={16000} step={1} value={q.topN ?? ''} placeholder="不限" onChange={e =>
        patch({ topN: e.target.value ? Math.max(1, Math.min(16000, Math.floor(e.target.valueAsNumber))) : undefined })} /></Field></FieldGroup>
      {q.sortBy && <Toggle label="反向排序" checked={!!q.sortReverse} onChange={sortReverse => patch({ sortReverse })} />}
      <Field label="未测节点"><NativeSelect value={q.untestedPolicy ?? 'exclude'} onChange={e => patch({ untestedPolicy: e.target.value === 'include' ? 'include' : 'exclude' })}>
        <NativeSelectOption value="exclude">排除缺少所需测量的节点</NativeSelectOption><NativeSelectOption value="include">保留缺少所需测量的节点</NativeSelectOption>
      </NativeSelect></Field>
      <Toggle label="筛空时先放宽条件" checked={!!q.relaxWhenEmpty} onChange={relaxWhenEmpty => patch({ relaxWhenEmpty })}
        detail="先取消延迟上限。仍无匹配时，再纳入需要浏览器验证的平台入口。" />
      <Toggle label="筛空时恢复基础候选" checked={!!q.fallbackWhenEmpty} onChange={fallbackWhenEmpty => patch({ fallbackWhenEmpty })}
        detail="仍无匹配时，使用本筛选池的来源、标称地区和名称匹配结果。" />
    </div></Disclosure>
  </div>
}
