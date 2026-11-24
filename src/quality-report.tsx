import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Download, Network } from 'lucide-react'
import { aiSkipReason, surfaces, surfaceNames } from '../shared/quality-options.ts'
import type { AiReading, AvailabilityStats, LatestNodeQuality, QualityReport } from '../shared/quality.ts'
import { getAiDisplayStatus, inferredExitRegion } from '../shared/quality-snapshot.ts'
import { AiUnlockCell, AvailabilityReading, stateLabels } from './node-quality.tsx'
import { useProject } from './project.tsx'
import { Badge, Button, Empty, NativeSelect, NativeSelectOption, Pager, SearchBox, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, downloadJson, usePage } from './ui.tsx'

type Row = QualityReport['results'][number]
const ms = (n: number | null) => n === null ? '—' : n.toLocaleString() + ' ms'
const loss = (n: number | null) => n === null ? '—' : Math.round(n * 1000) / 10 + '%'
export function byteSize(bytes: number) {
  if (bytes >= 1024 ** 3) return Number((bytes / 1024 ** 3).toFixed(2)) + ' GiB'
  if (bytes >= 1024 ** 2) return Number((bytes / 1024 ** 2).toFixed(2)) + ' MiB'
  if (bytes >= 1024) return Number((bytes / 1024).toFixed(1)) + ' KiB'
  return bytes + ' B'
}
const speed = (rate: number) => byteSize(rate) + '/s'
const evidenceLabels: Record<AiReading['evidence'], string> = {
  compliance_json: '合规接口返回有效 JSON', app_gateway: '应用网关已响应', http_denied: '入口拒绝请求或返回故障提示',
  web_entry: '识别到产品入口页', login_redirect: '入口转向登录页', credentials_required: '接口返回认证要求',
  region_denied: '平台响应或地区政策表明该地区受限', region_disagrees: 'Google 识别地区与出口地区不同',
  region_unconfirmed: '无法确认个人账号适用地区', cf_challenge: '响应要求浏览器验证', ip_denied: '服务明确封禁出口 IP',
  region_policy: '平台地区命中受限地区表', exit_region_fallback: '按通用出口和其他平台的一致地区推定',
  bot_challenge: 'Google 要求验证异常流量', consent_redirect: '入口转向 Google 同意页', disallowed_isp: '网关明确限制运营商、VPN 或代理',
  rate_limit: '服务要求降低请求频率', unrecognized: '响应缺少明确判据', network: '请求失败或超时',
}
const hasReview = (row: Row) => Boolean(row.ai && Object.values(row.ai).some(v => v?.needsReview))
function exitLabel(row: Row) {
  const inferred = inferredExitRegion(row)
  const region = row.exit?.region ?? (inferred ? '推定 ' + inferred : null)
  return [region, row.exit?.ip].filter(Boolean).join(' · ')
}
function latencyError(row: Row) {
  if (row.error === 'info_node') return '已跳过订阅流量或到期提示条目。'
  if (row.error === 'invalid_node') return '独立核心无法加载此节点配置。'
  if (row.error === 'unexpected_status') return '目标已响应，但返回了 204 以外的状态码。'
  if (row.error === 'https_no_response') return 'TLS 握手成功，随后未收到 HTTPS 响应头。'
  return row.tlsMedianMs != null ? 'TLS 握手成功，本次未取得 HTTPS 204。' : '本次采样均未完成 TLS 握手。'
}
function Metrics({ values }: { values: [string, string][] }) {
  return <dl className="quality-metrics">{values.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
}
function NodeDetail({ row, availability, back }: { row: Row; availability?: AvailabilityStats | null; back: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const body = heading.current?.closest('.workspace-dialog-body')
    if (body) body.scrollTop = 0
    else window.scrollTo(0, 0)
    heading.current?.focus({ preventScroll: true })
  }, [])
  const endReason = { bytes: '达到流量上限', duration: '达到时长上限', end: '下载完成', error: '下载中断' }
  const exitRegion = row.exit?.region ?? inferredExitRegion(row)
  return <div className="quality-detail">
    <Button size="small" variant="ghost" icon={ArrowLeft} onClick={back}>返回检测结果</Button>
    <div><h3 className="quality-title" translate="no" ref={heading} tabIndex={-1}>{row.name}</h3><p className="muted">{row.sourceName} · {exitLabel(row) || '未采集到出口'}</p></div>
    {row.error && <p>{latencyError(row)}</p>}
    {row.aiSkipped && <p className="muted">{row.aiSkipped === 'missing_exit' ? '未获取出口 IP，已跳过 AI 检测。' : '连接丢包过高或延迟过长，已跳过 AI 检测。'}</p>}
    {row.ai && aiSkipReason(row) && <p className="muted">此线路达到弱网阈值，工作台仅保留历史 AI 读数供参考。</p>}
    <Metrics values={[
      ['TLS 握手中位数', ms(row.tlsMedianMs)],
      ['HTTPS 延迟中位数', ms(row.httpsMedianMs)],
      ['HTTPS 抖动', ms(row.jitterMs)],
      ['请求丢包率', loss(row.lossRate)],
      ...(availability && availability.total > 0
        ? [['历史可用率', `${Number((availability.rate * 100).toFixed(1))}%（${availability.success}/${availability.total} 次）`] as [string, string]]
        : []),
    ]} />
    {!!row.samples.length && <div><h4>各轮采样</h4><ol className="quality-samples">{row.samples.map((s, i) => <li key={i}>第 {i + 1} 轮 <span>TLS {ms(s.tlsMs)} · HTTPS {s.httpsMs === null ? s.httpStatus ?? '失败' : ms(s.httpsMs)}</span></li>)}</ol></div>}
    {row.speed && <section><h4>流式下载</h4>
      <Metrics values={[['平均速度', speed(row.speed.averageBps)], ['最高速度', speed(row.speed.peakBps)], ['下载流量', byteSize(row.speed.bytes)], ['用时', (row.speed.elapsedMs / 1000).toFixed(2) + ' s']]} />
      <p className="muted">{endReason[row.speed.stop]} · 各秒速率</p>
      <ol className="quality-samples">{row.speed.perSecondBps.map((rate, i) => <li key={i}>第 {i + 1} 秒 <span>{speed(rate)}</span></li>)}</ol>
    </section>}
    {row.ai && <section><h4>AI 平台</h4>
      <div className="quality-ai">{surfaces.map(surface => {
        const a = row.ai?.[surface]
        const status = getAiDisplayStatus(a, exitRegion)
        return <div key={surface}>
          <strong>{surfaceNames[surface]}</strong>
          <span className="quality-ai-detail">
            {status && <Badge tone={status.tone}>{status.label}</Badge>}
            <small>{a ? `${stateLabels[a.state]} · ${evidenceLabels[a.evidence]}${a.httpStatus ? ' · HTTP ' + a.httpStatus : ''}${a.providerRegion ? ' · 平台地区 ' + a.providerRegion : ''}${a.needsReview ? ' · 需复核' : ''}` : '未检测'}</small>
          </span>
        </div>
      })}</div>
    </section>}
  </div>
}
export function ReportView({ report, latestRows }: { report: QualityReport; latestRows?: Record<string, LatestNodeQuality> }) {
  const { quality } = useProject()
  const latest = latestRows ?? (report.targetDeviceId ? quality.latest[report.targetDeviceId] : undefined)
  const hasAvailability = Boolean(latest && report.results.some(r => (latest[r.key]?.availability?.total ?? 0) > 0))
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('latency')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<Row | null>(null)
  const resultList = useRef<HTMLDivElement>(null)
  const previous = useRef<{ key: string; top: number } | null>(null)
  useLayoutEffect(() => {
    if (detail || !previous.current || !resultList.current) return
    const { key, top } = previous.current
    const body = resultList.current.closest('.workspace-dialog-body')
    if (body) body.scrollTop = top
    else window.scrollTo(0, top)
    resultList.current.querySelector<HTMLButtonElement>('[data-result-key="' + CSS.escape(key) + '"]')?.focus({ preventScroll: true })
    previous.current = null
  }, [detail])
  function inspect(row: Row) {
    previous.current = { key: row.key, top: resultList.current?.closest('.workspace-dialog-body')?.scrollTop ?? window.scrollY }
    setDetail(row)
  }
  const available = report.results.filter(r => r.available).length
  const reviews = report.results.filter(hasReview).length
  const exits = new Set(report.results.flatMap(r => r.exit ? [r.exit.ip] : []))
  const testedExits = new Set(report.results.flatMap(r => r.exit && r.ai ? [r.exit.ip] : []))
  const reviewExits = new Set(report.results.flatMap(r => r.exit && hasReview(r) ? [r.exit.ip] : []))
  const rows = report.results.filter(row => (filter === 'all' || (filter === 'review' ? hasReview(row) : row.available === (filter === 'up')))
    && [row.name, row.sourceName, exitLabel(row)].some(v => v.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => sort === 'speed' ? (b.speed?.averageBps ?? -1) - (a.speed?.averageBps ?? -1) : (a.httpsMedianMs ?? Infinity) - (b.httpsMedianMs ?? Infinity))
  const [offset, setOffset] = usePage(rows.length, 20)
  if (detail) return <NodeDetail row={detail} availability={latest?.[detail.key]?.availability} back={() => setDetail(null)} />
  return <div ref={resultList} className="quality-results">
    <div className="quality-heading"><div><h3 className="quality-title">检测结果</h3><p className="muted">可用 {available} / {report.results.length}{report.config.ai ? ' · ' + reviews + ' 个节点的 AI 结果需复核' : ' · AI 未检测'}{!report.config.bandwidth && ' · 下载未检测'}</p></div>
      <Button icon={Download} size="small" onClick={() => downloadJson('SubMeld-质量检测-' + report.jobId + '.json', report)}>导出 JSON</Button></div>
    {report.config.ai && <p className="field-note muted">有 AI 结果的节点 {report.results.filter(r => r.ai).length} 个{exits.size > 0 && <> · 出口 IP 覆盖 {testedExits.size} / {exits.size} 个</>}
      {testedExits.size > 0 && <> · 需复核 {reviewExits.size} 个（占全部出口 {(100 * reviewExits.size / exits.size).toFixed(1)}%
        {testedExits.size < exits.size && '，占已测出口 ' + (100 * reviewExits.size / testedExits.size).toFixed(1) + '%'}）</>}
    </p>}
    <div className="filters"><SearchBox value={query} placeholder="搜索节点、出口 IP 或地区" onChange={value => { setQuery(value); setOffset(0) }} />
      <NativeSelect aria-label="检测结果筛选" value={filter} onChange={e => { setFilter(e.target.value); setOffset(0) }}>
        {Object.entries({ all: '全部结果', up: '可用节点', down: '不可用节点', ...(report.config.ai ? { review: 'AI 待复核' } : {}) }).map(([k, v]) => <NativeSelectOption key={k} value={k}>{v}</NativeSelectOption>)}</NativeSelect>
      {report.config.bandwidth && <NativeSelect aria-label="结果排序" value={sort} onChange={e => { setSort(e.target.value); setOffset(0) }}><NativeSelectOption value="latency">延迟从低到高</NativeSelectOption><NativeSelectOption value="speed">下载从快到慢</NativeSelectOption></NativeSelect>}
    </div>
    {rows.length ? <><Table className="mobile-table quality-table" scrollLabel="节点检测结果"><TableHeader><TableRow><TableHead>节点 / 出口</TableHead><TableHead>可用性</TableHead>{hasAvailability && <TableHead>可用率</TableHead>}<TableHead>HTTPS 延迟</TableHead>{report.config.bandwidth && <TableHead>平均下载</TableHead>}{report.config.ai && <TableHead>AI 解锁</TableHead>}<TableHead>详情</TableHead></TableRow></TableHeader>
      <TableBody>{rows.slice(offset, offset + 20).map(row => <TableRow key={row.key}><TableCell className="table-row-title"><strong translate="no">{row.name}</strong><small>{exitLabel(row) || row.sourceName}</small></TableCell>
        <TableCell mobileLabel="可用性"><Badge tone={row.error === 'info_node' ? 'neutral' : row.available ? 'success' : 'danger'}>{row.error === 'info_node' ? '提示条目' : row.available ? '可用' : '不可用'}</Badge></TableCell>
        {hasAvailability && <TableCell mobileLabel="可用率"><AvailabilityReading availability={latest?.[row.key]?.availability} infoNode={row.error === 'info_node'} /></TableCell>}
        <TableCell mobileLabel="HTTPS 延迟">{ms(row.httpsMedianMs)}</TableCell>
        {report.config.bandwidth && <TableCell mobileLabel="平均下载">{row.speed ? row.speed.stop === 'error' && !row.speed.bytes ? '下载失败' : speed(row.speed.averageBps) : '未检测'}</TableCell>}
        {report.config.ai && <TableCell mobileLabel="AI 解锁" data-col="ai"><AiUnlockCell ai={row.ai} exitRegion={row.exit?.region ?? inferredExitRegion(row)} skipped={row.aiSkipped} infoNode={row.error === 'info_node'} tested={false} /></TableCell>}
        <TableCell><Button variant="ghost" size="small" aria-label={'查看检测详情 ' + row.name} data-result-key={row.key} onClick={() => inspect(row)}>详情<ChevronRight aria-hidden="true" /></Button></TableCell>
      </TableRow>)}</TableBody></Table>{rows.length > 20 && <Pager offset={offset} count={rows.length} pageSize={20} onChange={setOffset} />}</> : <Empty icon={Network} title="没有匹配的检测结果" />}
  </div>
}
