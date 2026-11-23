import { useEffect, useRef, useState } from 'react'
import { Activity, Laptop, Plus } from 'lucide-react'
import { ProbeSetup } from './probe-setup.tsx'
import { maxQualityNodes, qualityDefaults } from '../shared/quality-options.ts'
import type { ProbeDevice, Progress, QualityConfig, QualityJob, QualityReport } from '../shared/quality.ts'
import { useProject } from './project.tsx'
import { Alert, Badge, Button, Field, FieldGroup, Modal, NativeSelect, NativeSelectOption, Toggle, formatTime } from './ui.tsx'
import { ReportView, byteSize } from './quality-report.tsx'
import { asError } from './errors.ts'

const jobNames: Record<QualityJob['status'], string> = { waiting: '等待探针', running: '检测中', completed: '已完成', failed: '检测失败', expired: '任务已过期', cancelled: '已取消' }
const stageNames: Record<Progress['stage'], string> = { starting: '启动独立核心', latency: '采样延迟与出口', bandwidth: '测试下载速度', ai: '检查 AI 平台', uploading: '上传检测结果' }
const historyTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const live = (job: QualityJob) => job.status === 'waiting' || job.status === 'running'
function NumberChoice({ label, value, options, onChange, unit = '' }: { label: string; value: number; options: number[]; onChange: (n: number) => void; unit?: string }) {
  return <Field label={label}><NativeSelect value={value} onChange={e => onChange(Number(e.target.value))}>{options.map(n => <NativeSelectOption key={n} value={n}>{n}{unit}</NativeSelectOption>)}</NativeSelect></Field>
}
function QualityDialog({ selected, filtered, close }: { selected: string[]; filtered: string[]; close: () => void }) {
  const { call } = useProject()
  const [jobs, setJobs] = useState<QualityJob[] | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [device, setDevice] = useState<ProbeDevice | null>(null)
  const [report, setReport] = useState<QualityReport | null>(null)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [reportError, setReportError] = useState('')
  const readError = listError || reportError
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState(selected.length ? 'selected' : 'filtered')
  const [config, setConfig] = useState<QualityConfig>({ ...qualityDefaults })
  const serial = useRef(0)
  const keys = scope === 'selected' ? selected : filtered
  const job = focus === 'new' ? null : jobs?.find(item => item.id === focus) ?? jobs?.[0] ?? null
  const activeJob = jobs?.find(live)
  const newForm = !!jobs && !job
  const set = <K extends keyof QualityConfig>(key: K, value: QualityConfig[K]) => setConfig(c => ({ ...c, [key]: value }))
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      const order = serial.current
      try {
        const [next, computer] = await Promise.all([call('quality/jobs'), call('quality/device')])
        if (!active || order !== serial.current) return
        setListError('')
        setJobs(next)
        setDevice(computer)
        timer = setTimeout(poll, next.some(live) ? 2500 : 8000)
      } catch (cause) {
        if (active && order === serial.current) { setListError(asError(cause).message); timer = setTimeout(poll, 5500) }
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [call, refresh])
  useEffect(() => {
    let active = true
    setReport(null)
    setReportError('')
    if (job?.status === 'completed') call(`quality/report?id=${job.id}`)
      .then(value => { if (active) setReport(value) }).catch(cause => { if (active) setReportError(asError(cause).message) })
    return () => { active = false }
  }, [job?.id, job?.status, call, refresh])
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); serial.current++
    try { await work() } catch (cause) { setError(asError(cause).message) }
    finally { setBusy(false); setRefresh(v => v + 1) }
  }
  function receive(value: QualityJob) {
    setFocus(value.id)
    setJobs(current => [value, ...(current ?? []).filter(j => j.id !== value.id)])
  }
  const blocked = !keys.length || keys.length > maxQualityNodes || Boolean(activeJob)
  return <Modal title="节点质量检测" detail="从个人电脑的网络环境测量节点。" wide={job?.status === 'completed'} onClose={close}
    footer={newForm ? <><span className="quality-footer-note">{keys.length} 个节点{config.bandwidth && ' · 下载最多 ' + byteSize(keys.length * config.mebibytes * 1024 ** 2)}</span>
      <Button variant="primary" icon={Activity} busy={busy} disabled={blocked} onClick={() => action(async () => receive(await call('quality/queue', { keys, config })))}>创建检测任务</Button></> : undefined}>
    <div className="quality-workspace">
      {!!jobs?.length && <div className="quality-history"><NativeSelect aria-label="检测记录" value={job?.id ?? 'new'} onChange={e => { setFocus(e.target.value); setError('') }}>
        {newForm && <NativeSelectOption value="new">新建检测</NativeSelectOption>}
        {jobs.map(j => <NativeSelectOption key={j.id} value={j.id}>{jobNames[j.status]} · {j.total} 个节点 · {historyTime.format(new Date(j.createdAt))}</NativeSelectOption>)}</NativeSelect>
        {!newForm && !activeJob && <Button icon={Plus} size="small" onClick={() => { setFocus('new'); setError('') }}>新建检测</Button>}</div>}
      {error && <Alert tone="danger">{error}</Alert>}
      {readError && <Alert tone="danger" action={<Button size="small" onClick={() => setRefresh(v => v + 1)}>重新读取</Button>}>{readError}</Alert>}
      {!jobs && !readError && <p role="status" className="muted">正在读取检测记录…</p>}
      {newForm && <>
        <div className="quality-heading"><div><h3 className="quality-title">检测范围</h3><p className="muted">探针仅领取本次范围内的节点连接参数。</p></div>
          <NativeSelect aria-label="检测范围" value={scope} onChange={e => setScope(e.target.value)}>
            {!!selected.length && <NativeSelectOption value="selected">已勾选 · {selected.length} 个</NativeSelectOption>}
            <NativeSelectOption value="filtered">当前筛选 · {filtered.length} 个</NativeSelectOption>
          </NativeSelect></div>
        {blocked && <Alert tone="warning">{activeJob ? '请先完成或取消当前任务。' : !keys.length ? '当前范围没有节点，请先导入节点或调整筛选。' : '单次最多检测 ' + maxQualityNodes + ' 个节点，请缩小范围。'}</Alert>}
        <section className="quality-section"><h3>延迟与出口</h3><p className="muted">每个节点先预热一次，再统计 TLS 握手、HTTPS 延迟和请求丢包率。</p>
          <FieldGroup className="form-grid"><NumberChoice label="采样轮数" value={config.rounds} options={[2, 3, 5, 8]} onChange={n => set('rounds', n)} unit=" 轮" />
            <NumberChoice label="并行节点数" value={config.concurrency} options={[1, 3, 6, 8, 12]} onChange={n => set('concurrency', n)} /></FieldGroup></section>
        <section className="quality-section"><Toggle label="下载测速" checked={config.bandwidth} onChange={v => set('bandwidth', v)} detail="仅测可用节点，达到时长或流量上限即停止。" />
          {config.bandwidth && <FieldGroup className="form-grid three"><NumberChoice label="单节点流量" value={config.mebibytes} options={[1, 2, 4, 8, 16, 32]} unit=" MiB" onChange={n => set('mebibytes', n)} />
            <NumberChoice label="最长时长" value={config.seconds} options={[2, 5, 10, 15]} unit=" 秒" onChange={n => set('seconds', n)} />
            <NumberChoice label="下载并发" value={config.speedConcurrency} options={[1, 2]} onChange={n => set('speedConcurrency', n)} /></FieldGroup>}</section>
        <section className="quality-section"><Toggle label="AI 平台检测" checked={config.ai} onChange={v => set('ai', v)} detail="检查 ChatGPT、Gemini、Claude 与 Grok。相同出口 IP 共享结果。" /></section>
      </>}
      {job?.status === 'waiting' && <>
        <div className="quality-heading"><div><h3 className="quality-title"><Laptop />等待探针自动领取</h3>
          <p className="muted">{job.total} 个节点 · 任务保留至 {formatTime(job.expiresAt)}</p></div><Badge tone="warning">已排队</Badge></div>
        <Button size="small" variant="ghost" disabled={busy} onClick={() => action(async () => { await call('quality/cancel', { id: job.id }) })}>取消任务</Button>
      </>}
      {job?.status === 'running' && <div className="quality-running" role="status"><div className="quality-heading"><h3 className="quality-title">{stageNames[job.progress.stage]}</h3><Badge tone="success" dot>探针已连接</Badge></div>
        <progress aria-label="本阶段检测进度" max={Math.max(1, job.progress.total)} value={job.progress.done} /><p>{job.progress.done} / {job.progress.total} {job.progress.stage === 'ai' ? '个出口' : '个节点'} · 关闭面板后检测会继续。</p>
        <Button size="small" busy={busy} onClick={() => action(async () => { await call('quality/cancel', { id: job.id }) })}>取消任务</Button></div>}
      {job?.status === 'completed' && (report?.jobId === job.id ? <ReportView key={job.id} report={report} /> : !readError && <p role="status">正在读取报告…</p>)}
      {job && !live(job) && job.status !== 'completed' && <Alert tone={job.status === 'failed' ? 'danger' : 'info'} title={jobNames[job.status]}>
        {job.failure === 'disconnected' ? '服务端已超过两分钟未收到探针进度。' : job.failure === 'probe_error' ? '请查看电脑上的服务日志，再创建检测任务。' : '可用当前节点范围重新创建任务。'}</Alert>}
      {jobs && <ProbeSetup device={device} waiting={job?.status === 'waiting'} refresh={() => setRefresh(v => v + 1)} />}
    </div>
  </Modal>
}
export function QualityControl({ selected, filtered }: { selected: string[]; filtered: string[] }) {
  const [open, setOpen] = useState(false)
  return <><Button icon={Activity} size="small" onClick={() => setOpen(true)}>质量检测</Button>
    {open && <QualityDialog selected={selected} filtered={filtered} close={() => setOpen(false)} />}</>
}
