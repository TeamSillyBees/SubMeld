import { useEffect, useState } from 'react'
import type { ProbeDevice, QualityJob } from '../shared/quality.ts'
import { baselineId, type BaselinePolicy, type QualitySnapshot } from '../shared/quality-snapshot.ts'
import type { Draft, WorkspaceState } from '../shared/model.ts'
import type { Call } from './api.ts'
import { useProject } from './project.tsx'
import { Button, NativeSelect, NativeSelectOption, formatTime } from './ui.tsx'
import { asError } from './errors.ts'

const reportTime = (time?: string | null) => time ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time)) : '—'

export function useQualityBaseline(state: WorkspaceState | null, call: Call, save: (draft: Draft, revision: number) => Promise<WorkspaceState>) {
  const profileId = state?.id
  const [history, setHistory] = useState<{ profileId: string; jobs: QualityJob[]; devices: ProbeDevice[] }>()
  const [data, setData] = useState<{ profileId: string; snapshot: QualitySnapshot }>()
  const [historyError, setHistoryError] = useState('')
  const [snapshotError, setSnapshotError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!profileId) return
    const id = profileId
    let alive = true, timer: ReturnType<typeof setTimeout>
    setHistoryError('')
    setSaveError('')
    async function refresh() {
      try {
        const [list, devices] = await Promise.all([call('quality/jobs'), call('quality/devices')])
        if (!alive) return
        const jobs = list.filter(j => j.status === 'completed').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '') || b.id.localeCompare(a.id))
        setHistory({ profileId: id, jobs, devices })
        setHistoryError('')
      } catch (e) { if (alive) setHistoryError(asError(e).message) }
      if (alive) timer = setTimeout(refresh, 8000)
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [call, profileId, attempt])
  const jobs = history?.profileId === profileId ? history?.jobs ?? [] : []
  const policy = state?.draft.qualityBaselinePolicy
  const device = policy?.mode === 'device' ? policy.deviceId : ''
  const reports = jobs.filter(j => !device || j.targetDeviceId === device)
  const report = policy?.mode === 'fixed' ? policy.reportId : ''
  const reportId = baselineId(policy, jobs, state?.current)
  useEffect(() => {
    let alive = true
    setSnapshotError('')
    if (profileId && reportId) call(`quality/snapshot?id=${reportId}`).then(snapshot => {
      if (alive) setData({ profileId, snapshot })
    }).catch(e => { if (alive) setSnapshotError(asError(e).message) })
    return () => { alive = false }
  }, [call, profileId, reportId, attempt])
  const snapshot = data && data.profileId === profileId && data.snapshot.reportId === reportId ? data.snapshot : null
  async function persist(next: BaselinePolicy) {
    if (!state || saving) return false
    setSaving(true)
    setSaveError('')
    try {
      await save({ ...state.draft, qualityBaselinePolicy: next }, state.revision)
      return true
    } catch (cause) { setSaveError(asError(cause).message); return false }
    finally { setSaving(false) }
  }
  const devices = new Map<string, string>()
  for (const j of [...jobs].reverse()) if (j.targetDeviceId) devices.set(j.targetDeviceId, j.targetDeviceName ?? '历史探针')
  if (history?.profileId === profileId) for (const d of history?.devices ?? []) devices.set(d.id, d.remark || d.name)
  if (device && !devices.has(device)) devices.set(device, '原探针')
  return { jobs, devices, device, reports, report, reportId, snapshot, saving, saveError,
    pinned: state?.current?.qualityReportId, ready: history?.profileId === profileId && (!reportId || !!snapshot) && !saving && !historyError && !snapshotError,
    error: historyError || snapshotError, refresh: () => setAttempt(n => n + 1),
    selectDevice: (id: string) => persist(id ? { mode: 'device', deviceId: id } : { mode: 'latest' }),
    selectReport: (id: string) => persist(id ? { mode: 'fixed', reportId: id } : device ? { mode: 'device', deviceId: device } : { mode: 'latest' }) }
}

export function QualityBaselinePicker() {
  const { quality } = useProject()
  const selected = quality.jobs.find(j => j.id === quality.reportId)
  const saved = quality.report || (!quality.device && quality.pinned)
  return <div className="quality-report-picker">
    {quality.jobs.length || quality.devices.size || saved ? <div className="quality-baseline">
      <NativeSelect aria-label="质量基准探针" disabled={quality.saving} value={quality.device} onChange={e => void quality.selectDevice(e.target.value)}>
        <NativeSelectOption value="">全部探针</NativeSelectOption>{[...quality.devices].map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label="基准质量报告" disabled={quality.saving} value={quality.report} onChange={e => void quality.selectReport(e.target.value)}>
        <NativeSelectOption value="">跟随最新完成报告</NativeSelectOption>
        {saved && !quality.reports.some(j => j.id === saved) && <NativeSelectOption value={saved}>锁定快照 · {saved.slice(0, 8)}</NativeSelectOption>}
        {quality.reports.map(j => <NativeSelectOption key={j.id} value={j.id} title={formatTime(j.finishedAt)}>锁定 {reportTime(j.finishedAt)} · {j.targetDeviceName ?? '历史探针'} · {j.total} 个节点</NativeSelectOption>)}
      </NativeSelect>
    </div> : null}
    {quality.error ? <div className="actions" role="alert">{quality.error}<Button size="small" onClick={quality.refresh}>重新读取报告</Button></div> :
      (!quality.report || quality.saving) && <small className="quality-report-identity muted">{quality.saving ? '正在保存基准…' : selected ? formatTime(selected.finishedAt) + ' · ' + (selected.targetDeviceName ?? '历史探针') + ' · ' + selected.total + ' 个节点' :
        quality.reportId ? '保存的快照 · ' + quality.reportId.slice(0, 8) : quality.ready ? '暂无已完成报告' : '正在读取质量报告…'}</small>}
    {quality.saveError && <small role="alert" className="danger-text">{quality.saveError}</small>}
  </div>
}
