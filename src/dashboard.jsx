import { useEffect, useState } from 'react'
import { Activity, ArrowRight, Download, Eye, Filter, GitFork, History, KeyRound, Plus, RefreshCw, Server, ShieldAlert, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { Button as ButtonRoot } from '@/components/ui/button'
import { calendarFormatter, reminderKey, upcomingRenewals } from '../shared/subscription.js'
import { useProject } from './project.jsx'
import { Alert, Badge, Button, ButtonLink, CopyLinkButton, Empty, Panel, RouteLink, SourceStatus, TimeLabel, formatNumber, formatTime, versionKind, versionLabel } from './ui.jsx'

const stages = [
  ['sources', '启用机场'],
  ['nodes', '保留节点'],
  ['groups', '启用代理组'],
  ['rules', '有效规则'],
]

export function ConfigSummary({ counts, linked = false }) {
  return <dl className="config-summary" aria-label="配置数量">
    {stages.map(([key, label]) => <div key={key}>
      <dt>{linked ? <RouteLink page={key}>{label}</RouteLink> : label}</dt>
      <dd>{formatNumber(counts[key])}</dd>
    </div>)}
  </dl>
}

function Metric({ page, icon: Icon, label, value, detail, percent, live }) {
  return <RouteLink page={page} className="metric-card">
    <span className="metric-label"><Icon aria-hidden="true" />{label}</span>
    {percent != null && <span className="metric-percent">{percent}%</span>}
    <span className="metric-reading"><strong>{value}</strong>{detail && <small>{detail}</small>}</span>
    {live ? <span className="metric-live" aria-hidden="true" /> : <ArrowRight className="metric-arrow" aria-hidden="true" />}
    {percent != null && <progress className="retention-bar" max={100} value={percent} aria-hidden="true" />}
  </RouteLink>
}

function Metrics({ state, view }) {
  const { counts, originalNodes } = view
  const live = Boolean(state.current && state.hasLink)
  return <section className="metric-grid" aria-label="配置概况">
    <Metric page="sources" icon={Server} label="上游机场"
      value={formatNumber(counts.sources) + '/' + formatNumber(state.draft.sources.length)} detail={'启用 · ' + formatNumber(originalNodes) + ' 节点'} />
    <Metric page="nodes" icon={Filter} label="节点筛选池" value={formatNumber(counts.nodes)}
      detail={'/ ' + formatNumber(originalNodes)} percent={originalNodes ? Math.round(100 * counts.nodes / originalNodes) : null} />
    <Metric page="groups" icon={GitFork} label="策略与路由" value={formatNumber(counts.groups) + ' 组'} detail={'· ' + formatNumber(counts.rules) + ' 规则'} />
    <Metric page="publish" icon={Activity} label="FlClash 订阅" live={live}
      value={versionLabel(state.current)} detail={live ? '可拉取' : state.current ? '链接已撤销' : null} />
  </section>
}

const billingCalendar = calendarFormatter()

function RenewalReminders({ state }) {
  const { call } = useProject()
  const [today, setToday] = useState(() => billingCalendar.format(Date.now()))
  const [shown, setShown] = useState([])
  useEffect(() => {
    const updateDay = () => setToday(billingCalendar.format(Date.now()))
    const timer = setInterval(updateDay, 60000)
    document.addEventListener('visibilitychange', updateDay)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', updateDay)
    }
  }, [])

  const upcoming = upcomingRenewals(state.draft.sources, state.sources, billingCalendar, today)
  const dates = upcoming.map(reminderKey).join(',')
  useEffect(() => {
    if (!dates) return
    let requested = false
    let active = true
    let retry
    async function claim() {
      if (document.hidden || requested) return
      requested = true
      try {
        const reminders = await call('renewal-reminders', { timeZone: billingCalendar.resolvedOptions().timeZone, dates: dates.split(',') })
        if (reminders.length) setShown(previous => previous.concat(reminders.map(reminderKey)))
      } catch {
        requested = false
        if (active) retry = setTimeout(claim, 30000)
      }
    }
    claim()
    document.addEventListener('visibilitychange', claim)
    return () => {
      active = false
      clearTimeout(retry)
      document.removeEventListener('visibilitychange', claim)
    }
  }, [call, dates, today])

  const visible = upcoming.filter(item => shown.includes(reminderKey(item)))
  if (!visible.length) return null
  const title = visible.length > 1 ? '机场续费提醒 · ' + visible.length + ' 个机场' : '机场续费提醒'
  return <Alert tone="warning" title={title} action={<Button size="small" variant="ghost" onClick={() => setShown([])}>知道了</Button>}>
    <ul className="renewal-list">{visible.map(item => <li key={item.id}>
      <RouteLink page="sources" id={item.id} detail="renewal">{item.name}</RouteLink>
      {' · ' + (item.days === 0 ? '今天' : item.days + ' 天后') + (item.expire == null ? '续费' : '到期')}
      {'（'}<time dateTime={item.date}>{item.date}</time>{'）'}
    </li>)}</ul>
  </Alert>
}

function SubscriptionPanel({ state, view }) {
  const { pathFor } = useProject()
  const version = state.current
  const live = Boolean(version && state.hasLink)
  const firstSource = !state.draft.sources.length
  let heading, description, action

  if (version) {
    heading = '当前成品 ' + versionLabel(version)
    description = <>{versionKind(version)} · <TimeLabel value={version.at} /></>
  } else if (firstSource) {
    heading = '添加第一条机场订阅'
    description = '测试机场地址，选出要保留的节点。'
    action = <ButtonLink page="sources" id="new" icon={Plus} variant="primary">添加机场</ButtonLink>
  } else if (view.counts.nodes) {
    heading = '发布首个订阅'
    description = '发布后即可在 FlClash 中添加私有订阅链接。'
    action = <ButtonLink page="publish" icon={ArrowRight} variant="primary">检查与发布</ButtonLink>
  } else {
    const fetching = Object.values(state.sources).some(record => record.status === 'running' || record.status === 'queued')
    heading = fetching ? '正在获取节点' : '暂无可用节点'
    description = fetching ? '获取完成后可筛选节点并发布。' : '请检查机场状态和节点筛选条件。'
    action = <ButtonLink page="sources" icon={Server} variant="primary">查看订阅源</ButtonLink>
  }

  return <Panel className="subscription-panel"
    title={<span className="panel-title-line">FlClash 订阅入口
      {version && <Badge className="mono" tone={live ? 'success' : 'neutral'}>{live ? 'LIVE ' + versionLabel(version) : '已撤销'}</Badge>}</span>}
    actions={live && <span className="privacy-label"><ShieldCheck aria-hidden="true" />令牌已隐藏</span>}
    footer={<>
      <div className="actions">{action}
        {version && <ButtonRoot asChild variant="outline"><a href={pathFor('download')} download><Download data-icon="inline-start" aria-hidden="true" />下载 YAML</a></ButtonRoot>}
        {(version || firstSource) && <ButtonLink page="publish" icon={Eye}>{version && state.dirty ? '检查与发布' : '配置预览'}</ButtonLink>}
      </div>
      {version && <ButtonLink page="safety" icon={KeyRound}>管理链接</ButtonLink>}
    </>}>
    <div className="subscription-body">
      <div className="subscription-caption"><h3>{heading}</h3>{version && <small>{description}</small>}</div>
      {live ? <div className="subscription-address">
        <code aria-label="已遮挡的订阅地址">/sub/••••••••••••••••••••••••</code>
        <CopyLinkButton variant="ghost" size="small">复制</CopyLinkButton>
      </div> : <p className="muted">{version ? '私有链接已撤销，可在链接管理中重新生成。' : description}</p>}
    </div>
  </Panel>
}

const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const dayFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })

function RefreshTime({ label, value, empty }) {
  const date = value && new Date(value)
  return <div>
    <dt>{label}</dt>
    <dd>{date ? <time dateTime={value}><strong>{clockFormat.format(date)}</strong><small>{dayFormat.format(date)}</small></time>
      : <><strong>—</strong><small>{empty}</small></>}</dd>
  </div>
}

function RefreshPanel({ state }) {
  const { call, reload, notify } = useProject()
  const [busy, setBusy] = useState('')
  const records = [...Object.values(state.sources), ...Object.values(state.providers), ...state.publishedOnly]
  const active = records.filter(record => record.status === 'running' || record.status === 'queued').length
  const failed = records.filter(record => record.error).length
  const pending = records.filter(record => record.pending && !record.pending.accepted).length
  const latest = records.map(record => record.lastSuccess).filter(Boolean).sort().at(-1)
  const next = records.map(record => record.next).filter(Boolean).sort()[0]
  const canRefresh = state.draft.sources.some(source => !source.local && source.enabled) || state.publishedOnly.some(job => job.kind === 'source' && !job.local)
  let status = '待刷新', tone = 'neutral'
  if (active) { status = '刷新中'; tone = 'accent' }
  else if (failed) { status = formatNumber(failed) + ' 项异常'; tone = 'warning' }
  else if (pending) { status = formatNumber(pending) + ' 项待确认'; tone = 'warning' }
  else if (latest) { status = '刷新成功'; tone = 'success' }

  async function refresh(all) {
    setBusy(all ? 'all' : 'status')
    try {
      if (all) await call('refresh', {})
      await reload()
      notify(all ? '已请求刷新全部机场' : '状态已更新')
    } catch (error) { notify(error.message, 'danger') }
    finally { setBusy('') }
  }

  return <Panel title="刷新状态" actions={<Badge tone={tone}>{status}</Badge>}
    footer={<>
      <Button icon={RefreshCw} busy={busy === 'status'} disabled={Boolean(busy)} onClick={() => refresh(false)}>刷新状态</Button>
      <Button icon={RefreshCw} busy={busy === 'all'} disabled={Boolean(busy) || !canRefresh || active > 0} onClick={() => refresh(true)}>更新全部机场</Button>
    </>}>
    <div className="refresh-body">
      <dl className="refresh-times">
        <RefreshTime label="最近成功" value={latest} empty="暂无记录" />
        <RefreshTime label="下次计划" value={next} empty="未安排" />
      </dl>
      <RouteLink page="updates" className="refresh-history"><History aria-hidden="true" />查看更新记录
        {state.unread && <Badge tone="accent">有新记录</Badge>}<ArrowRight aria-hidden="true" /></RouteLink>
    </div>
  </Panel>
}

function SourcesPanel({ state, view }) {
  const stats = new Map(view.sources.map(source => [source.id, source]))
  return <Panel title="机场节点占比" className="source-share-panel" actions={<RouteLink page="sources" className="panel-link">管理全部 <ArrowRight aria-hidden="true" /></RouteLink>}>
    {state.draft.sources.length ? <ul className="source-shares">{state.draft.sources.slice(0, 6).map(source => {
      const { retained, original } = stats.get(source.id)
      const record = state.sources[source.id]
      return <li key={source.id}>
        <div className="source-identity">
          <RouteLink className="source-name" page="sources" id={source.id}>{source.name}</RouteLink>
          {source.tag && <span className="source-tag-chip mono">{source.tag}</span>}
          <span title={'最近成功：' + formatTime(record?.lastSuccess)}><SourceStatus entry={source} record={record} /></span>
        </div>
        <progress className="retention-bar" max={original || 1} value={retained} aria-label={source.name + ' 节点保留比例'} />
        <span className="source-ratio mono">{formatNumber(retained)}/{formatNumber(original)}</span>
        <ButtonLink page="sources" id={source.id} detail="filter" icon={SlidersHorizontal} size="small" aria-label={'筛选 ' + source.name}>筛选</ButtonLink>
      </li>
    })}</ul> : <Empty icon={Server} title="尚未添加订阅源" detail="添加机场后，可在此查看节点保留比例。" />}
  </Panel>
}

function PreflightPanel({ state, view }) {
  const { counts, issues } = view
  const dns = state.draft.base.dns
  const checks = [
    { page: 'nodes', label: '保留节点', value: formatNumber(counts.nodes) + ' 个节点', panes: ['sources', 'nodes'] },
    { page: 'groups', label: '代理组', value: formatNumber(counts.groups) + ' 个启用', panes: ['groups'] },
    { page: 'rules', label: '分流规则', value: formatNumber(counts.rules) + ' 条有效', panes: ['rules'] },
    { page: 'settings', label: '基础配置', value: dns.enabled ? dns.mode : 'DNS 已关闭', panes: ['settings'] },
  ]
  const errors = issues.filter(issue => issue.severity === 'error').length
  return <Panel title="配置预检" actions={errors ? <Badge tone="danger">{formatNumber(errors)} 项错误</Badge>
    : issues.length ? <Badge tone="warning">{formatNumber(issues.length)} 项提醒</Badge> : <Badge tone="success">未发现问题</Badge>}>
    <ul className="preflight-grid">{checks.map(check => {
      const matches = issues.filter(issue => check.panes.includes(issue.pane))
      const errorCount = matches.filter(issue => issue.severity === 'error').length
      const first = matches.find(issue => issue.severity === 'error') ?? matches[0]
      const Icon = first ? ShieldAlert : ShieldCheck
      return <li key={check.page}><RouteLink page={first?.pane ?? check.page} id={first?.id} detail={first?.relatedId}
        data-tone={errorCount ? 'danger' : first ? 'warning' : 'success'} title={first?.message}>
        <Icon aria-hidden="true" /><span><small>{check.label}</small>
          <strong>{errorCount ? formatNumber(errorCount) + ' 项错误' : first ? formatNumber(matches.length) + ' 项提醒' : check.value}</strong></span>
      </RouteLink></li>
    })}</ul>
  </Panel>
}

export function Dashboard() {
  const { state, view } = useProject()
  return <div className="overview">
    <h1 className="sr-only" tabIndex={-1}>订阅工作台</h1>
    <RenewalReminders state={state} />
    <Metrics state={state} view={view} />
    <div className="overview-panels">
      <SubscriptionPanel state={state} view={view} />
      <RefreshPanel state={state} />
      <SourcesPanel state={state} view={view} />
      <PreflightPanel state={state} view={view} />
    </div>
  </div>
}
