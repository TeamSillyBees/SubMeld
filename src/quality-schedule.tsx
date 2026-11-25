import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clock, Play, RotateCcw } from 'lucide-react'
import { compatibleProbe, isSubscriptionNotice, minimumProbeVersion } from '../shared/quality-options.ts'
import {
  defaultQualityScheduleConfig, maxQualityNodes, type ProbeDevice, type QualityJob,
  type QualityScheduleConfig, type ScheduleSkipReason,
} from '../shared/quality.ts'
import { asError } from './errors.ts'
import { deviceStates } from './probe-setup.tsx'
import { useProject } from './project.tsx'
import { useUnsavedChanges } from './confirm.tsx'
import { NumberChoice } from './quality.tsx'
import {
  Alert, Badge, Button, Field, FieldGroup, FieldLegend, FieldSet, Input,
  NativeSelect, NativeSelectOption, Panel, TimeLabel, Toggle, formatNumber, formatTime,
} from './ui.tsx'

const basicPresets = [
  [360, '每 6 小时'],
  [720, '每 12 小时'],
  [1440, '每天'],
] as const

const aiPresets = [
  [1440, '每天'],
  [4320, '每 3 天'],
  [10080, '每 7 天'],
] as const

const skipLabels: Record<ScheduleSkipReason, string> = {
  disabled: '未启用',
  not_due: '尚未到期',
  no_device: '未选择探针',
  device_missing: '探针已解除配对',
  device_offline: '探针离线',
  device_incompatible: '探针版本过低',
  no_nodes: '范围内无可测节点',
  already_active: '已有同类任务在排队或执行',
  queue_full: '探针等待队列已满',
}

function editablePart(cfg: QualityScheduleConfig) {
  return {
    targetDeviceId: cfg.targetDeviceId,
    scope: cfg.scope,
    autoRefreshGroups: cfg.autoRefreshGroups,
    basic: {
      enabled: cfg.basic.enabled,
      intervalMinutes: cfg.basic.intervalMinutes,
      rounds: cfg.basic.rounds,
      concurrency: cfg.basic.concurrency,
      bandwidth: cfg.basic.bandwidth,
    },
    ai: {
      enabled: cfg.ai.enabled,
      intervalMinutes: cfg.ai.intervalMinutes,
      concurrency: cfg.ai.concurrency,
    },
  }
}

function formatInterval(minutes: number) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) return '请输入 1 – 43,200 之间的整数分钟数'
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天（${formatNumber(minutes)} 分钟）`
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时（${formatNumber(minutes)} 分钟）`
  return `每 ${formatNumber(minutes)} 分钟`
}

function intervalError(minutes: number) {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 43200 ? undefined : '请输入 1 到 43200 之间的整数分钟数。'
}

export function QualitySchedulePanel({
  devices,
  jobs,
  refresh,
  onOpenJob,
  onOpenProbes,
}: {
  devices: ProbeDevice[]
  jobs: QualityJob[] | null
  refresh: () => void
  onOpenJob: (jobId: string) => void
  onOpenProbes: () => void
}) {
  const { state, view, call, notify } = useProject()
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [runError, setRunError] = useState('')
  const [original, setOriginal] = useState<QualityScheduleConfig>(() => structuredClone(defaultQualityScheduleConfig))
  const [form, setForm] = useState<QualityScheduleConfig>(() => structuredClone(defaultQualityScheduleConfig))
  const [saving, setSaving] = useState(false)
  const [runningKind, setRunningKind] = useState<'basic' | 'ai' | 'due' | null>(null)
  const serial = useRef(0)
  const instanceSerial = useRef(0)
  const basicIntervalRef = useRef<HTMLInputElement>(null)
  const aiIntervalRef = useRef<HTMLInputElement>(null)

  const dirty = loaded && JSON.stringify(editablePart(form)) !== JSON.stringify(editablePart(original))
  useUnsavedChanges(dirty, '定时检测配置将恢复为上次保存的设置。')

  useEffect(() => {
    if (!dirty) setSaveError('')
  }, [dirty])

  const loadSchedule = useCallback(async (syncEditable = false) => {
    const order = ++serial.current
    const generation = instanceSerial.current
    setLoadError('')
    try {
      const next = await call('quality/schedule')
      if (order !== serial.current || generation !== instanceSerial.current) return
      setOriginal(next)
      setForm(prev => (syncEditable ? structuredClone(next) : {
        ...prev,
        basic: { ...prev.basic, lastRunAt: next.basic.lastRunAt, lastJobId: next.basic.lastJobId },
        ai: { ...prev.ai, lastRunAt: next.ai.lastRunAt, lastJobId: next.ai.lastJobId },
      }))
      setLoaded(true)
    } catch (cause) {
      if (order !== serial.current || generation !== instanceSerial.current) return
      setLoadError(asError(cause).message)
    }
  }, [call])

  useEffect(() => {
    setLoaded(false)
    setSaveError('')
    setRunError('')
    void loadSchedule(true)
    return () => {
      serial.current++
      instanceSerial.current++
    }
  }, [loadSchedule, state.id])

  const completedKey = useMemo(
    () => (jobs ?? []).filter(j => j.status === 'completed').map(j => j.id).join(','),
    [jobs],
  )
  useEffect(() => {
    if (!loaded || !completedKey) return
    void loadSchedule(false)
  }, [completedKey, loaded, loadSchedule])

  const basicErr = intervalError(form.basic.intervalMinutes)
  const aiErr = intervalError(form.ai.intervalMinutes)
  const busy = saving || runningKind !== null

  const selectedDevice = devices.find(d => d.id === form.targetDeviceId) ?? null
  const savedDevice = devices.find(d => d.id === original.targetDeviceId) ?? null
  const savedTargetReady = Boolean(savedDevice && savedDevice.status !== 'offline' && compatibleProbe(savedDevice))
  const retainedCount = useMemo(() => view.nodes.filter(n => n.kept).length, [view.nodes])
  const totalCount = view.nodes.length
  const testableNodes = useMemo(
    () => view.nodes.filter(n => !isSubscriptionNotice(n.name) && !isSubscriptionNotice(n.originalName)),
    [view.nodes],
  )
  const testableRetainedCount = useMemo(() => testableNodes.filter(n => n.kept).length, [testableNodes])
  const testableTotalCount = testableNodes.length
  const savedNodeCount = original.scope === 'kept' ? testableRetainedCount : testableTotalCount
  const formNodeCount = form.scope === 'kept' ? testableRetainedCount : testableTotalCount

  async function save() {
    if (!loaded || busy) return
    if (basicErr) {
      basicIntervalRef.current?.focus()
      return
    }
    if (aiErr) {
      aiIntervalRef.current?.focus()
      return
    }
    const generation = instanceSerial.current
    serial.current++
    setSaving(true)
    setSaveError('')
    setRunError('')
    try {
      const next = await call('quality/schedule', {
        targetDeviceId: form.targetDeviceId,
        scope: form.scope,
        autoRefreshGroups: form.autoRefreshGroups,
        basic: {
          ...form.basic,
          lastRunAt: original.basic.lastRunAt,
          lastJobId: original.basic.lastJobId,
        },
        ai: {
          ...form.ai,
          lastRunAt: original.ai.lastRunAt,
          lastJobId: original.ai.lastJobId,
        },
      })
      if (generation !== instanceSerial.current) return
      serial.current++
      setOriginal(next)
      setForm(structuredClone(next))
      notify('定时检测配置已保存')
    } catch (cause) {
      if (generation !== instanceSerial.current) return
      setSaveError(asError(cause).message)
    } finally {
      if (generation === instanceSerial.current) setSaving(false)
    }
  }

  async function runNow(kind: 'basic' | 'ai' | 'due') {
    if (!loaded || busy) return
    const generation = instanceSerial.current
    serial.current++
    setRunningKind(kind)
    setSaveError('')
    setRunError('')
    try {
      const result = await call('quality/schedule/run', { kind })
      if (generation !== instanceSerial.current) return
      serial.current++
      setOriginal(result.schedule)
      setForm(prev => dirty ? {
        ...prev,
        basic: { ...prev.basic, lastRunAt: result.schedule.basic.lastRunAt, lastJobId: result.schedule.basic.lastJobId },
        ai: { ...prev.ai, lastRunAt: result.schedule.ai.lastRunAt, lastJobId: result.schedule.ai.lastJobId },
      } : structuredClone(result.schedule))
      refresh()
      if (result.jobs.length > 0) {
        notify(`已创建 ${result.jobs.length} 个定时检测任务`)
      } else if (result.skipped.length > 0) {
        const detail = result.skipped.map(s => `${s.kind === 'basic' ? '常规检测' : 'AI 检测'}：${skipLabels[s.reason]}`).join('；')
        notify(`本次未调度任务（${detail}）`, 'warning')
      } else {
        notify('当前没有可执行的定时任务', 'info')
      }
    } catch (cause) {
      if (generation !== instanceSerial.current) return
      setRunError(asError(cause).message)
    } finally {
      if (generation === instanceSerial.current) setRunningKind(null)
    }
  }

  function reset() {
    setForm(structuredClone(original))
    setSaveError('')
    setRunError('')
  }

  const updateBasic = <K extends keyof QualityScheduleConfig['basic']>(key: K, value: QualityScheduleConfig['basic'][K]) =>
    setForm(prev => ({ ...prev, basic: { ...prev.basic, [key]: value } }))

  const updateAi = <K extends keyof QualityScheduleConfig['ai']>(key: K, value: QualityScheduleConfig['ai'][K]) =>
    setForm(prev => ({ ...prev, ai: { ...prev.ai, [key]: value } }))

  return <div className="stack">
    {loadError && <Alert tone="danger" action={<Button size="small" onClick={() => void loadSchedule(!loaded || !dirty)}>重试</Button>}>{loadError}</Alert>}
    {runError && <Alert tone="danger">{runError}</Alert>}
    {!loaded && !loadError && <p role="status" className="muted">正在读取定时检测配置…</p>}

    {loaded && <>
    <Panel
      title="调度目标与联动"
      detail="配置定时任务使用的执行探针、节点范围与代理组自动更新策略。"
      actions={<>
        <Button size="small" icon={Play} busy={runningKind === 'due'} disabled={busy || dirty || !savedTargetReady || savedNodeCount === 0} onClick={() => void runNow('due')}>
          执行到期任务
        </Button>
        <Button size="small" variant="primary" icon={Check} busy={saving} disabled={!dirty || busy || Boolean(basicErr || aiErr)} onClick={() => void save()}>
          保存定时配置
        </Button>
      </>}
    >
      <div className="panel-padding stack" inert={busy}>
        {!devices.length && <Alert tone="warning" action={<Button size="small" onClick={onOpenProbes}>前往探针管理</Button>}>
          尚未配对常驻探针。请先在「探针管理」中安装并配对个人电脑探针，再启用定时任务。
        </Alert>}
        {(form.basic.enabled || form.ai.enabled) && !form.targetDeviceId && devices.length > 0 && <Alert tone="warning">
          已启用定时检测，请选择一台执行探针后再保存配置。
        </Alert>}
        {selectedDevice && (selectedDevice.status === 'offline' || !compatibleProbe(selectedDevice)) && <Alert tone="warning">
          所选探针当前{selectedDevice.status === 'offline' ? '离线' : `版本过低（需升级至 ${minimumProbeVersion}）`}。在探针恢复在线且兼容前，到期任务会自动跳过。
        </Alert>}
        {formNodeCount === 0 && <Alert tone="warning">
          当前检测范围内没有可测节点，请先在订阅源或节点管理中添加或保留节点。
        </Alert>}

        <FieldGroup className="form-grid">
          <Field label="执行探针" hint={selectedDevice ? `最近心跳 ${formatTime(selectedDevice.lastSeenAt)}` : '定时任务仅下发给已选定的在线探针。'}>
            <NativeSelect
              value={form.targetDeviceId ?? ''}
              onChange={event => setForm(prev => ({ ...prev, targetDeviceId: event.target.value || null }))}
            >
              <NativeSelectOption value="">请选择执行探针</NativeSelectOption>
              {devices.map(d => (
                <NativeSelectOption key={d.id} value={d.id}>
                  {(d.remark || d.name) + '（' + deviceStates[d.status] + (!compatibleProbe(d) ? ' · 需更新至 ' + minimumProbeVersion : '') + '）'}
                </NativeSelectOption>
              ))}
              {form.targetDeviceId && !selectedDevice && (
                <NativeSelectOption value={form.targetDeviceId} disabled>已解除配对的探针</NativeSelectOption>
              )}
            </NativeSelect>
          </Field>

          <Field label="检测范围" hint={`保留 ${formatNumber(retainedCount)} / 总计 ${formatNumber(totalCount)} 个节点（单批上限 ${maxQualityNodes}，超出自动分批，自动跳过订阅提示条目）。`}>
            <NativeSelect
              value={form.scope}
              onChange={event => setForm(prev => ({ ...prev, scope: event.target.value === 'all' ? 'all' : 'kept' }))}
            >
              <NativeSelectOption value="kept">仅已保留节点（kept）</NativeSelectOption>
              <NativeSelectOption value="all">全部节点（all）</NativeSelectOption>
            </NativeSelect>
          </Field>
        </FieldGroup>

        <Toggle
          label="检测完成后自动联动更新动态代理组"
          detail="开启后，定时任务完成并更新节点最新质量记录时，若动态代理组生成结果发生变更，将自动发布新版订阅配置。"
          checked={form.autoRefreshGroups}
          onChange={autoRefreshGroups => setForm(prev => ({ ...prev, autoRefreshGroups }))}
        />
      </div>
    </Panel>

    <div className="settings-grid" inert={busy}>
      <Panel
        title={<>常规质量检测 <Badge tone={form.basic.enabled ? 'success' : 'neutral'}>{form.basic.enabled ? '已启用' : '未启用'}</Badge></>}
        detail="测量 TLS/HTTPS 延迟、抖动、丢包率与出口 IP，并更新多轮统计可用率。"
        actions={
          <Button size="small" icon={Play} busy={runningKind === 'basic'} disabled={busy || !loaded || dirty || !savedTargetReady || savedNodeCount === 0} onClick={() => void runNow('basic')}>
            立即执行常规检测
          </Button>
        }
      >
        <div className="panel-padding stack">
          <Toggle
            label="启用常规质量检测"
            detail="按固定周期执行基础连通性与延迟采样（不执行 AI 解锁探测）。"
            checked={form.basic.enabled}
            onChange={enabled => updateBasic('enabled', enabled)}
          />

          <FieldSet>
            <FieldLegend variant="label">执行周期预设</FieldLegend>
            <div className="pool-presets schedule-presets" role="group" aria-label="常规检测周期预设">
              {basicPresets.map(([minutes, label]) => (
                <button
                  key={minutes}
                  type="button"
                  aria-pressed={form.basic.intervalMinutes === minutes}
                  onClick={() => updateBasic('intervalMinutes', minutes)}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={!basicPresets.some(([m]) => m === form.basic.intervalMinutes)}
                onClick={() => basicIntervalRef.current?.focus()}
              >
                自定义
              </button>
            </div>
          </FieldSet>

          <Field
            label="常规检测周期（分钟）"
            hint={formatInterval(form.basic.intervalMinutes)}
            error={basicErr}
          >
            <Input
              ref={basicIntervalRef}
              type="number"
              min={1}
              max={43200}
              step={1}
              value={Number.isFinite(form.basic.intervalMinutes) ? form.basic.intervalMinutes : ''}
              onChange={event => {
                const raw = event.target.value
                updateBasic('intervalMinutes', raw === '' ? Number.NaN : Number(raw))
              }}
            />
          </Field>

          <FieldGroup className="form-grid">
            <NumberChoice label="采样轮数" value={form.basic.rounds} options={[2, 3, 5, 8]} unit=" 轮" onChange={rounds => updateBasic('rounds', rounds)} />
            <NumberChoice label="并行节点数" value={form.basic.concurrency} options={[1, 3, 6, 8, 12]} onChange={concurrency => updateBasic('concurrency', concurrency)} />
          </FieldGroup>

          <Toggle
            label="包含下载测速"
            detail="对可用节点追加流式下载测速，耗时更长且会消耗节点流量。"
            checked={form.basic.bandwidth}
            onChange={bandwidth => updateBasic('bandwidth', bandwidth)}
          />

          <div className="schedule-card-footer">
            <span className="field-note muted">最近执行：<TimeLabel value={original.basic.lastRunAt} /></span>
            {original.basic.lastJobId && (
              <Button size="small" variant="ghost" onClick={() => onOpenJob(original.basic.lastJobId!)}>查看最近报告</Button>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title={<>AI 解锁检测 <Badge tone={form.ai.enabled ? 'success' : 'neutral'}>{form.ai.enabled ? '已启用' : '未启用'}</Badge></>}
        detail="独立探测 ChatGPT Web、ChatGPT APP、Gemini Web 与 Antigravity 解锁状态，不影响可用率窗口。"
        actions={
          <Button size="small" icon={Play} busy={runningKind === 'ai'} disabled={busy || !loaded || dirty || !savedTargetReady || savedNodeCount === 0} onClick={() => void runNow('ai')}>
            立即执行 AI 检测
          </Button>
        }
      >
        <div className="panel-padding stack">
          <Toggle
            label="启用 AI 解锁检测"
            detail="建议设置较长周期（如每 3 天），在仅测 AI 模式下增量更新 AI 解锁状态。"
            checked={form.ai.enabled}
            onChange={enabled => updateAi('enabled', enabled)}
          />

          <FieldSet>
            <FieldLegend variant="label">执行周期预设</FieldLegend>
            <div className="pool-presets schedule-presets" role="group" aria-label="AI 检测周期预设">
              {aiPresets.map(([minutes, label]) => (
                <button
                  key={minutes}
                  type="button"
                  aria-pressed={form.ai.intervalMinutes === minutes}
                  onClick={() => updateAi('intervalMinutes', minutes)}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={!aiPresets.some(([m]) => m === form.ai.intervalMinutes)}
                onClick={() => aiIntervalRef.current?.focus()}
              >
                自定义
              </button>
            </div>
          </FieldSet>

          <Field
            label="AI 检测周期（分钟）"
            hint={formatInterval(form.ai.intervalMinutes)}
            error={aiErr}
          >
            <Input
              ref={aiIntervalRef}
              type="number"
              min={1}
              max={43200}
              step={1}
              value={Number.isFinite(form.ai.intervalMinutes) ? form.ai.intervalMinutes : ''}
              onChange={event => {
                const raw = event.target.value
                updateAi('intervalMinutes', raw === '' ? Number.NaN : Number(raw))
              }}
            />
          </Field>

          <NumberChoice label="并行节点数" value={form.ai.concurrency} options={[1, 3, 6, 8, 12]} onChange={concurrency => updateAi('concurrency', concurrency)} />

          <div className="schedule-card-footer">
            <span className="field-note muted">最近执行：<TimeLabel value={original.ai.lastRunAt} /></span>
            {original.ai.lastJobId && (
              <Button size="small" variant="ghost" onClick={() => onOpenJob(original.ai.lastJobId!)}>查看最近报告</Button>
            )}
          </div>
        </div>
      </Panel>
    </div>

    {dirty && <div className="settings-save-bar">
      {saveError && <Alert tone="danger">{saveError}</Alert>}
      <div className="between flex-wrap">
        <span className="field-note muted"><Clock className="inline size-3.5 mr-1 align-text-bottom" aria-hidden="true" />有未保存的定时配置更改，保存后即可立即执行。</span>
        <div className="actions">
          <Button icon={RotateCcw} variant="ghost" disabled={busy} onClick={reset}>撤销更改</Button>
          <Button icon={Check} variant="primary" busy={saving} disabled={busy || Boolean(basicErr || aiErr)} onClick={() => void save()}>保存定时配置</Button>
        </div>
      </div>
    </div>}
    </>}
  </div>
}
