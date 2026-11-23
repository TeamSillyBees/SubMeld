import { useEffect, useState } from 'react'
import type { QualityJob } from '../shared/quality.ts'
import type { QualitySnapshot } from '../shared/quality-snapshot.ts'
import type { Call } from './api.ts'
import { useProject } from './project.tsx'
import { Button, NativeSelect, NativeSelectOption, formatTime } from './ui.tsx'
import { asError } from './errors.ts'

const reportTime = (time?: string | null) => time ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time)) : '—'

export function useQualityBaseline(profileId: string | undefined, call: Call, pinnedId?: string | null) {
  const [history, setHistory] = useState<{ profileId: string; jobs: QualityJob[] }>()
  const [selection, setSelection] = useState({ profileId: '', device: '', report: '' })
  const [data, setData] = useState<{ profileId: string; snapshot: QualitySnapshot }>()
  const [historyError, setHistoryError] = useState('')
  const [snapshotError, setSnapshotError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!profileId) return
    const id = profileId
    let alive = true, timer: ReturnType<typeof setTimeout>
    setHistoryError('')
    async function refresh() {
      try {
        const list = await call('quality/jobs')
        if (!alive) return
        const jobs = list.filter(j => j.status === 'completed').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
        setHistory(prev => prev?.profileId === id && prev.jobs.length === jobs.length && prev.jobs.every((j, i) => j.id === jobs[i].id) ? prev : { profileId: id, jobs })
        setHistoryError('')
      } catch (e) { if (alive) setHistoryError(asError(e).message) }
      if (alive) timer = setTimeout(refresh, 8000)
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [call, profileId, attempt])
  const jobs = history?.profileId === profileId ? history?.jobs ?? [] : []
  const chosen = selection.profileId === profileId ? selection : null
  const device = jobs.some(j => (j.targetDeviceId ?? 'legacy') === chosen?.device) ? chosen!.device : ''
  const reports = jobs.filter(j => !device || (j.targetDeviceId ?? 'legacy') === device)
  const pinned = !device && pinnedId ? pinnedId : null
  const report = chosen?.report && (reports.some(j => j.id === chosen.report) || chosen.report === pinned) ? chosen.report : ''
  const reportId = report || reports[0]?.id || pinned
  useEffect(() => {
    let alive = true
    setSnapshotError('')
    if (profileId && reportId) call(`quality/snapshot?id=${reportId}`).then(snapshot => {
      if (alive) setData({ profileId, snapshot })
    }).catch(e => { if (alive) setSnapshotError(asError(e).message) })
    return () => { alive = false }
  }, [call, profileId, reportId, attempt])
  const snapshot = data && data.profileId === profileId && data.snapshot.reportId === reportId ? data.snapshot : null
  return { jobs, device, reports, report, reportId, pinned, snapshot, ready: history?.profileId === profileId && (!reportId || !!snapshot) && !historyError && !snapshotError,
    error: historyError || snapshotError, refresh: () => setAttempt(n => n + 1),
    selectDevice: (device: string) => setSelection({ profileId: profileId!, device, report: '' }),
    selectReport: (report: string) => setSelection({ profileId: profileId!, device: !report || reports.some(j => j.id === report) ? device : '', report }) }
}

export function QualityBaselinePicker() {
  const { quality } = useProject()
  const devices = new Map([...quality.jobs].reverse().map(j => [j.targetDeviceId ?? 'legacy', j.targetDeviceName ?? '历史探针']))
  if (quality.error) return <div className="actions" role="alert">{quality.error}<Button size="small" onClick={quality.refresh}>重新读取报告</Button></div>
  if (!quality.jobs.length && !quality.pinned) return <span className="muted">{quality.ready ? '暂无已完成报告' : '正在读取质量报告…'}</span>
  const selected = quality.jobs.find(j => j.id === quality.reportId)
  return <div className="quality-report-picker"><div className="quality-baseline">
    <NativeSelect aria-label="质量基准探针" value={quality.device} onChange={e => quality.selectDevice(e.target.value)}>
      <NativeSelectOption value="">全部探针</NativeSelectOption>{[...devices].map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
    </NativeSelect>
    <NativeSelect aria-label="基准质量报告" value={quality.report} onChange={e => quality.selectReport(e.target.value)}>
      <NativeSelectOption value="">{quality.reports.length ? '最新完成 · ' + reportTime(quality.reports[0]?.finishedAt) : '当前线上版本的报告'}</NativeSelectOption>
      {quality.pinned && !quality.reports.some(j => j.id === quality.pinned) && <NativeSelectOption value={quality.pinned}>线上版本 · {quality.pinned.slice(0, 8)}</NativeSelectOption>}
      {quality.reports.map(j => <NativeSelectOption key={j.id} value={j.id} title={formatTime(j.finishedAt)}>{reportTime(j.finishedAt)} · {j.targetDeviceName ?? '历史探针'} · {j.total} 个节点</NativeSelectOption>)}
    </NativeSelect>
  </div>{selected && <small className="quality-report-identity muted">{formatTime(selected.finishedAt)} · {selected.targetDeviceName ?? '历史探针'} · {selected.total} 个节点</small>}</div>
}
