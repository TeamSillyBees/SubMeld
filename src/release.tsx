import type { Diff as UpdateDiff, ProjectedMember, Projection, VersionSummary, WorkspaceState, UpdateLog, EntryKind } from '../shared/model.ts'
import type { View } from './project.tsx'
import { asError } from './errors.ts'
import { useEffect, useRef, useState } from 'react'
import { Activity, Check, ClipboardCheck, CloudUpload, Download, Link2, Radio, RefreshCw, RotateCcw } from 'lucide-react'
import { Button as ButtonRoot } from '@/components/ui/button'
import { regionLabel, ruleTypes } from '../shared/catalog.ts'
import { ConfigSummary } from './dashboard.tsx'
import { useConfirm } from './confirm.tsx'
import { QualityBaselinePicker } from './quality-baseline.tsx'
import { useProject, useSearchValue } from './project.tsx'
import { NodeNames } from './sources.tsx'
import { Alert, Badge, Button, ButtonLink, CopyLinkButton, Disclosure, Empty, IssueList, Modal, NativeSelect, NativeSelectOption, PageTitle, Pager, Panel, RouteLink, Schedule, SearchBox, Segmented, SourceStatus, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TimeLabel, formatNumber, formatTime, searchable, useListPage, usePage, versionKind, versionLabel } from './ui.tsx'

function MembersPreview({ members }: { members: ProjectedMember[] }) {
  const [offset, setOffset] = usePage(members.length, 20)
  return <Disclosure compact title={formatNumber(members.length) + ' 项代理'}>
    <ol className="compact-list" start={offset + 1}>{members.slice(offset, offset + 20).map(member => <li key={member.key}>{member.name}</li>)}</ol>
    {members.length > 20 && <Pager offset={offset} pageSize={20} count={members.length} onChange={setOffset} />}
  </Disclosure>
}

function VisualPreview({ projection }: { projection: Projection }) {
  const [tabName, setTab] = useSearchValue('tab', 'nodes')
  const tab = tabName === 'groups' || tabName === 'rules' ? tabName : 'nodes'
  const [query, setQuery] = useSearchValue('q')
  const options = [['nodes', '保留节点'], ['groups', '代理组'], ['rules', '路由规则']] as const
  const nodes = tab === 'nodes' ? projection.nodes.filter(node => node.kept && (searchable(node.name, query) || searchable(node.sourceName, query))) : []
  const groups = tab === 'groups' ? projection.groups.filter(group => group.enabled && searchable(group.name, query)) : []
  const rules = tab === 'rules' ? projection.rules.filter(rule => [rule.value, rule.service, rule.outlet].some(value => searchable(value, query))) : []
  const count = nodes.length + groups.length + rules.length
  const [offset, setOffset] = useListPage(count, 20, 'previewPage')
  return <div>
    <div className="filters panel-padding"><Segmented items={options} label="配置预览内容" value={tab} onChange={value => { setTab(value); setOffset(0) }} />
      <SearchBox placeholder="搜索预览结果" value={query} onChange={value => { setQuery(value); setOffset(0) }} /></div>
    {!count ? <Empty title="此视图没有匹配项" /> : <>
        {tab === 'nodes' && <Table className="mobile-table" scrollLabel="保留节点预览"><TableHeader><TableRow><TableHead>节点名称</TableHead><TableHead>订阅源</TableHead><TableHead>地区</TableHead><TableHead>协议</TableHead></TableRow></TableHeader><TableBody>
          {nodes.slice(offset, offset + 20).map(row => <TableRow key={row.key}><TableCell className="table-row-title"><NodeNames row={row} /></TableCell><TableCell mobileLabel="订阅源">{row.sourceName}</TableCell><TableCell mobileLabel="地区">{regionLabel(row.region)}</TableCell><TableCell className="mono" mobileLabel="协议">{row.type.toUpperCase()}</TableCell></TableRow>)}
        </TableBody></Table>}
        {tab === 'groups' && <Table className="mobile-table" scrollLabel="代理组预览"><TableHeader><TableRow><TableHead>代理组</TableHead><TableHead>类型</TableHead><TableHead>组内代理（按顺序）</TableHead></TableRow></TableHeader><TableBody>
          {groups.slice(offset, offset + 20).map(group => <TableRow key={group.id}><TableCell className="table-row-title"><strong>{group.name}</strong></TableCell><TableCell className="mono" mobileLabel="类型">{group.type}</TableCell>
            <TableCell mobileLabel="组内代理"><MembersPreview members={group.members} /></TableCell></TableRow>)}
        </TableBody></Table>}
        {tab === 'rules' && <Table className="mobile-table" scrollLabel="路由规则预览"><TableHeader><TableRow><TableHead>优先级</TableHead><TableHead>服务</TableHead><TableHead>条件</TableHead><TableHead>出站策略</TableHead></TableRow></TableHeader><TableBody>
          {rules.slice(offset, offset + 20).map(rule => <TableRow key={rule.id}><TableCell className="numeric" mobileLabel="优先级">{rule.position}</TableCell><TableCell mobileLabel="服务">{rule.service}</TableCell>
            <TableCell mobileLabel="匹配条件"><strong>{ruleTypes[rule.type]?.[0] ?? rule.type}</strong>{rule.type !== 'RULE-SET' && <small className="muted">{rule.value}</small>}</TableCell><TableCell mobileLabel="出站策略">{rule.outlet}</TableCell></TableRow>)}
        </TableBody></Table>}
      {count > 20 && <Pager offset={offset} pageSize={20} count={count} onChange={setOffset} />}
    </>}
  </div>
}

function PublishedVersion({ state, download, heading }: { state: WorkspaceState; heading: React.RefObject<HTMLHeadingElement | null>; download: string }) {
  return <section className="summary-strip release-summary" aria-labelledby="release-version-title">
    <div className="summary-copy">
      <h2 id="release-version-title" ref={heading} tabIndex={-1}>当前成品 <span className="mono">{versionLabel(state.current)}</span></h2>
      <p>{versionKind(state.current)} · <TimeLabel value={state.current?.at} />{!state.hasLink && ' · 私有链接已撤销'}</p>
    </div>
    <div className="actions">
      <ButtonRoot asChild variant="outline"><a href={download} download><Download data-icon="inline-start" aria-hidden="true" />下载完整配置</a></ButtonRoot>
      {state.hasLink ? <CopyLinkButton variant={state.dirty ? 'outline' : 'primary'} />
        : <ButtonLink page="safety" variant="outline" icon={Link2}>管理私有链接</ButtonLink>}
    </div>
  </section>
}

export function PublishPage() {
  const { state, view, pathFor, call, applyState, reload, notify, quality } = useProject()
  const hasQualityPools = state.draft.groups.some(g => g.enabled && g.members.some(m => m.kind === 'pool' && m.quality))
  const reportChanged = hasQualityPools && !!state.current && quality.ready && quality.reportId !== (state.current.qualityReportId ?? null)
  const confirm = useConfirm()
  const [checked, setChecked] = useState<{ revision: number; view: View; result: Projection } | null>(null)
  const [history, setHistory] = useState<{ offset: number; rows: VersionSummary[]; error?: string } | null>(null)
  const [historyOffset, setHistoryOffset] = useState(0)
  const [requestedPreview, setMode] = useSearchValue('preview', state.current && !state.dirty ? 'current' : 'config')
  const [current, setCurrent] = useState<{ seq: number; projection?: Projection | null; error?: string } | null>(null)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const [target, setTarget] = useState<VersionSummary | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const publishedHeading = useRef<HTMLHeadingElement>(null)
  const version = state.current?.seq
  const mode = version && requestedPreview === 'current' ? 'current' : 'config'
  const result = checked?.revision === state.revision && checked.view === view ? checked.result : null
  const issues = result?.issues ?? view.issues
  const errors = issues.filter(issue => issue.severity === 'error').length
  const warnings = issues.length - errors
  const currentPreview = current?.seq === version ? current : null
  const preview = mode === 'current' ? currentPreview?.projection : view
  const released = version ? <PublishedVersion state={state} download={pathFor('download')} heading={publishedHeading} /> : null
  const hasDraftChanges = state.dirty || !version || reportChanged

  useEffect(() => {
    if (!version) return
    let active = true
    call(`history?offset=${historyOffset}`).then(rows => { if (active) setHistory({ offset: historyOffset, rows }) })
      .catch(error => { if (active) setHistory({ offset: historyOffset, rows: [], error: error.message }) })
    return () => { active = false }
  }, [version, historyOffset, historyAttempt, call])

  useEffect(() => {
    if (mode !== 'current' && !hasQualityPools || version === undefined) return
    let active = true
    call('current').then(value => { if (active) setCurrent({ seq: version, projection: value }) })
      .catch(error => { if (active) setCurrent({ seq: version, error: error.message }) })
    return () => { active = false }
  }, [mode, version, previewAttempt, hasQualityPools, call])

  async function runCheck() {
    setError('')
    setBusy('check')
    try {
      const next = await call('check', { expectedQualityReportId: quality.reportId })
      setChecked({ revision: next.revision, view, result: next })
    } catch (cause) { const error = asError(cause); setError(error.message) } finally { setBusy('') }
  }
  async function publish() {
    const outcome = state.revoked ? '本次配置将成为当前成品。' : '私有订阅链接将提供本次配置。'
    const detail = (warnings ? `配置检查有 ${formatNumber(warnings)} 项提醒。` : '') + '通过 Mihomo 校验后，' + outcome
    if (!await confirm({ title: '发布配置？', detail, action: '确认发布' })) return
    setBusy('publish')
    setError('')
    try {
      const next = await call('publish', { revision: state.revision, expectedQualityReportId: quality.reportId })
      applyState(next)
      setChecked(null)
      setMode('current')
      requestAnimationFrame(() => publishedHeading.current?.focus({ preventScroll: true }))
    } catch (cause) {
      const error = asError(cause)
      if (error.detail && 'issues' in error.detail) setChecked({ revision: state.revision, view, result: error.detail })
      else setError(error.message)
      if (error.status === 409) await reload().catch(() => {})
    } finally { setBusy('') }
  }
  async function rollback() {
    if (!target) return
    setBusy('rollback')
    try {
      applyState(await call('rollback', { seq: target.seq }))
      setTarget(null)
      setMode('current')
      setHistoryOffset(0)
      notify('已回滚至 ' + versionLabel(target) + ' 的内容')
    } catch (cause) { const error = asError(cause); notify(error.message, 'danger') } finally { setBusy('') }
  }
  const previousGroups = new Map(currentPreview?.projection?.groups.map(g => [g.id, g]))
  const differences = view.groups.flatMap(g => {
    if (!state.draft.groups.find(group => group.id === g.id)?.members.some(m => m.kind === 'pool' && m.quality)) return []
    const previous = new Map(previousGroups.get(g.id)?.members.map(m => [m.key, m.name]))
    const next = new Map(g.members.map(m => [m.key, m.name]))
    return [{ name: g.name, add: [...next].filter(([key, name]) => previous.get(key) !== name).map(([, name]) => name),
      remove: [...previous].filter(([key, name]) => next.get(key) !== name).map(([, name]) => name) }]
  })
  const historyPage = history?.offset === historyOffset ? history : null
  return <div className="stack">
    <PageTitle title="配置发布" />
    {!state.dirty && released}
    {hasQualityPools && <Panel title="代理组质量差异" actions={<QualityBaselinePicker />}>
      <div className="panel-padding quality-differences">{reportChanged && <p>所选报告与线上版本使用的报告不同，发布后将采用以下成员。</p>}
        {currentPreview?.error ? <Alert tone="danger" action={<Button size="small" onClick={() => setPreviewAttempt(v => v + 1)}>重试</Button>}>{currentPreview.error}</Alert>
          : version && !currentPreview?.projection || !quality.ready ? <p role="status">正在读取质量基准…</p> : differences.map(g => <Disclosure key={g.name} title={g.name + ' · 新增 ' + g.add.length + ' · 移出 ' + g.remove.length}>
            {!!g.add.length && <p>新增成员　{g.add.join('、')}</p>}{!!g.remove.length && <p>移出成员　{g.remove.join('、')}</p>}{!g.add.length && !g.remove.length && <p>成员与线上版本一致。</p>}
          </Disclosure>)}
      </div></Panel>}
    <Panel className="review-panel" title="配置检查"
      detail={state.current?.kind === 'rollback' ? '再次发布可恢复成品自动更新。' : undefined}
      actions={<><Button icon={ClipboardCheck} busy={busy === 'check'} disabled={Boolean(busy) || hasQualityPools && !quality.ready} onClick={runCheck}>运行检查</Button>
        <Button key={hasDraftChanges ? 'publish' : 'republish'} variant={hasDraftChanges ? 'primary' : 'secondary'} icon={CloudUpload}
          busy={busy === 'publish'} disabled={Boolean(busy) || hasQualityPools && !quality.ready} onClick={publish}>{hasDraftChanges ? '发布配置' : '重新发布'}</Button></>}>
      <ConfigSummary counts={view.counts} />
      <div className="review-status" role="status">
        {busy === 'check' || busy === 'publish' ? (busy === 'check' ? '正在使用 Mihomo 检查配置…' : '正在校验并发布…') : <>
          {errors > 0 ? <Badge tone="danger">{formatNumber(errors)} 项错误</Badge> : result && <Badge tone="success" dot>校验通过</Badge>}
          <span>{errors > 0 ? '解决错误后可发布。' : result ? '已完成 Mihomo 校验。' : '发布时会运行 Mihomo 校验。'}</span>
        </>}
      </div>
      {error && <div className="panel-padding"><Alert tone="danger">{error}</Alert></div>}
      {errors > 0 ? <IssueList items={issues} /> : warnings > 0 && <div className="panel-padding">
        <Disclosure title={<span className="warning-text">{formatNumber(warnings)} 项提醒</span>}><IssueList className="issue-list-inset" items={issues} /></Disclosure>
      </div>}
    </Panel>
    {state.dirty && released}
    <Panel title="内容预览"
      actions={version ? <Segmented label="预览内容来源" items={[['config', '工作台配置'], ['current', '订阅版本']]} value={mode} onChange={setMode} /> : undefined}>
      {preview
        ? <VisualPreview key={mode} projection={preview} />
        : currentPreview?.error ? <div className="panel-padding"><Alert tone="danger" action={<Button size="small" onClick={() => { setCurrent(null); setPreviewAttempt(value => value + 1) }}>重试</Button>}>{currentPreview.error}</Alert></div>
          : <p className="muted panel-padding" role="status">正在读取当前成品…</p>}
    </Panel>
    {version && <Panel title="版本历史">
      {historyPage?.error ? <div className="panel-padding"><Alert tone="danger" action={<Button size="small" onClick={() => { setHistory(null); setHistoryAttempt(value => value + 1) }}>重试</Button>}>{historyPage.error}</Alert></div>
        : !historyPage ? <p className="muted panel-padding" role="status">正在读取版本历史…</p> : <>
        <Table className="mobile-table" scrollLabel="版本历史"><TableHeader><TableRow><TableHead>版本</TableHead><TableHead>发布时间</TableHead><TableHead>节点 / 组 / 规则</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {historyPage.rows.slice(0, 30).map((version, index) => {
            const previous = historyPage.rows[index + 1]?.counts
            const changes = previous ? ([['nodes', '节点'], ['groups', '组'], ['rules', '规则']] as const).flatMap(([key, label]) => {
              const delta = version.counts[key] - previous[key]
              return delta ? [label + ' ' + (delta > 0 ? '+' : '') + delta] : []
            }) : []
            return <TableRow key={version.seq}>
              <TableCell className="table-row-title"><strong>{versionLabel(version)}</strong><div className="chips"><Badge tone={version.seq === state.current?.seq ? 'success' : 'neutral'}>
                {version.seq === state.current?.seq ? '当前版本' : '历史有效'} · {versionKind(version)}</Badge>
                {version.kind === 'rollback' && <Badge>恢复 v{version.parent}</Badge>}</div></TableCell>
              <TableCell mobileLabel="发布时间"><TimeLabel value={version.at} />{version.qualityReportId && <small className="muted" title={version.qualityReportId}>质量报告 {version.qualityReportId.slice(0, 8)}</small>}</TableCell>
              <TableCell className="numeric" mobileLabel="节点 / 组 / 规则">{version.counts.nodes} / {version.counts.groups} / {version.counts.rules}
                {changes.length > 0 && <small className="muted">{changes.join(' · ')}</small>}</TableCell>
              <TableCell className="table-row-wide">{version.seq !== state.current?.seq && <Button size="small" icon={RotateCcw} onClick={() => setTarget(version)}>回滚</Button>}</TableCell>
            </TableRow>
          })}
        </TableBody></Table>
        {(historyPage.rows.length > 30 || historyOffset > 0) && <div className="actions panel-padding">
          <Button size="small" disabled={!historyOffset} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 30))}>较新版本</Button>
          <Button size="small" disabled={historyPage.rows.length <= 30} onClick={() => setHistoryOffset(historyOffset + 30)}>较早版本</Button>
        </div>}
      </>}
    </Panel>}
    {target && <Modal title={'回滚至 ' + versionLabel(target)} detail="回滚后，订阅将提供所选版本的配置。"
      onClose={() => !busy && setTarget(null)} footer={<><Button onClick={() => setTarget(null)} disabled={Boolean(busy)}>取消</Button><Button variant="primary" icon={RotateCcw} busy={busy === 'rollback'} onClick={rollback}>确认回滚</Button></>}>
      <div className="stack tight"><p>{formatTime(target.at)} · {target.counts.nodes} 个节点 · {target.counts.groups} 个代理组 · {target.counts.rules} 条规则</p>
        <Alert>回滚会建立一条版本记录。再次发布配置后，订阅将恢复自动更新。</Alert></div>
    </Modal>}
  </div>
}

function Diff({ value }: { value?: UpdateDiff | null }) {
  if (!value) return <span className="muted">无节点变更数据</span>
  return <div className="stack tight">
    <div className="chips"><Badge>总数 {value.before} → {value.after}</Badge>
      <Badge tone="success">新增 {value.added}</Badge><Badge tone="warning">移除 {value.removed}</Badge><Badge tone="accent">变更 {value.changed}</Badge></div>
    {([['addedNames', '新增节点'], ['removedNames', '移除节点'], ['changedNames', '同名节点连接参数已更新']] as const).map(([key, label]) =>
      !!value[key]?.length && <Disclosure compact key={key} title={label}><ul className="compact-list">{value[key].map((name, index) => <li key={index}>{name}</li>)}</ul></Disclosure>)}
  </div>
}

export function UpdatesPage() {
  const { state, call, notify, reload, navigate } = useProject()
  const [records, setRecords] = useState<UpdateLog[] | null>(null)
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useSearchValue('q')
  const [status, setStatus] = useSearchValue('status', 'all')
  const [focus, setFocus] = useState<UpdateLog | null>(null)
  const [busy, setBusy] = useState('')
  const [changeKey, setChangeKey] = useState(0)
  const [error, setError] = useState('')
  const reports = state.draft.sources
  const canRefresh = reports.some(source => !source.local && source.enabled && !['running', 'queued'].includes(state.sources[source.id]?.status))
  const refreshSignature = [...Object.values(state.sources), ...Object.values(state.providers), ...state.publishedOnly].map(record => record.lastAttempt + '/' + record.lastSuccess + '/' + record.status + '/' + record.error).join('|')
  useEffect(() => {
    let active = true
    call(`updates?offset=${offset}`).then(next => { if (active) { setRecords(next); setError('') } }).catch(error => { if (active) setError(error.message) })
    return () => { active = false }
  }, [call, offset, changeKey, refreshSignature, state.id])
  const visible = records?.slice(0, 50).filter(record => searchable(record.name, query) && (status === 'all' || record.outcome === status)) ?? []
  async function refresh(id?: string, kind?: EntryKind) {
    setBusy(id || 'all')
    try {
      await call('refresh', { id, kind })
      await reload()
      setChangeKey(value => value + 1)
      if (focus) setFocus(null)
    } catch (cause) { const error = asError(cause); notify(error.message, 'danger') } finally { setBusy('') }
  }
  return <div className="stack">
    <PageTitle title="更新记录"
      actions={reports.length > 0 && <Button icon={RefreshCw} variant="primary" busy={busy === 'all'} disabled={Boolean(busy) || !canRefresh} onClick={() => refresh()}>刷新全部订阅源</Button>} />
    <Panel title="订阅源刷新状态">
      {!reports.length ? <Empty icon={Radio} title="暂无订阅源" actions={<Button onClick={() => navigate('sources', 'new')}>添加订阅源</Button>} /> :
      <div className="group-list">{reports.map(source => {
        const record = state.sources[source.id]
        return <article className="group-row refresh-row" key={source.id}>
          <span className="entity-mark"><Radio aria-hidden="true" /></span>
          <div className="group-main"><RouteLink className="text-link" page="sources" id={source.id}>{source.name}</RouteLink>
            <div className="chips"><SourceStatus entry={source} record={record} />{record?.pending && <Badge tone={record.pending.accepted ? 'accent' : 'warning'}>{record.pending.accepted ? '已采纳候选' : '候选待处理'}</Badge>}</div>
            {record?.error && <small className="error-text">{record.error}</small>}
          </div>
          <Schedule record={record} />
          {!source.local && <Button size="small" icon={RefreshCw} busy={busy === source.id} disabled={Boolean(busy) || ['running', 'queued'].includes(record?.status)} onClick={() => refresh(source.id)}>{record?.error ? '重试' : '立即刷新'}</Button>}
        </article>
      })}</div>}
    </Panel>
    {!!state.publishedOnly?.length && <Panel title="成品仍在使用的旧来源" detail="下次发布时，订阅将使用工作台中配置的来源。">
      <div className="group-list">{state.publishedOnly.map(entry => <article className="group-row" key={entry.kind + '/' + entry.id}>
        <div className="group-main"><strong>{entry.name}</strong><div className="chips"><SourceStatus entry={{ enabled: true }} record={entry} /></div>
          {entry.error && <small className="error-text">{entry.error}</small>}
        </div><Schedule record={entry} />
      </article>)}</div>
    </Panel>}
    <Panel title="刷新历史"
      actions={state.unread && <Button size="small" icon={Check} onClick={async () => {
        try { await call('updates/read', {}); await reload() } catch (cause) { const error = asError(cause); notify(error.message, 'danger') }
      }}>标记已读</Button>}>
      {!!records?.length && <div className="filters panel-padding"><SearchBox placeholder="搜索当前页来源" value={query} onChange={setQuery} />
        <NativeSelect aria-label="刷新结果" value={status} onChange={event => setStatus(event.target.value)}><NativeSelectOption value="all">全部结果</NativeSelectOption><NativeSelectOption value="success">成功</NativeSelectOption><NativeSelectOption value="failed">失败</NativeSelectOption></NativeSelect>
      </div>}
      {error && <div className="panel-padding"><Alert tone="danger" action={<Button size="small" onClick={() => setChangeKey(value => value + 1)}>重试</Button>}>{error}</Alert></div>}
      {!records ? !error && <p className="panel-padding muted" role="status">正在读取刷新历史…</p>
        : !visible.length ? <Empty icon={Activity} title={records.length ? '当前页无匹配记录' : '暂无刷新记录'}
          actions={records.length > 0 && <Button onClick={() => { setQuery(''); setStatus('all') }}>清除筛选</Button>} /> :
        <Table className="mobile-table" scrollLabel="刷新历史"><TableHeader><TableRow><TableHead>来源</TableHead><TableHead>时间 / 触发方式</TableHead><TableHead>结果</TableHead><TableHead>变化</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {visible.map(record => <TableRow key={record.id}>
            <TableCell className="table-row-title"><strong>{record.name}</strong><small className="muted">{record.kind === 'provider' ? '规则集' : '订阅源'}</small></TableCell>
            <TableCell mobileLabel="时间"><TimeLabel value={record.at} /><small className="muted">{({ manual: '手动', schedule: '定时', probe: '测试并保存', import: '本地导入' })[record.trigger]}</small></TableCell>
            <TableCell mobileLabel="结果"><Badge tone={record.outcome === 'success' ? 'success' : 'danger'} dot>{record.outcome === 'success' ? '成功' : record.usedOld ? '失败 · 使用旧数据' : '失败'}</Badge>{record.outcome !== 'success' && <small className="muted text-limit">{record.message}</small>}</TableCell>
            <TableCell className="numeric" mobileLabel="变化">{record.diff ? record.diff.before + ' → ' + record.diff.after : '—'}</TableCell>
            <TableCell><Button size="small" onClick={() => setFocus(record)}>详情</Button></TableCell>
          </TableRow>)}
        </TableBody></Table>}
      {records && (offset > 0 || records.length > 50) && <div className="actions panel-padding"><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>较新记录</Button><Button disabled={records.length <= 50} onClick={() => setOffset(offset + 50)}>较早记录</Button></div>}
    </Panel>
    {focus && <Modal title={'刷新详情 · ' + focus.name} detail={formatTime(focus.at)} onClose={() => setFocus(null)} footer={<>
      {focus.outcome === 'failed' && <Button icon={RefreshCw} busy={busy === focus.entryId} onClick={() => refresh(focus.entryId, focus.kind)}>重试刷新</Button>}
      <Button onClick={() => setFocus(null)}>关闭</Button></>}>
      <div className="stack"><Alert tone={focus.outcome === 'success' ? 'success' : 'warning'}>{focus.message}</Alert>
        <Diff value={focus.diff} />
        {!!focus.rejected?.length && <Disclosure title={formatNumber(focus.rejected.length) + ' 项无法导入'}>
          <ul className="compact-list">{focus.rejected.slice(0, 100).map((item, index) => <li key={index}>{item.item} / {item.reason}</li>)}</ul>
        </Disclosure>}
      </div>
    </Modal>}
  </div>
}
