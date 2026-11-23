import type { QualityCondition } from '../shared/group-filter.ts'
import { qualityPresets } from '../shared/group-filter.ts'
import { surfaces, surfaceNames } from '../shared/quality-options.ts'
import { Disclosure, Field, FieldGroup, Input, NativeSelect, NativeSelectOption, Toggle } from './ui.tsx'
import { QualityBaselinePicker } from './quality-baseline.tsx'

export const reasonNames: Record<string, string> = {
  unavailable: '节点不可用', latency: '延迟过高', loss: '丢包过高', bandwidth: '带宽不足', platform: '所需入口未确认可达', untested: '缺少测量',
}
export function PoolQuality({ value, change }: { value?: QualityCondition; change: (value?: QualityCondition) => void }) {
  const q = value ?? {}
  const { fallbackWhenEmpty, untestedPolicy, ...thresholds } = q
  function patch(part: Partial<QualityCondition>) { change({ ...q, ...part }) }
  function threshold(label: string, key: 'maxLatencyMs' | 'maxLossRate' | 'minBandwidthMbps', scale: number, max: number) {
    const n = q[key]
    return <Field label={label}><Input type="number" min={0} max={max} step="any" placeholder="不限"
      value={n == null ? '' : Number((n * scale).toFixed(4))} onChange={e => {
        const input = e.target.valueAsNumber
        patch({ [key]: Number.isFinite(input) ? Math.max(0, Math.min(max, input)) / scale : undefined })
      }} /></Field>
  }
  return <div className="pool-quality">
    <div className="pool-quality-head"><strong>质量条件</strong><QualityBaselinePicker /></div>
    <div className="pool-presets" role="group" aria-label="质量筛选预设">
      <button type="button" aria-pressed={!value} onClick={() => change(undefined)}>不限质量</button>
      {Object.entries(qualityPresets).map(([id, preset]) => <button type="button" key={id} aria-pressed={JSON.stringify(thresholds) === JSON.stringify(preset.condition)}
        onClick={() => change({ ...preset.condition, fallbackWhenEmpty, untestedPolicy })}>{preset.name}</button>)}
    </div>
    {value && <p className="field-note muted">{[
      q.alive && '仅可用', q.maxLatencyMs != null && 'HTTPS ≤ ' + q.maxLatencyMs + ' ms',
      q.maxLossRate != null && '丢包 ≤ ' + Number((q.maxLossRate * 100).toFixed(2)) + '%',
      q.minBandwidthMbps != null && '带宽 ≥ ' + q.minBandwidthMbps + ' Mbps', ...(q.platforms ?? []).map(k => surfaceNames[k]),
    ].filter(Boolean).join(' · ') || '全部已测节点'}</p>}
    <Disclosure title="自定义阈值与兜底"><div className="quality-device">
      <Toggle label="仅保留可用节点" checked={!!q.alive} onChange={alive => patch({ alive })} />
      <FieldGroup className="form-grid three">{threshold('最大 HTTPS 延迟（ms）', 'maxLatencyMs', 1, 600000)}
        {threshold('最大丢包率（%）', 'maxLossRate', 100, 100)}{threshold('最低带宽（Mbps）', 'minBandwidthMbps', 1, 1000000)}</FieldGroup>
      <div><strong>必须可达的平台入口</strong><div className="pool-presets" role="group" aria-label="必须可达的平台入口">{surfaces.map(s => {
        const selected = q.platforms?.includes(s) ?? false
        return <button type="button" key={s} aria-pressed={selected} onClick={() => patch({ platforms: selected ? q.platforms?.filter(v => v !== s) : [...(q.platforms ?? []), s] })}>{surfaceNames[s]}</button>
      })}</div></div>
      <Field label="未测节点"><NativeSelect value={q.untestedPolicy ?? 'exclude'} onChange={e => patch({ untestedPolicy: e.target.value === 'include' ? 'include' : 'exclude' })}>
        <NativeSelectOption value="exclude">排除缺少所需测量的节点</NativeSelectOption><NativeSelectOption value="include">保留缺少所需测量的节点</NativeSelectOption>
      </NativeSelect></Field>
      <Toggle label="筛空时恢复基础候选" checked={!!q.fallbackWhenEmpty} onChange={fallbackWhenEmpty => patch({ fallbackWhenEmpty })}
        detail="质量条件筛空时，使用本筛选池的来源、地区和名称匹配结果。" />
    </div></Disclosure>
  </div>
}
