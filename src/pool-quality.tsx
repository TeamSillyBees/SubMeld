import { useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { regions } from '../shared/catalog.ts'
import { hasQualityConditions, type QualityCondition } from '../shared/group-filter.ts'
import { qualitySorts, type NodeQuality, type QualitySort } from '../shared/quality-snapshot.ts'
import { surfaces, surfaceNames } from '../shared/quality-options.ts'
import { Alert, Badge, Button, Field, FieldGroup, Input, Modal, MultiSelect, NativeSelect, NativeSelectOption, RouteLink, Toggle } from './ui.tsx'
import { qualitySortLabels } from './node-quality.tsx'
import { useProject } from './project.tsx'

export const reasonNames: Record<string, string> = {
  unavailable: '节点不可用', availability: '可用率不足', latency: '延迟过高', jitter: '抖动过高', loss: '丢包过高', bandwidth: '带宽不足',
  platform: 'AI 入口或等级未达标', region: '出口地区不符', source: '订阅源已排除此节点', nameRegion: '标称地区不符', name: '名称或节点范围不符', limit: '超过保留名额', untested: '缺少测量',
}
type Metric = 'httpsMs' | 'jitterMs' | 'speedMbps' | 'availabilityPct'
const percentile = (values: number[], p: number) => values[Math.ceil(values.length * p / 100) - 1]
const display = (v: number) => Number(v.toFixed(2))

function normalizeQualityCondition(next: QualityCondition): QualityCondition | undefined {
  const cleaned = { ...next }
  delete cleaned.aiPlatforms
  delete cleaned.minUnlockLevel
  if (!cleaned.alive) delete cleaned.alive
  if (!cleaned.aiAll) delete cleaned.aiAll
  if (!cleaned.aiSurfaces?.length) delete cleaned.aiSurfaces
  if (!cleaned.platforms?.length) delete cleaned.platforms
  if (!cleaned.exitRegions?.length) {
    delete cleaned.exitRegions
    delete cleaned.excludeExitRegions
  } else if (!cleaned.excludeExitRegions) {
    delete cleaned.excludeExitRegions
  }
  if (!cleaned.sortBy) {
    delete cleaned.sortBy
    delete cleaned.sortReverse
  } else if (!cleaned.sortReverse) {
    delete cleaned.sortReverse
  }
  if (cleaned.untestedPolicy !== 'include') delete cleaned.untestedPolicy
  if (!cleaned.relaxWhenEmpty) delete cleaned.relaxWhenEmpty
  if (!cleaned.fallbackWhenEmpty) delete cleaned.fallbackWhenEmpty
  for (const key of ['minAvailability', 'maxLatencyMs', 'maxJitterMs', 'minBandwidthMbps', 'maxLossRate', 'topN'] as const) {
    if (cleaned[key] == null) delete cleaned[key]
  }
  return Object.keys(cleaned).length ? cleaned : undefined
}

export function PoolQuality({ value, readings, deviceId, onDeviceChange, change }: {
  value?: QualityCondition
  readings: NodeQuality[]
  deviceId?: string | null
  onDeviceChange?: (deviceId: string | null) => void
  change: (value?: QualityCondition) => void
}) {
  const { quality } = useProject()
  const q = value ?? {}
  const [modalOpen, setModalOpen] = useState(false)
  const distribution = useMemo(() => {
    const values = (key: 'httpsMs' | 'jitterMs' | 'speedMbps') => readings.flatMap(r => r.available && r[key] != null ? [r[key]!] : []).sort((a, b) => a - b)
    const availabilityPct = readings
      .flatMap(r => {
        const rate = r.availabilityRate ?? (r.availability && r.availability.total > 0 ? r.availability.rate : null)
        return rate != null ? [display(rate * 100)] : []
      })
      .sort((a, b) => a - b)
    return { httpsMs: values('httpsMs'), jitterMs: values('jitterMs'), speedMbps: values('speedMbps'), availabilityPct }
  }, [readings])
  const measured = new Set([...regions.filter(([id]) => id !== 'unknown').map(([id]) => id),
    ...readings.flatMap(r => r.exitRegion ?? []), ...(q.exitRegions ?? [])])
  const names = new Intl.DisplayNames('zh-CN', { type: 'region' })
  const options = [...measured].sort().map(id => [id, id + ' · ' + names.of(id)])

  const probeOptions = useMemo(() => {
    const list = quality.devices.map(d => ({
      id: d.id,
      label: (d.remark || d.name) + (d.status === 'offline' ? '（离线）' : ''),
    }))
    if (deviceId && !quality.devices.some(d => d.id === deviceId)) {
      list.push({
        id: deviceId,
        label: Object.hasOwn(quality.latest, deviceId) ? '历史探针' : '已解绑探针',
      })
    }
    return list
  }, [quality.devices, quality.latest, deviceId])

  const probeSelectOptions = <>
    <NativeSelectOption value="">未绑定探针</NativeSelectOption>
    {probeOptions.map(p => <NativeSelectOption key={p.id} value={p.id}>{p.label}</NativeSelectOption>)}
  </>

  function patch(part: Partial<QualityCondition>) {
    change(normalizeQualityCondition({ ...q, ...part }))
  }

  function threshold(
    label: string,
    key: 'minAvailability' | 'maxLatencyMs' | 'maxJitterMs' | 'minBandwidthMbps' | 'maxLossRate',
    max: number,
    metric?: Metric,
  ) {
    const scale = key === 'maxLossRate' || key === 'minAvailability' ? 100 : 1
    const values = metric ? distribution[metric] : []
    const unit = scale === 100 ? '%' : key === 'minBandwidthMbps' ? 'Mbps' : 'ms'
    const isLowerBound = key === 'minBandwidthMbps' || key === 'minAvailability'
    const n = q[key]
    const shown = n == null ? undefined : display(n * scale)
    const toStored = (val: number) => scale === 100 ? Number((val / scale).toFixed(4)) : display(val)
    return <div className="quality-threshold"><Field label={label}><Input type="number" min={0} max={max} step="any" placeholder="不限"
      value={shown ?? ''} onChange={e => {
        const input = e.target.valueAsNumber
        patch({ [key]: e.target.value !== '' && Number.isFinite(input) ? toStored(Math.max(0, Math.min(max, input))) : undefined })
      }} /></Field>
      {values.length > 0 && <><input type="range" aria-label={label + '滑块'} min={0} max={Math.min(max, Math.max(values.at(-1)!, shown ?? 0, 1))} step="any"
        value={shown ?? (isLowerBound ? 0 : values.at(-1)!)} onChange={e => patch({ [key]: toStored(e.target.valueAsNumber) })} />
        <div className="quality-percentiles">{[25, 50, 75].map(p => {
          const v = display(percentile(values, p))
          return <Button key={p} variant="ghost" size="small" aria-label={label + ' P' + p + '，' + v + ' ' + unit} onClick={() => patch({ [key]: toStored(v) })}>P{p} · {v}</Button>
        })}</div></>}
    </div>
  }

  const aiAllActive = Boolean(q.aiAll)
  const highAvailActive = q.minAvailability != null && q.minAvailability >= 0.8
  const lowLatencyActive = q.maxLatencyMs != null && q.maxLatencyMs <= 250
  const lowLossActive = q.maxLossRate != null && q.maxLossRate <= 0.05

  const selectedSurfaces = q.aiAll
    ? [...surfaces]
    : [...new Set([...(q.aiSurfaces ?? []), ...(q.platforms ?? [])])]

  const activeAdvancedCount = [
    q.alive,
    q.minAvailability != null && q.minAvailability !== 0.8,
    q.maxLatencyMs != null && q.maxLatencyMs !== 250,
    q.maxLossRate != null && q.maxLossRate !== 0.05,
    q.maxJitterMs != null,
    q.minBandwidthMbps != null,
    !q.aiAll && selectedSurfaces.length > 0,
    Boolean(q.exitRegions?.length),
    Boolean(q.sortBy),
    q.topN != null,
    q.untestedPolicy === 'include',
    q.relaxWhenEmpty,
    q.fallbackWhenEmpty,
  ].filter(Boolean).length

  const summaryParts = [
    q.alive && '仅可用',
    q.minAvailability != null && '可用率 ≥ ' + display(q.minAvailability * 100) + '%',
    q.maxLatencyMs != null && 'HTTPS ≤ ' + q.maxLatencyMs + ' ms',
    q.maxJitterMs != null && '抖动 ≤ ' + q.maxJitterMs + ' ms',
    q.minBandwidthMbps != null && '带宽 ≥ ' + q.minBandwidthMbps + ' Mbps',
    q.maxLossRate != null && '丢包 ≤ ' + display(q.maxLossRate * 100) + '%',
    q.aiAll ? '全 AI 解锁' : selectedSurfaces.length > 0 && selectedSurfaces.map(k => surfaceNames[k]).join('、'),
    q.exitRegions?.length && (q.excludeExitRegions ? '排除出口 ' : '出口 ') + q.exitRegions.join('/'),
    q.sortBy && '按' + qualitySortLabels[q.sortBy] + (q.sortReverse ? '反向' : '') + '排序',
    q.topN && '前 ' + q.topN + ' 个',
    q.untestedPolicy === 'include' && '保留未测节点',
    q.relaxWhenEmpty && '筛空放宽',
    q.fallbackWhenEmpty && '筛空兜底',
  ].filter(Boolean)

  return <div className="pool-quality">
    <div className="pool-quality-head">
      <div className="pool-quality-title">
        <strong>质量条件</strong>
        <NativeSelect aria-label="检测探针" className="pool-probe-select" value={deviceId ?? ''} onChange={e => onDeviceChange?.(e.target.value || null)}>
          {probeSelectOptions}
        </NativeSelect>
      </div>
      <div className="actions">
        <Button variant="outline" size="small" icon={SlidersHorizontal} onClick={() => setModalOpen(true)}>
          高级质量筛选{activeAdvancedCount > 0 && <Badge tone="accent">{activeAdvancedCount}</Badge>}
        </Button>
        <RouteLink className="text-link field-note" page="quality">管理定时检测</RouteLink>
      </div>
    </div>
    <div className="pool-region-list pool-quick-filters" role="group" aria-label="快捷质量筛选">
      <button type="button" aria-pressed={aiAllActive} onClick={() => patch({ aiAll: aiAllActive ? undefined : true, aiSurfaces: undefined, platforms: undefined })}>全 AI 解锁</button>
      <button type="button" aria-pressed={highAvailActive} onClick={() => patch({ minAvailability: highAvailActive ? undefined : 0.8 })}>高可用率</button>
      <button type="button" aria-pressed={lowLatencyActive} onClick={() => patch({ maxLatencyMs: lowLatencyActive ? undefined : 250 })}>低延迟</button>
      <button type="button" aria-pressed={lowLossActive} onClick={() => patch({ maxLossRate: lowLossActive ? undefined : 0.05 })}>低丢包率</button>
    </div>
    {hasQualityConditions(value) && !deviceId && <Alert tone="warning">已配置质量筛选条件，请先选择检测探针以预览并生效。</Alert>}
    {summaryParts.length > 0 && <p className="field-note muted">{summaryParts.join(' · ')}</p>}

    {modalOpen && <Modal
      wide
      title="高级质量筛选"
      detail="配置检测探针、精确质量阈值、AI 解锁入口、出口地区、排序与兜底策略。"
      onClose={() => setModalOpen(false)}
      footer={<>
        <Button variant="ghost" disabled={!value} onClick={() => change(undefined)}>重置条件</Button>
        <Button variant="primary" onClick={() => setModalOpen(false)}>确定</Button>
      </>}
    >
      <div className="quality-device">
        <Field label="检测探针">
          <NativeSelect value={deviceId ?? ''} onChange={e => onDeviceChange?.(e.target.value || null)}>
            {probeSelectOptions}
          </NativeSelect>
        </Field>
        <Toggle label="仅保留可用节点" checked={!!q.alive} onChange={alive => patch({ alive })} />
        <FieldGroup className="form-grid">
          {threshold('最低可用率（%）', 'minAvailability', 100, 'availabilityPct')}
          {threshold('最大 HTTPS 延迟（ms）', 'maxLatencyMs', 600000, 'httpsMs')}
          {threshold('最大抖动（ms）', 'maxJitterMs', 600000, 'jitterMs')}
          {threshold('最低带宽（Mbps）', 'minBandwidthMbps', 1000000, 'speedMbps')}
          {threshold('最大丢包率（%）', 'maxLossRate', 100)}
        </FieldGroup>
        <div>
          <strong>AI 解锁入口</strong>
          <div className="pool-presets" role="group" aria-label="要求解锁的 AI 入口">
            {surfaces.map(s => {
              const checked = selectedSurfaces.includes(s)
              return <Button size="small" key={s} aria-pressed={checked} onClick={() => {
                const next = checked ? selectedSurfaces.filter(v => v !== s) : [...selectedSurfaces, s]
                if (next.length === surfaces.length) {
                  patch({ aiAll: true, aiSurfaces: undefined, platforms: undefined })
                } else if (next.length === 0) {
                  patch({ aiAll: undefined, aiSurfaces: undefined, platforms: undefined })
                } else {
                  patch({ aiAll: undefined, aiSurfaces: next, platforms: undefined })
                }
              }}>{surfaceNames[s]}</Button>
            })}
          </div>
        </div>
        <MultiSelect
          label="出口地区"
          options={options}
          values={q.exitRegions ?? []}
          onChange={exitRegions => patch({ exitRegions, excludeExitRegions: exitRegions.length ? q.excludeExitRegions : undefined })}
          placeholder="不限出口地区"
        />
        {readings.some(r => r.exitRegionInferred) && <p className="field-note muted">部分节点的出口地区由至少两个一致的平台入口观测推定。</p>}
        {!!q.exitRegions?.length && <Toggle label="排除选中的出口地区" checked={!!q.excludeExitRegions} onChange={excludeExitRegions => patch({ excludeExitRegions })} />}
        <FieldGroup className="form-grid">
          <Field label="组内排序方式">
            <NativeSelect value={q.sortBy ?? ''} onChange={e => patch({ sortBy: (e.target.value as QualitySort) || undefined, sortReverse: false })}>
              <NativeSelectOption value="">订阅顺序</NativeSelectOption>
              {qualitySorts.map(k => <NativeSelectOption key={k} value={k}>{qualitySortLabels[k]}优先</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field label="最多保留节点数">
            <Input
              type="number"
              min={1}
              max={16000}
              step={1}
              value={q.topN ?? ''}
              placeholder="不限"
              onChange={e => {
                const raw = e.target.valueAsNumber
                patch({ topN: e.target.value !== '' && Number.isFinite(raw) ? Math.max(1, Math.min(16000, Math.floor(raw))) : undefined })
              }}
            />
          </Field>
        </FieldGroup>
        {q.sortBy && <Toggle label="反向排序" checked={!!q.sortReverse} onChange={sortReverse => patch({ sortReverse })} />}
        <Field label="未测节点">
          <NativeSelect value={q.untestedPolicy ?? 'exclude'} onChange={e => patch({ untestedPolicy: e.target.value === 'include' ? 'include' : 'exclude' })}>
            <NativeSelectOption value="exclude">排除缺少所需测量的节点</NativeSelectOption>
            <NativeSelectOption value="include">保留缺少所需测量的节点</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Toggle
          label="筛空时先放宽条件"
          checked={!!q.relaxWhenEmpty}
          onChange={relaxWhenEmpty => patch({ relaxWhenEmpty })}
          detail="先取消延迟上限。仍无匹配时，再纳入需要浏览器验证的平台入口。"
        />
        <Toggle
          label="筛空时恢复基础候选"
          checked={!!q.fallbackWhenEmpty}
          onChange={fallbackWhenEmpty => patch({ fallbackWhenEmpty })}
          detail="仍无匹配时，使用本筛选池的来源、标称地区和名称匹配结果。"
        />
      </div>
    </Modal>}
  </div>
}
