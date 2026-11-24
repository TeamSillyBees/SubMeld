import { useEffect, useState } from 'react'
import { Activity, Filter, Laptop } from 'lucide-react'
import type { QualityJob, QualityReport } from '../shared/quality.ts'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { asError } from './errors.ts'
import { ProbeSetupBody } from './probe-setup.tsx'
import { useProject } from './project.tsx'
import { canQueue, historyTime, jobNames, live, stageNames, useQualityWorkspace } from './quality.tsx'
import { ReportView } from './quality-report.tsx'
import { QualitySchedulePanel } from './quality-schedule.tsx'
import { Alert, Badge, Button, ButtonLink, Empty, NativeSelect, NativeSelectOption, PageTitle, Panel, formatTime } from './ui.tsx'

type QualityTab = 'schedules' | 'reports' | 'probes'

function resolveTab(route: { id?: string; params: URLSearchParams }): QualityTab {
  if (route.id === 'schedules' || route.id === 'reports' || route.id === 'probes') return route.id
  const param = route.params.get('tab')
  if (param === 'reports' || param === 'probes') return param
  return 'schedules'
}

export function QualityPage() {
  const { call, route, navigate, quality } = useProject()
  const tab = resolveTab(route)
  const { jobs, setJobs, devices, listError, refresh, serial } = useQualityWorkspace()
  const [selectedJobId, setSelectedJobId] = useState<string>(route.detail ?? '')
  const [replacement, setReplacement] = useState('')
  const [report, setReport] = useState<QualityReport | null>(null)
  const [reportError, setReportError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (route.detail) setSelectedJobId(route.detail)
  }, [route.detail])

  const job = (jobs?.find(item => item.id === (route.detail || selectedJobId)) ?? jobs?.[0] ?? null)
  const eligible = devices.filter(canQueue)
  const alternatives = eligible.filter(d => d.id !== job?.targetDeviceId)

  useEffect(() => {
    let active = true
    setReport(null)
    setReportError('')
    if (tab === 'reports' && job?.status === 'completed') {
      call(`quality/report?id=${job.id}`)
        .then(value => { if (active) { setReport(value); quality.refresh() } })
        .catch(cause => { if (active) setReportError(asError(cause).message) })
    }
    return () => { active = false }
  }, [tab, job?.id, job?.status, call, quality.refresh])

  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    serial.current++
    try { await work() }
    catch (cause) { setError(asError(cause).message) }
    finally { setBusy(false); refresh() }
  }

  function receive(value: QualityJob) {
    setSelectedJobId(value.id)
    setJobs(current => [value, ...(current ?? []).filter(j => j.id !== value.id)])
    void navigate('quality', 'reports', value.id)
  }

  return <div className="stack config-page">
    <PageTitle
      title="质量检测"
      detail="配置常规与 AI 解锁定时检测、查看检测报告并管理常驻探针。"
      actions={<ButtonLink page="nodes" size="small" icon={Filter}>前往节点管理</ButtonLink>}
    />

    <Tabs value={tab} activationMode="manual" onValueChange={next => { if (next !== tab) void navigate('quality', next) }}>
      <TabsList aria-label="质量检测功能" className="quality-tabs">
        <TabsTrigger value="schedules">定时任务</TabsTrigger>
        <TabsTrigger value="reports">检测报告</TabsTrigger>
        <TabsTrigger value="probes">探针管理</TabsTrigger>
      </TabsList>

      <TabsContent value="schedules">
        <QualitySchedulePanel
          devices={devices}
          jobs={jobs}
          refresh={refresh}
          onOpenJob={jobId => {
            setSelectedJobId(jobId)
            void navigate('quality', 'reports', jobId)
          }}
          onOpenProbes={() => void navigate('quality', 'probes')}
        />
      </TabsContent>

      <TabsContent value="reports">
        <Panel
          title="检测报告"
          count={jobs ? jobs.length : undefined}
          detail="查看定时与手动检测任务的执行进度及节点测速、解锁结果。"
        >
          <div className="panel-padding stack">
            {error && <Alert tone="danger">{error}</Alert>}
            {(listError || reportError) && (
              <Alert tone="danger" action={<Button size="small" onClick={refresh}>重新读取</Button>}>
                {listError || reportError}
              </Alert>
            )}
            {!jobs && !listError && <p role="status" className="muted">正在读取检测记录…</p>}
            {jobs && !jobs.length && (
              <Empty
                icon={Activity}
                title="暂无质量检测报告"
                detail="可在定时任务页立即触发常规/AI 检测，或前往节点管理手动发起检测。"
                actions={<>
                  <Button variant="primary" onClick={() => void navigate('quality', 'schedules')}>前往定时任务</Button>
                  <ButtonLink page="nodes">前往节点管理</ButtonLink>
                </>}
              />
            )}
            {jobs && jobs.length > 0 && job && <>
              <div className="quality-history">
                <NativeSelect
                  aria-label="选择检测任务"
                  value={job.id}
                  onChange={e => {
                    setSelectedJobId(e.target.value)
                    setError('')
                    void navigate('quality', 'reports', e.target.value)
                  }}
                >
                  {jobs.map(j => (
                    <NativeSelectOption key={j.id} value={j.id}>
                      {(j.trigger === 'schedule' ? '[定时] ' : '') + jobNames[j.status] + ' · ' + (j.targetDeviceName || '历史任务') + ' · ' + j.total + ' 个节点 · ' + historyTime.format(new Date(j.createdAt))}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <div className="actions">
                  {job.trigger === 'schedule' && <Badge tone="accent">定时任务</Badge>}
                  {job.config.basic && <Badge tone="neutral">常规检测</Badge>}
                  {job.config.bandwidth && <Badge tone="neutral">下载测速</Badge>}
                  {job.config.ai && <Badge tone="neutral">AI 解锁</Badge>}
                  <Badge tone={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : live(job) ? 'warning' : 'neutral'}>
                    {jobNames[job.status]}
                  </Badge>
                </div>
              </div>

              <p className="field-note muted quality-job-origin">
                {job.targetDeviceName || (job.status === 'waiting' ? '待指定探针' : '历史探针')} · {formatTime(job.createdAt)} · {job.total} 个节点
              </p>

              {job.status === 'waiting' && <>
                <div className="quality-heading">
                  <div>
                    <h3 className="quality-title"><Laptop aria-hidden="true" />等待{job.targetDeviceName ? ' ' + job.targetDeviceName + ' 执行' : '改派探针'}</h3>
                    <p className="muted">{job.total} 个节点 · 任务保留至 {formatTime(job.expiresAt)}</p>
                  </div>
                  <Badge tone="warning">已排队</Badge>
                </div>
                <div className="actions">
                  {alternatives.length > 0 && <>
                    <NativeSelect aria-label="改派在线探针" value={replacement} onChange={e => setReplacement(e.target.value)}>
                      <NativeSelectOption value="">选择在线探针</NativeSelectOption>
                      {alternatives.map(d => <NativeSelectOption key={d.id} value={d.id}>{d.remark || d.name}</NativeSelectOption>)}
                    </NativeSelect>
                    <Button size="small" disabled={!alternatives.some(d => d.id === replacement) || busy} onClick={() => void action(async () => {
                      receive(await call('quality/reassign', { id: job.id, targetDeviceId: replacement }))
                      setReplacement('')
                    })}>改派任务</Button>
                  </>}
                  <Button size="small" variant="ghost" disabled={busy} onClick={() => void action(async () => { await call('quality/cancel', { id: job.id }) })}>
                    取消任务
                  </Button>
                </div>
              </>}

              {job.status === 'running' && (
                <div className="quality-running" role="status">
                  <div className="quality-heading">
                    <h3 className="quality-title">{stageNames[job.progress.stage]}</h3>
                    <Badge tone="success" dot>探针已连接</Badge>
                  </div>
                  <progress aria-label="本阶段检测进度" max={Math.max(1, job.progress.total)} value={job.progress.done} />
                  <p>{job.progress.done} / {job.progress.total} 项 · 离开此页后检测会在后台继续。</p>
                  <Button size="small" busy={busy} onClick={() => void action(async () => { await call('quality/cancel', { id: job.id }) })}>
                    取消任务
                  </Button>
                </div>
              )}

              {job.status === 'completed' && (
                report?.jobId === job.id
                  ? <ReportView key={job.id} report={report} />
                  : !reportError && <p role="status" className="muted">正在读取报告…</p>
              )}

              {!live(job) && job.status !== 'completed' && (
                <Alert tone={job.status === 'failed' ? 'danger' : 'info'} title={jobNames[job.status]}>
                  {job.failure === 'disconnected'
                    ? '服务端已超过两分钟未收到探针进度。'
                    : job.failure === 'probe_error'
                      ? '请查看电脑上的服务日志，再重新发起任务。'
                      : '可在定时任务页或节点管理页重新发起检测。'}
                </Alert>
              )}
            </>}
          </div>
        </Panel>
      </TabsContent>

      <TabsContent value="probes">
        <Panel
          title="常驻探针管理"
          count={devices.length}
          detail="安装、配对或管理执行定时与手动检测的个人电脑探针。"
        >
          <div className="panel-padding stack">
            {listError && (
              <Alert tone="danger" action={<Button size="small" onClick={refresh}>重新读取</Button>}>
                {listError}
              </Alert>
            )}
            <ProbeSetupBody devices={devices} refresh={refresh} />
          </div>
        </Panel>
      </TabsContent>
    </Tabs>
  </div>
}
