import type { Filter, NodeView, Source, SourceData, SourceRecord, SourceStats, SubscriptionInfo } from '../shared/model.ts'
import type { ProbeSource } from './api.ts'
import type { RequestError } from './errors.ts'
import { asError } from './errors.ts'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronRight, Clock, Download, Filter as FilterIcon, ListFilter, Network, Pencil, Plus, Radio, RefreshCw, RotateCcw, Star, Trash2, Upload, X } from 'lucide-react'
import { QualityControl } from './quality.tsx'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { commonKeywords, defaultFilter, identifyRegion, regionLabel, regions } from '../shared/catalog.ts'
import { draftDataset, filterNodes, sourceReferences } from '../shared/config.ts'
import { NodeQualityValue, QualitySortBar, qualitySortLabels, AvailabilityReading, AiUnlockCell } from './node-quality.tsx'
import { isSubscriptionNotice } from '../shared/quality-options.ts'
import { compareQuality, platformSurfaces, type QualitySort } from '../shared/quality-snapshot.ts'
import { membersForSources, poolCondition, qualityPresets, qualityReason } from '../shared/group-filter.ts'
import { calendarFormatter, renewalNoticeDays } from '../shared/subscription.ts'
import { useConfirm, useUnsavedChanges } from './confirm.tsx'
import { useProject, useSearchValue } from './project.tsx'
import { Alert, Badge, Button, ButtonLink, Checkbox, Disclosure, Empty, Field, FieldGroup, FieldLegend, FieldSet, IconButton, Input, Modal, MoveButtons, MultiSelect, NativeSelect, NativeSelectOption, PageCheckbox, Pager, Panel, RouteLink, SearchBox, Segmented, SourceStatus, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, TimeLabel, Toggle, downloadJson, dragProps, formatNumber, moveAt, newId, searchable, useListPage, usePage } from './ui.tsx'

type InputMode = 'url' | 'yaml' | 'links'
type NoteEditor = { row: NodeView; favorite: boolean; text: string }

const regionOptions = regions.map(([id, name, flag]) => [id, [flag, name].filter(Boolean).join(' ')])
const importModes = [['url', '订阅链接'], ['yaml', 'YAML 配置'], ['links', '节点链接']] as const
const countText = (retained: number, original: number) => formatNumber(retained) + ' / ' + formatNumber(original)
const newSource = (): Source => ({
  id: newId(), name: '', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: structuredClone(defaultFilter),
})

function KeywordEditor({ keywords, onChange }: { keywords: string[]; onChange: (keywords: string[]) => void }) {
  const [input, setInput] = useState('')
  const toggle = (word: string) => onChange(keywords.includes(word) ? keywords.filter(value => value !== word) : [...keywords, word])
  function add() {
    const words = input.split(/[\r\n,，;；]+/).map(word => word.trim()).filter(Boolean)
    onChange([...new Set([...keywords, ...words])])
    setInput('')
  }
  return <FieldSet className="stack tight">
    <FieldLegend variant="label">排除关键词</FieldLegend>
    <ToggleGroup type="multiple" variant="outline" size="sm" className="flex-wrap" aria-label="常用排除关键词"
      value={keywords.filter(word => commonKeywords.includes(word))}
      onValueChange={values => onChange([...keywords.filter(word => !commonKeywords.includes(word)), ...values])}>
      {commonKeywords.map(word => <ToggleGroupItem key={word} value={word}>{word}</ToggleGroupItem>)}
    </ToggleGroup>
    <div className="actions input-actions"><Input aria-label="自定义排除关键词" placeholder="关键词，可用逗号分隔…" value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); add() }
    }} /><Button icon={Plus} disabled={!input.trim()} onClick={add}>添加</Button></div>
    {keywords.some(word => !commonKeywords.includes(word)) && <div className="chips">{keywords.filter(word => !commonKeywords.includes(word)).map(word =>
      <Button key={word} size="small" onClick={() => toggle(word)} aria-label={'移除关键词 ' + word}>{word}<X data-icon="inline-end" aria-hidden="true" /></Button>)}</div>}
  </FieldSet>
}

function FilterForm({ filter, onChange, reset }: { filter: Filter; onChange: (filter: Filter) => void; reset?: () => void }) {
  const change = <K extends keyof Filter>(key: K, value: Filter[K]) => onChange({ ...filter, [key]: value })
  return <section className="stack tight">
    <div className="between"><div><h3>筛选条件</h3><p className="muted field-note">保留地区满足任一项即可。排除条件优先，地区按节点名称推断。</p></div>
      {JSON.stringify(filter) !== JSON.stringify(defaultFilter) && <Button size="small" variant="ghost" onClick={reset}>重置筛选</Button>}</div>
    <FieldGroup className="form-grid three source-regions">
      <MultiSelect label="仅保留地区" options={regionOptions} values={filter.keep} onChange={value => change('keep', value)} placeholder="所有地区" />
      <MultiSelect label="排除地区" options={regionOptions} values={filter.exclude} onChange={value => change('exclude', value)} placeholder="无" />
      <Field label="未知地区"><NativeSelect value={filter.unknown} onChange={event => change('unknown', event.target.value as Filter['unknown'])}>
        <NativeSelectOption value="auto">遵循地区条件</NativeSelectOption><NativeSelectOption value="keep">保留未知地区</NativeSelectOption><NativeSelectOption value="exclude">排除未知地区</NativeSelectOption>
      </NativeSelect></Field>
    </FieldGroup>
    <KeywordEditor keywords={filter.keywords} onChange={value => change('keywords', value)} />
  </section>
}

function SourceEditor({ source, first, onClose }: { source?: Source; first?: string; onClose: () => void }) {
  const { state, view, save, call, navigate, applyState, notify } = useProject()
  const confirm = useConfirm()
  const [initial] = useState(() => source ?? newSource())
  const revision = useRef(state.revision).current
  const formId = useId()
  const settingsForm = useRef<HTMLFormElement>(null)
  const yamlFile = useRef<HTMLInputElement>(null)
  const renewalInput = useRef<HTMLInputElement>(null)
  const stepHeading = useRef<HTMLHeadingElement>(null)
  const [form, setForm] = useState(() => structuredClone(initial))
  const [step, setStep] = useState(first === 'filter' && source ? 'filter' : 'settings')
  const [advanced, setAdvanced] = useState(false)
  const [inputMode, setInputMode] = useState<InputMode>('url')
  const [localTexts, setLocalTexts] = useState({ yaml: '', links: '' })
  const [savedAddress, setSavedAddress] = useState<string | null>(null)
  const [addressUnavailable, setAddressUnavailable] = useState(false)
  const [testResult, setTestResult] = useState<ProbeSource | null>(null)
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState<{ field?: string; message: string } | null>(null)
  const [previewFilter, setPreviewFilter] = useState('all')
  const [previewQuery, setPreviewQuery] = useState('')
  const [templateName, setTemplateName] = useState('')
  const readingAddress = Boolean(initial.urlStored && !initial.local && savedAddress === null && !addressUnavailable)
  const address = form.url.trim()
  const urlOverride = form.urlStored && address === savedAddress ? '' : address
  const localInput = !source && inputMode !== 'url' ? { format: inputMode, text: localTexts[inputMode] } : null
  const local = form.local || Boolean(localInput)
  const dirty = Boolean(localTexts.yaml || localTexts.links) || JSON.stringify({ ...form, url: urlOverride }) !== JSON.stringify(initial)
  const guard = useUnsavedChanges(dirty, '本次填写的订阅源设置将被丢弃。')
  const record = state.sources[form.id]
  const current = draftDataset(record)
  const data = form.local || (form.urlStored && !urlOverride) ? current ?? testResult : testResult?.savedData ?? testResult
  const rows = useMemo(() => filterNodes(form, data), [form, data])
  const previewRows = rows.filter(row => (previewFilter === 'all' || row.kept === (previewFilter === 'kept'))
    && (searchable(row.name, previewQuery) || searchable(row.originalName, previewQuery)))
  const [offset, setOffset] = usePage(previewRows.length, 20)
  const filtering = step === 'filter'

  useEffect(() => {
    if (!readingAddress || step !== 'settings') return
    let active = true
    call(`source-address?id=${encodeURIComponent(initial.id)}`).then(({ url }) => {
      if (!active) return
      setSavedAddress(url)
      setForm(previous => ({ ...previous, url }))
    }, () => {
      if (active) setAddressUnavailable(true)
    })
    return () => { active = false }
  }, [call, initial.id, readingAddress, step])

  const change = <K extends keyof Source>(key: K, value: Source[K]) => {
    setForm(previous => ({ ...previous, [key]: value }))
    if (problem?.field === key) setProblem(null)
    if (key === 'url') { setProblem(null); setTestResult(null) }
  }
  function changeMode(mode: InputMode) {
    setInputMode(mode)
    setTestResult(null)
    setProblem(null)
  }
  function changeText(text: string) {
    setLocalTexts(previous => ({ ...previous, [inputMode]: text }))
    setTestResult(null)
    setProblem(null)
  }
  async function readYamlFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { fieldProblem('content', '文件过大，请选择 8 MiB 以内的 YAML 文件。'); return }
    setBusy('file')
    try {
      changeText(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()))
    } catch { fieldProblem('content', '无法读取文件，请选择 UTF-8 编码的 YAML 文件。') } finally { setBusy('') }
  }
  const stop = () => { if (!busy) return guard.close(onClose) }
  function fieldProblem(key: string, message: string) {
    setStep('settings')
    if (key === 'minutes') setAdvanced(true)
    setProblem({ field: key, message })
    requestAnimationFrame(() => settingsForm.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
  }

  function validateInput() {
    if (localInput) {
      if (localInput.text.trim()) return true
      fieldProblem('content', inputMode === 'yaml' ? '请粘贴 YAML 配置或选择文件。' : '请粘贴节点分享链接。')
      return false
    }
    if (form.local) return true
    if (form.urlStored && !urlOverride) return true
    if (!urlOverride) { fieldProblem('url', '请输入订阅地址。'); return false }
    try {
      const url = new URL(urlOverride)
      if (url.username || url.password) {
        fieldProblem('url', '请移除地址中的用户名和密码。')
        return false
      }
      if (['http:', 'https:'].includes(url.protocol)) return true
    } catch { /* Show the same field error for malformed and unsupported URLs. */ }
    fieldProblem('url', '请输入完整的 HTTP 或 HTTPS 订阅地址。')
    return false
  }

  function validateSettings() {
    if (!validateInput()) return false
    if (!form.name.trim()) { fieldProblem('name', '请填写订阅源名称。'); return false }
    const dateInput = renewalInput.current
    if (dateInput && !dateInput.validity.valid) {
      fieldProblem('renewalDate', '请填写完整的续费日期，或清空日期。')
      return false
    }
    if (!local && (!Number.isInteger(form.minutes) || form.minutes < 1 || form.minutes > 43200)) {
      fieldProblem('minutes', '请输入 1–43,200 分钟之间的整数。')
      return false
    }
    return true
  }

  function showStep(next: string) {
    setStep(next)
    requestAnimationFrame(() => stepHeading.current?.focus())
  }

  function inputError(error: RequestError) {
    const result = error.detail && 'rejected' in error.detail ? error.detail : null
    if (result) setTestResult(result)
    if (localInput && [400, 413, 422].includes(error.status ?? 0) && (!error.detail || result)) {
      if (result?.nodes.length) showStep('filter')
      else fieldProblem('content', error.message)
    } else {
      setProblem(error)
    }
  }

  async function previewInput(advance = false) {
    setProblem(null)
    if (advance ? !validateSettings() : !validateInput()) return
    if (advance && testResult?.nodes.length) { showStep('filter'); return }
    setTestResult(null)
    setBusy('test')
    try {
      const result = await call('probe', { kind: 'source', id: form.id, ...(localInput ? { input: localInput } : { url: urlOverride }) })
      setTestResult(result)
      if (advance) showStep('filter')
    } catch (cause) { const error = asError(cause); inputError(error) } finally { setBusy('') }
  }

  async function commit() {
    setProblem(null)
    if (!validateSettings()) return
    setBusy('save')
    try {
      const value = { ...form, url: urlOverride, name: form.name.trim(), renewalDate: form.renewalDate || undefined }
      if (localInput) Object.assign(value, { local: true, url: '', enabled: true, paused: true, minutes: initial.minutes })
      const sources = source ? state.draft.sources.map(entry => entry.id === form.id ? value : entry) : [...state.draft.sources, value]
      const localInputs = localInput ? { [form.id]: { ...localInput, acceptPartial: filtering } } : undefined
      await save({ ...state.draft, sources }, revision, undefined, localInputs)
      guard.leave(onClose)
    } catch (cause) { const error = asError(cause); inputError(error) } finally { setBusy('') }
  }

  async function storeFilter() {
    setBusy('template')
    setProblem(null)
    try {
      const templates = state.library.filters
      const template = { id: newId(), name: templateName.trim(), filter: { ...form.filter, manual: [] } }
      if (applyState(await call('library', { ...state.library, filters: [...templates, template] }))) {
        setTemplateName('')
        notify('筛选模板已保存')
      }
    } catch (cause) { const error = asError(cause); setProblem(error) } finally { setBusy('') }
  }

  const retained = rows.filter(row => row.kept).length
  const unknown = rows.filter(row => row.region === 'unknown').length
  const currentCount = view.sources.find(item => item.id === form.id)?.retained ?? 0
  const changeCount = retained - currentCount
  const toggleManual = (id: string) => change('filter', { ...form.filter, manual: form.filter.manual.includes(id) ? form.filter.manual.filter(key => key !== id) : [...form.filter.manual, id] })
  const steps = [['settings', '订阅设置'], ['filter', '筛选与预览']] as const
  const previewAction = localInput ? '解析并预览' : '测试并预览'
  return <Modal wide={filtering} className={!filtering ? 'source-settings-dialog' : undefined} title={source ? '编辑订阅源 · ' + source.name : '添加订阅源'}
    initialFocusRef={first === 'renewal' ? renewalInput : undefined}
    onClose={stop} footer={<>
      <Button variant="ghost" disabled={Boolean(busy)} onClick={stop}>取消</Button>
      {!source && filtering && <Button icon={ArrowLeft} disabled={Boolean(busy)} onClick={() => showStep('settings')}>返回设置</Button>}
      {!source && !filtering ? <>
        <Button variant="ghost" busy={busy === 'save'} disabled={Boolean(busy)} onClick={commit}>直接保存</Button>
        <Button variant="primary" icon={ArrowRight} type="submit" form={formId} busy={busy === 'test'} disabled={Boolean(busy)}>
          {busy === 'test' ? '正在读取节点…' : testResult?.nodes.length ? '预览筛选结果' : previewAction}
        </Button>
      </> : <Button variant="primary" icon={Check} busy={busy === 'save'} disabled={Boolean(busy)} onClick={commit}>保存订阅源</Button>}
    </>}>
    <div className="stack">
      {source ? <div inert={Boolean(busy)}><Segmented label="订阅源编辑内容" items={steps} value={step} onChange={setStep} /></div>
        : <ol className="editor-steps" aria-label="添加订阅源步骤">
          {steps.map(([key, label], index) => <li key={key} aria-current={step === key ? 'step' : undefined}>
            <span aria-hidden="true">{index === 0 && filtering ? <Check /> : index + 1}</span>{label}
          </li>)}
        </ol>}
      {problem && !problem.field && <Alert tone="danger">{problem.message}</Alert>}
      {record?.error && <Alert tone="warning">{record.error}</Alert>}
      {record?.pending && <Alert tone={record.pending.accepted ? 'info' : 'warning'} title={'候选结果 · ' + record.pending.count + ' 个节点'}
        action={<Button size="small" disabled={Boolean(busy)} onClick={async () => {
          const accepting = !record.pending?.accepted
          const action = accepting ? '采纳候选节点' : '撤销采纳'
          if ((accepting || dirty) && !await confirm({
            title: accepting ? '采纳候选节点？' : '撤销采纳？',
            detail: (accepting ? '候选节点将用于配置预览，下次发布时写入订阅。' : '配置预览将恢复使用上一次有效的节点。') + (dirty ? '此操作也会放弃本次对订阅源设置的修改。' : ''),
            action,
          })) return
          setBusy('candidate')
          try {
            if (applyState(await call('candidate', { id: form.id, accept: accepting }))) {
              guard.leave(() => navigate('nodes', form.id))
            }
          } catch (cause) { const error = asError(cause); setProblem(error) } finally { setBusy('') }
        }}>{record.pending.accepted ? '撤销采纳' : '采纳候选节点'}</Button>}>{record.pending.reason}</Alert>}
      {!filtering && <form className="stack" id={formId} ref={settingsForm} noValidate inert={Boolean(busy)} onSubmit={event => {
        event.preventDefault()
        if (source) void commit()
        else void previewInput(true)
      }}>
        <h2 className="sr-only" tabIndex={-1} ref={stepHeading}>订阅设置</h2>
        <FieldGroup className="form-grid">
          <Field label="订阅源名称" name="source_name" error={problem?.field === 'name' ? problem.message : undefined}><Input placeholder="例如主订阅" maxLength={256} value={form.name} onChange={event => change('name', event.target.value)} /></Field>
          <Field label="节点名称前缀（可选）" hint="加在节点原名之前。"><Input maxLength={256} placeholder="[A] " value={form.tag} onChange={event => change('tag', event.target.value)} /></Field>
        </FieldGroup>
        {!source && <FieldSet className="source-import-mode">
          <FieldLegend variant="label">导入方式</FieldLegend>
          <Segmented label="导入方式" items={importModes} value={inputMode} onChange={changeMode} />
        </FieldSet>}
        {!local && <Field label="订阅地址" name="subscription_url" disabled={readingAddress} error={problem?.field === 'url' ? problem.message : undefined}
          hint={addressUnavailable ? '无法读取已保存的地址。留空沿用原地址。' : form.urlStored ? '留空沿用已保存的订阅地址。' : undefined}>
          <Input type="url" spellCheck={false} autoCapitalize="none" maxLength={8192} placeholder={readingAddress ? '正在读取订阅地址…' : 'https://…'}
            value={form.url} onChange={event => change('url', event.target.value)} />
        </Field>}
        {localInput && <div className="stack tight">
          <Field label={inputMode === 'yaml' ? 'YAML 内容' : '节点分享链接'} name="source_content"
            hint={inputMode === 'yaml' ? '支持含 proxies 的配置或节点数组。' : '每行一条，也可粘贴 Base64 编码的链接列表。'}
            error={problem?.field === 'content' ? problem.message : undefined}>
            <Textarea className="source-import-text" rows={4} spellCheck={false} autoCapitalize="none"
              value={localInput.text} onChange={event => changeText(event.target.value)}
              placeholder={inputMode === 'yaml' ? 'proxies:\n  - name: 香港 01\n    type: vmess\n    …' : 'ss://…\nssr://…\nvmess://…\nvless://…'} />
          </Field>
          {inputMode === 'yaml' && <div className="actions">
            <Input ref={yamlFile} type="file" accept=".yaml,.yml,application/yaml,text/yaml" hidden aria-label="YAML 文件" onChange={readYamlFile} />
            <Button size="small" icon={Upload} busy={busy === 'file'} onClick={() => yamlFile.current?.click()}>选择 YAML 文件</Button>
          </div>}
        </div>}
        {source && !form.local && <div className="actions">
          <Button icon={RefreshCw} size="small" busy={busy === 'test'} onClick={() => previewInput()}>测试订阅</Button>
          {!!testResult?.nodes.length && <Badge tone="success" role="status">{formatNumber(testResult.nodes.length)} 个可导入</Badge>}
        </div>}
        {testResult?.savedData && <p className="muted field-note">筛选使用已保存的节点。可从订阅源列表刷新节点。</p>}
        {!!testResult?.rejected.length && <RejectedItems data={testResult} />}
        <Field label="续费日期（可选）" name="renewal_date" error={problem?.field === 'renewalDate' ? problem.message : undefined}
          hint={local ? `概览会在续费前 ${renewalNoticeDays} 天内提醒一次。` : `概览提前 ${renewalNoticeDays} 天提醒。留空时采用订阅到期日。`}>
          <Input ref={renewalInput} type="date" min="0001-01-01" max="9999-12-31" value={form.renewalDate ?? ''} onChange={event => change('renewalDate', event.target.value)} />
        </Field>
        {!local && <Disclosure title={'刷新设置 · ' + (!form.enabled ? '已停用' : form.paused ? '已暂停' : `每 ${form.minutes} 分钟`)} open={advanced} onOpenChange={setAdvanced}>
          <Field label="更新间隔（分钟）" name="refresh_minutes" error={problem?.field === 'minutes' ? problem.message : undefined}><Input type="number" min="1" max="43200" value={form.minutes} onChange={event => change('minutes', Number(event.target.value))} /></Field>
          <FieldGroup className="toggle-list" aria-label="订阅源状态">
            <Toggle label="启用订阅源" detail="停用后，下一次发布将排除该订阅源。" checked={form.enabled} onChange={value => change('enabled', value)} />
            <Toggle label="暂停定时刷新" detail="暂停后仍可手动刷新。" checked={form.paused} onChange={value => change('paused', value)} />
          </FieldGroup>
        </Disclosure>}
      </form>}
      {filtering && <div className="stack" inert={Boolean(busy)}>
        <h2 className="sr-only" tabIndex={-1} ref={stepHeading}>筛选与预览</h2>
        {data && <div className="source-preview-summary">
          <p className="preview-counts" role="status">
            <strong>保留 {formatNumber(retained)} / {formatNumber(data.total)}</strong>
            <span>排除 {formatNumber(rows.length - retained)}</span>
            {unknown > 0 && <span>未知地区 {formatNumber(unknown)}</span>}
            {source && changeCount !== 0 && <span>保留变化 {changeCount > 0 ? '+' : ''}{changeCount}</span>}
          </p>
        </div>}
        {!!data?.rejected.length && <div className="stack tight">
          {localInput && <p className="field-note" role="status">保存时将跳过无法导入的条目。</p>}
          <RejectedItems data={data} />
        </div>}
        <FilterForm filter={form.filter} onChange={value => change('filter', value)} reset={() => change('filter', structuredClone(defaultFilter))} />
        <Disclosure compact title="筛选模板">
          {state.library.filters.length > 0 && <Field label="套用筛选模板">
            <NativeSelect value="" onChange={event => {
              const filter = state.library.filters.find(entry => entry.id === event.target.value)?.filter
              if (filter) change('filter', { ...structuredClone(filter), manual: form.filter.manual })
            }}><NativeSelectOption value="">请选择模板</NativeSelectOption>
              {state.library.filters.map(template => <NativeSelectOption key={template.id} value={template.id}>{template.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>}
          <Field label="筛选模板名称"><Input placeholder="例如香港节点" value={templateName} onChange={event => setTemplateName(event.target.value)} /></Field>
          <div><Button size="small" disabled={!templateName.trim()} onClick={storeFilter} busy={busy === 'template'}>保存模板</Button></div>
        </Disclosure>
        <section className="stack tight source-preview">
          <h3>节点预览</h3>
          {rows.length > 0 && <div className="filters"><SearchBox placeholder="搜索节点" value={previewQuery} onChange={value => { setPreviewQuery(value); setOffset(0) }} />
            <NativeSelect aria-label="预览状态" value={previewFilter} onChange={event => { setPreviewFilter(event.target.value); setOffset(0) }}>
              <NativeSelectOption value="all">全部节点</NativeSelectOption><NativeSelectOption value="kept">仅保留</NativeSelectOption><NativeSelectOption value="excluded">仅排除</NativeSelectOption>
            </NativeSelect>
          </div>}
          {previewRows.length ? <div className="preview-table">
            <Table className="mobile-table" scrollLabel="筛选预览"><TableHeader><TableRow><TableHead>最终名称 / 原始名称</TableHead><TableHead>地区</TableHead><TableHead>状态与原因</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
              {previewRows.slice(offset, offset + 20).map(row => <TableRow key={row.key}><TableCell className="table-row-title"><NodeNames row={row} /></TableCell><TableCell mobileLabel="地区">{regionLabel(row.region)}</TableCell>
                <TableCell><NodeState row={row} /></TableCell><TableCell className="table-row-wide"><Button size="small" variant="ghost" onClick={() => toggleManual(row.id)}>{form.filter.manual.includes(row.id) ? '撤销手动排除' : '手动排除'}</Button></TableCell>
              </TableRow>)}
            </TableBody></Table>
            {previewRows.length > 20 && <Pager offset={offset} pageSize={20} count={previewRows.length} onChange={setOffset} />}
          </div> : <Empty icon={Network} title={rows.length ? '没有匹配的节点' : '暂无可预览的节点'}
            actions={rows.length ? <Button size="small" onClick={() => { setPreviewFilter('all'); setPreviewQuery(''); setOffset(0) }}>清除筛选</Button>
              : <Button size="small" onClick={() => showStep('settings')}>返回订阅设置</Button>} />}
        </section>
      </div>}
    </div>
  </Modal>
}

function RejectedItems({ data }: { data: SourceData }) {
  const [offset, setOffset] = usePage(data.rejected.length, 20)
  return <Disclosure title={'查看 ' + formatNumber(data.rejected.length) + ' 项无法导入的内容'}>
    <ul className="compact-list">{data.rejected.slice(offset, offset + 20).map((item, i) => <li key={i}>{item.item} · {item.reason}</li>)}</ul>
    <Pager offset={offset} pageSize={20} count={data.rejected.length} onChange={setOffset} />
  </Disclosure>
}

const billingCalendar = calendarFormatter()
const byteUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
const byteNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

function remainingTraffic(info: SubscriptionInfo | null | undefined, empty: string) {
  if (info?.total === 0) return '不限量'
  if (info?.total == null || info.upload == null || info.download == null) return empty
  const bytes = Math.max(0, info.total - info.upload - info.download)
  const unit = Math.floor(Math.log2(Math.max(1, bytes)) / 10)
  return byteNumber.format(bytes / 1024 ** unit) + ' ' + byteUnits[unit]
}

function SubscriptionFacts({ source, record }: { source: Source; record: SourceRecord }) {
  const info = record?.subscriptionInfo
  const empty = info || record?.lastSuccess ? '上游未提供' : '暂无数据'
  const expiresOn = info?.expire && info.expire > 0 ? billingCalendar.format(info.expire * 1000) : null
  return <dl className="subscription-facts" aria-label={source.local ? '本地来源信息' : '流量与续费'}>
    {!source.local && <>
      <div><dt>剩余流量</dt><dd>{remainingTraffic(info, empty)}</dd></div>
      <div><dt>订阅到期日</dt><dd>{expiresOn ? <time dateTime={expiresOn}>{expiresOn}</time> : info?.expire === 0 ? '长期有效' : empty}</dd></div>
    </>}
    {(!source.local || source.renewalDate) && <div><dt>续费日期</dt><dd><RouteLink page="sources" id={source.id} detail="renewal">
      {source.renewalDate ? <time dateTime={source.renewalDate}>{source.renewalDate}</time> : '设置日期'}
      <span className="sr-only">，编辑{source.name}的续费日期</span>
    </RouteLink></dd></div>}
    <div><dt>{source.local ? '导入时间' : '数据更新时间'}</dt><dd><TimeLabel value={info?.updatedAt ?? record?.lastSuccess} /></dd></div>
  </dl>
}

function SourceCard({ source, record, stats, index, total, checked, onCheck, move, refresh, editMany, remove, busy }: { source: Source; record: SourceRecord; stats: Pick<SourceStats, 'retained' | 'original'>; index: number; total: number; checked: boolean; onCheck: (checked: boolean) => void; move: (from: number, to: number) => void; refresh: (ids: string[]) => void; editMany: (ids: string[], changes: Partial<Source>) => void; remove: (ids: string[]) => void; busy: string }) {
  const { navigate } = useProject()
  const confirm = useConfirm()
  async function changeEnabled(enabled: boolean) {
    if (enabled || await confirm({ title: '停用此订阅源？', detail: '下一次发布将排除此订阅源的节点。', action: '停用订阅源' })) editMany([source.id], { enabled })
  }
  return <article className="source-card" aria-label={source.name} data-sort-row {...dragProps(index, move, 'source')}>
    <header className="source-card-head">
      <div className="source-card-heading">
        <div className="source-card-identity">
          <Checkbox aria-label={'选择订阅源 ' + source.name} checked={checked} onCheckedChange={onCheck} />
          <h2><RouteLink page="sources" id={source.id}>{source.name}</RouteLink></h2>
          {source.tag && <code className="tech-chip" title="节点名称前缀">{source.tag}</code>}
          <SourceStatus entry={source} record={record} />
          <RouteLink className="soft-count" page="nodes" id={source.id}>保留 {countText(stats.retained, stats.original)}</RouteLink>
        </div>
        <div className="source-card-actions" inert={Boolean(busy)}>
          <ButtonLink icon={Pencil} size="small" variant="ghost" page="sources" id={source.id}>{source.local ? '编辑本地来源' : '编辑订阅源设置'}</ButtonLink>
          <div className="row-actions">
            <MoveButtons index={index} count={total} onMove={move} area="source" />
            <IconButton icon={Trash2} className="delete-action" label={'删除 ' + source.name} onClick={() => remove([source.id])} />
          </div>
        </div>
      </div>
      <div className="source-card-tools" inert={Boolean(busy)}>
        <label className="inline-switch"><Switch checked={source.enabled} onCheckedChange={changeEnabled} />参与整合</label>
        {!source.local && <><label className="inline-switch"><Switch checked={!source.paused} disabled={!source.enabled} onCheckedChange={value => editMany([source.id], { paused: !value })} />自动更新（{formatNumber(source.minutes)} 分钟）</label>
          <Button icon={RefreshCw} size="small" aria-label={'立即刷新 ' + source.name} disabled={Boolean(busy) || ['queued', 'running'].includes(record?.status)} onClick={() => refresh([source.id])}>立即刷新</Button></>}
        <ButtonLink icon={FilterIcon} size="small" page="nodes" id={source.id}>节点筛选</ButtonLink>
      </div>
    </header>
    <div className="source-card-body">
      <SubscriptionFacts source={source} record={record} />
      {record?.error && <Alert tone="warning">{record.error}</Alert>}
      {record?.pending && <Alert tone="warning" title={record.pending.accepted ? '已采纳候选节点' : '有待确认的候选节点'}
        action={<Button size="small" onClick={() => navigate('sources', source.id, 'filter')}>查看候选</Button>}>{record.pending.reason}</Alert>}
    </div>
  </article>
}

export function SourcesPage() {
  const { state, view, route, call, save, reload, applyState, notify, navigate } = useProject()
  const confirm = useConfirm()
  const [query, setQuery] = useSearchValue('q')
  const [status, setStatus] = useSearchValue('status', 'all')
  const [selected, setSelected] = useState<string[]>([])
  const [remove, setRemove] = useState<string[] | null>(null)
  const [busy, setBusy] = useState('')
  const importInput = useRef<HTMLInputElement>(null)
  const sources = state.draft.sources
  const visible = sources.filter(source => (searchable(source.name, query) || searchable(source.tag, query))
    && (status === 'all' || status === 'enabled' && source.enabled || status === 'disabled' && !source.enabled || status === 'failed' && state.sources[source.id]?.error))
  const [offset, setOffset] = useListPage(visible.length, 30)
  const pageSources = visible.slice(offset, offset + 30)
  const checked = new Set(selected)
  const modalSource = sources.find(source => source.id === route.id)
  const stats = Object.fromEntries(view.sources.map(entry => [entry.id, entry]))
  const canRefresh = sources.some(source => !source.local && source.enabled && !['running', 'queued'].includes(state.sources[source.id]?.status))
  const selectedRemote = selected.filter(id => sources.some(source => source.id === id && !source.local))
  const setSources = (values: Source[], groups = state.draft.groups) => save({ ...state.draft, sources: values, groups })

  async function run(label: string, action: () => unknown) {
    if (busy) return
    setBusy(label)
    try { await action() } catch (cause) { const error = asError(cause); notify(error.message, 'danger') } finally { setBusy('') }
  }
  const move = (from: number, to: number) => run('save', () => setSources(moveAt(sources, from, to)))
  const refresh = (ids?: string[]) => run('refresh', async () => {
    if (ids) await Promise.all(ids.map(id => call('refresh', { id })))
    else await call('refresh', {})
    await reload()
  })
  const editMany = (ids: string[], changes: Partial<Source>) => run('save', () => setSources(sources.map(source => ids.includes(source.id) ? { ...source, ...changes } : source)))
  const removeSources = () => run('remove', async () => {
    if (!remove) return
    const remaining = sources.filter(source => !remove.includes(source.id))
    const availableIds = new Set(remaining.map(source => source.id))
    await setSources(remaining, state.draft.groups.map(group => ({
      ...group, members: membersForSources(group.members, availableIds),
    })))
    setSelected(values => values.filter(id => !remove.includes(id)))
    setRemove(null)
  })
  async function importSources(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !await confirm({ title: '导入订阅源设置？', detail: '文件中的订阅源会追加到当前方案。服务端会按其设置刷新。', action: '导入订阅源' })) return
    await run('import', async () => {
      const body = JSON.parse(await file.text())
      if (body.version !== 1) throw new Error('请选择 SubMeld 导出的订阅源设置文件。')
      if (applyState(await call('sources/import', { ...body, revision: state.revision }))) {
        notify('订阅源设置已导入')
      }
    })
  }
  const removing = remove ? sources.filter(source => remove.includes(source.id)) : []
  const impacted = remove ? [...new Set(remove.flatMap(id => sourceReferences(state.draft, id).map(group => group.name)))] : []
  return <div className="config-page stack">
    <h1 className="sr-only" tabIndex={-1}>订阅源</h1>
    <Panel title="订阅源" count={formatNumber(sources.length)}
      actions={<>
        {sources.length > 0 && <Button icon={RefreshCw} size="small" busy={busy === 'refresh'} disabled={Boolean(busy) || !canRefresh} onClick={() => refresh()}>刷新全部</Button>}
        <Button variant="primary" size="small" icon={Plus} onClick={() => navigate('sources', 'new')}>添加订阅源</Button>
      </>}>
      <div className="config-toolbar">
        <div className="filters">{sources.length > 0 && <>
          <label className="page-checkbox"><Checkbox aria-label="选择当前页订阅源" checked={!!pageSources.length && pageSources.every(item => checked.has(item.id))} onCheckedChange={enabled => setSelected(enabled ? [...new Set([...selected, ...pageSources.map(item => item.id)])] : selected.filter(id => !pageSources.some(item => item.id === id)))} /><span>全选本页</span></label>
          <SearchBox value={query} onChange={value => { setQuery(value); setOffset(0) }} placeholder="搜索订阅源名称或前缀" />
          <NativeSelect aria-label="订阅源状态" value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}>
            <NativeSelectOption value="all">全部状态</NativeSelectOption><NativeSelectOption value="enabled">已启用</NativeSelectOption><NativeSelectOption value="disabled">已停用</NativeSelectOption><NativeSelectOption value="failed">有异常</NativeSelectOption>
          </NativeSelect></>}
        </div>
        <div className="actions"><Input ref={importInput} type="file" accept=".json,application/json" hidden onChange={importSources} aria-label="选择订阅源设置文件" />
          <Button icon={Upload} size="small" busy={busy === 'import'} disabled={Boolean(busy)} onClick={() => importInput.current?.click()}>导入设置</Button>
          {sources.length > 0 && <Button icon={Download} size="small" busy={busy === 'export'} disabled={Boolean(busy)} onClick={async () => {
            if (await confirm({ title: '导出订阅源设置？', detail: sources.some(source => source.local) ? '导出的文件包含本地节点的连接凭据，以及已配置的订阅地址。' : '导出的文件含有原始订阅地址和令牌，请妥善保存。', action: '导出设置' })) {
              await run('export', async () => downloadJson('SubMeld-订阅源设置.json', await call('sources/export')))
            }
          }}>导出设置</Button>}
        </div>
      </div>
      {!!selected.length && <div className="batch-bar" inert={Boolean(busy)}>
        <strong>已选 {selected.length} 项</strong><Button size="small" disabled={!selectedRemote.length} onClick={() => refresh(selectedRemote)}>刷新选中</Button>
        <Button size="small" onClick={() => editMany(selected, { enabled: true })}>启用</Button>
        <Button size="small" onClick={async () => {
          if (await confirm({ title: '停用选中的订阅源？', detail: '下次发布时，订阅将移除这些订阅源的节点。', action: '停用订阅源' })) editMany(selected, { enabled: false })
        }}>停用</Button>
        <Button size="small" disabled={!selectedRemote.length} onClick={() => editMany(selectedRemote, { paused: true })}>暂停更新</Button>
        <Button size="small" disabled={!selectedRemote.length} onClick={() => editMany(selectedRemote, { paused: false })}>恢复更新</Button>
        <Button size="small" variant="danger" onClick={() => setRemove(selected)}>删除</Button>
        <Button size="small" variant="ghost" onClick={() => setSelected([])}>清除选择</Button>
      </div>}
      {!visible.length && <Empty icon={Radio} title={sources.length ? '没有匹配的订阅源' : '还没有订阅源'} detail={!sources.length && '添加订阅源后，可按地区和关键词筛选节点。'}
        actions={sources.length > 0 && <Button onClick={() => { setQuery(''); setStatus('all'); setOffset(0) }}>清除筛选</Button>} />}
    </Panel>
    {pageSources.map(source => <SourceCard key={source.id} source={source} stats={stats[source.id]} record={state.sources[source.id]}
      index={sources.indexOf(source)} total={sources.length} checked={checked.has(source.id)} busy={busy} move={move} refresh={refresh} editMany={editMany} remove={setRemove}
      onCheck={enabled => setSelected(enabled ? [...selected, source.id] : selected.filter(id => id !== source.id))} />)}
    {visible.length > 30 && <Pager offset={offset} pageSize={30} count={visible.length} onChange={setOffset} />}
    {(modalSource || route.id === 'new') && <SourceEditor key={(modalSource?.id ?? 'new') + '/' + route.detail} source={modalSource} first={route.detail} onClose={() => navigate('sources')} />}
    {remove && <Modal title="删除订阅源" detail="当前成品会继续可用，移除结果需要正式发布。" onClose={() => !busy && setRemove(null)} footer={<><Button disabled={Boolean(busy)} onClick={() => setRemove(null)}>取消</Button><Button variant="danger" busy={busy === 'remove'} disabled={Boolean(busy)} onClick={removeSources}>确认删除</Button></>}>
      <div className="stack tight"><p>将删除 {removing.map(source => source.name).join('、')}。</p>
        {impacted.length > 0 && <Alert tone="warning">以下代理组将移除来自这些订阅源的节点和筛选条件。请在发布前检查组内代理。{impacted.join('、')}</Alert>}
      </div>
    </Modal>}
  </div>
}

export function NodeNames({ row }: { row: Pick<NodeView, 'name' | 'originalName'> }) {
  return <div className="node-names"><strong translate="no">{row.name}</strong>
    {row.name !== row.originalName && <small>原名 <span translate="no">{row.originalName}</span></small>}</div>
}

export function NodeState({ row }: { row: Pick<NodeView, 'kept' | 'reasons'> & Partial<Pick<NodeView, 'collision' | 'duplicateCount' | 'duplicates'>> }) {
  return <div className="node-state">
    <div className="chips">{row.kept ? <Badge tone="success">保留</Badge> : <Badge tone="neutral">排除</Badge>}
      {row.collision && <Badge tone="danger">名称冲突</Badge>}
      {!!row.duplicateCount && <Badge tone="warning" >精确重复 · {row.duplicateCount}</Badge>}
    </div>
    {row.reasons.length > 0 && <small>{row.reasons.join(' · ')}</small>}
    {!!row.duplicateCount && <small title={row.duplicates?.map(item => item.source + ' · ' + item.name).join('\n')}>连接参数相同 · {row.duplicates?.map(item => item.source).join('、')}</small>}
  </div>
}

function SourcePolicy({ source, busy, saveFilter }: { source: Source; busy: boolean; saveFilter: (filter: Filter) => void }) {
  const { filter } = source
  const update = <K extends keyof Filter>(key: K, value: Filter[K]) => saveFilter({ ...filter, [key]: value })
  const automatic = { ...filter, manual: [] }
  return <Panel className="source-policy" title={<><span className="policy-title-mark"><FilterIcon aria-hidden="true" />筛选条件</span>{source.name}</>}
    actions={<><ButtonLink page="sources" id={source.id} detail="filter" size="small" icon={ListFilter}>筛选预览与模板</ButtonLink>
      <Button variant="ghost" size="small" icon={RotateCcw} disabled={busy || JSON.stringify(automatic) === JSON.stringify(defaultFilter)}
        onClick={() => saveFilter({ ...structuredClone(defaultFilter), manual: filter.manual })}>重置条件</Button></>}>
    <div className="policy-body" inert={busy}>
      <div className="policy-regions">{([['keep', '仅保留地区'], ['exclude', '排除地区']] as const).map(([key, label]) =>
        <FieldSet key={key} className="region-field"><FieldLegend variant="label">{label}</FieldLegend>
          <ToggleGroup type="multiple" aria-label={label} value={filter[key]} onValueChange={values => update(key, values)} className="region-pills">
            {regionOptions.map(([code, name]) => <ToggleGroupItem key={code} value={code} size="sm">{name}</ToggleGroupItem>)}
          </ToggleGroup>
        </FieldSet>)}</div>
      <div className="unknown-policy"><div><h3>未知地区处理策略</h3><p className="field-note muted">地区由节点名称推断。</p></div>
        <Segmented label="未知地区处理策略" items={ [['auto', '遵循地区条件'], ['keep', '保留未知地区'], ['exclude', '排除未知地区']] } value={filter.unknown} onChange={value => update('unknown', value)} /></div>
      <KeywordEditor keywords={filter.keywords} onChange={value => update('keywords', value)} />
    </div>
  </Panel>
}

export function NodesPage() {
  const { state, view, route, save, call, reload, notify, quality } = useProject()
  const [sort, setSort] = useSearchValue('sort')
  const [presetId, setPreset] = useSearchValue('quality')
  const [probeParam, setProbeParam] = useSearchValue('probe')
  const preset = Object.hasOwn(qualityPresets, presetId) ? qualityPresets[presetId] : undefined
  const reverse = sort.startsWith('-')
  const key = reverse ? sort.slice(1) : sort
  const sortKey = Object.hasOwn(qualitySortLabels, key) ? key as QualitySort : null
  const probeOptions = useMemo(() => {
    const seen = new Set<string>()
    const list: { id: string; label: string }[] = []
    for (const d of quality.devices) {
      seen.add(d.id)
      list.push({ id: d.id, label: (d.remark || d.name) + (d.status === 'offline' ? '（离线）' : '') })
    }
    for (const id of Object.keys(quality.latest)) {
      if (!seen.has(id)) list.push({ id, label: quality.deviceNames.get(id) ?? '历史探针' })
    }
    return list
  }, [quality.devices, quality.latest, quality.deviceNames])
  const activeDeviceId = useMemo(() => {
    if (probeParam && probeOptions.some(p => p.id === probeParam)) return probeParam
    return Object.keys(quality.latest)[0] ?? quality.devices[0]?.id ?? ''
  }, [probeParam, probeOptions, quality.latest, quality.devices])
  const activeSnapshot = useMemo(() => quality.snapshotFor(activeDeviceId), [quality, activeDeviceId])
  const readings = activeSnapshot?.rows
  const showQuality = Boolean(quality.hasData || activeSnapshot || sortKey)
  const metricSort: QualitySort = sortKey && sortKey !== 'availability' && sortKey !== 'ai' && !(sortKey in platformSurfaces) ? sortKey : 'https'
  const awaitingQuality = Boolean(preset || sortKey) && !quality.ready
  const focusNode = view.nodes.find(row => row.sourceId === route.id && row.id === route.detail)
  const [sourceParam, setSource] = useSearchValue('source', route.id ?? 'all')
  const source = sourceParam === 'all' ? '' : sourceParam
  const [query, setQuery] = useSearchValue('q')
  const [areaParam, setAreas] = useSearchValue('region')
  const areas = areaParam.split(',').filter(value => regionOptions.some(([code]) => code === value))
  const [status, setStatus] = useSearchValue('status', focusNode?.collision ? 'conflicts' : 'all')
  const [selected, setSelected] = useState<string[]>([])
  const [note, setNote] = useState<NoteEditor | null>(null)
  const [busy, setBusy] = useState(false)
  const selectedSet = new Set(selected)
  const noteOriginal = note ? state.notes[note.row.key] : null
  const guard = useUnsavedChanges(Boolean(note && (note.favorite !== (noteOriginal?.favorite ?? false) || note.text !== (noteOriginal?.note ?? ''))), '节点的收藏和备注将恢复为修改前的内容。')
  useEffect(() => {
    if (route.detail) {
      setSource(route.id ?? 'all')
      setStatus(focusNode?.collision ? 'conflicts' : 'all')
      setQuery('')
      setAreas('')
    }
  }, [route.id, route.detail])
  const nodes = view.nodes.filter(row => (!preset || !qualityReason(preset.condition, readings?.[row.key], activeSnapshot?.config)) && (!source || source === row.sourceId) && (!areas.length || areas.includes(row.region))
    && (searchable(row.name, query) || searchable(row.originalName, query) || searchable(state.notes[row.key]?.note, query))
    && (status === 'all' || status === 'kept' && row.kept || status === 'excluded' && !row.kept || status === 'conflicts' && row.collision || status === 'favorites' && state.notes[row.key]?.favorite))
  if (sortKey) nodes.sort((a, b) => compareQuality(readings?.[a.key], readings?.[b.key], sortKey, reverse, isSubscriptionNotice(a.originalName), isSubscriptionNotice(b.originalName)))
  const [offset, setOffset] = useListPage(nodes.length)
  useEffect(() => {
    if (!route.detail) return
    const index = nodes.findIndex(row => row.id === route.detail && row.sourceId === route.id)
    if (index >= 0) setOffset(Math.floor(index / 40) * 40)
  }, [source, route.id, route.detail, status])
  const visible = nodes.slice(offset, offset + 40)
  const activeSource = state.draft.sources.find(entry => entry.id === source)
  const sources = source ? view.sources.filter(entry => entry.id === source) : view.sources
  const raw = sources.reduce((sum, item) => sum + item.original, 0)
  const excluded = sources.reduce((sum, item) => sum + item.excluded, 0)
  const retained = sources.reduce((sum, item) => sum + item.retained, 0)
  const unknown = sources.reduce((sum, item) => sum + item.unknown, 0)
  const unsupported = sources.reduce((sum, item) => sum + item.unsupported, 0)
  async function saveFilter(filter: Filter) {
    if (busy) return
    setBusy(true)
    try { await save({ ...state.draft, sources: state.draft.sources.map(item => item.id === source ? { ...item, filter } : item) }, state.revision, '筛选条件已更新') }
    catch (cause) { const error = asError(cause); notify(error.message, 'danger') }
    finally { setBusy(false) }
  }
  function changeScope(value: string) {
    setSource(value)
    setOffset(0)
    setSelected([])
  }
  const statuses = [['all', '全部'], ['kept', '已保留'], ['excluded', '已排除'], ['conflicts', '名称冲突'], ['favorites', '已收藏']] as const
  function changeStatus(value: string) {
    setStatus(value)
    setOffset(0)
    setSelected([])
  }
  const scopes: [string, string][] = [['all', '全部订阅源（' + countText(view.counts.nodes, view.originalNodes) + '）'],
    ...view.sources.map((item): [string, string] => [item.id, item.name + '（' + countText(item.retained, item.original) + '）'])]
  async function setManual(keys: string[], excluded: boolean) {
    if (busy) return
    setBusy(true)
    const bySource = new Map()
    for (const key of keys) {
      const [source, id] = key.split('/')
      if (!bySource.has(source)) bySource.set(source, [])
      bySource.get(source).push(id)
    }
    try {
      await save({ ...state.draft, sources: state.draft.sources.map(source => {
        const ids = bySource.get(source.id)
        if (!ids) return source
        const manual = excluded ? [...new Set([...source.filter.manual, ...ids])] : source.filter.manual.filter(id => !ids.includes(id))
        return { ...source, filter: { ...source.filter, manual } }
      }) })
      setSelected([])
    } catch (cause) { const error = asError(cause); notify(error.message, 'danger') } finally { setBusy(false) }
  }
  async function savePool() {
    if (busy) return
    const filteredKeys = status === 'favorites' || status === 'conflicts' ? view.nodes.filter(n =>
      status === 'favorites' ? state.notes[n.key]?.favorite : n.collision).map(n => n.key) : undefined
    const noteMatches = query.trim() ? view.nodes.filter(n => searchable(state.notes[n.key]?.note, query)).map(n => n.key) : []
    const hasQuality = Boolean(preset || sortKey)
    const pool = poolCondition({ sourceIds: source ? [source] : [], regions: areas,
      quality: sortKey ? { ...preset?.condition, sortBy: sortKey, sortReverse: reverse } : preset?.condition,
      search: query.trim(), nodeKeys: filteredKeys, noteMatches: noteMatches.length ? noteMatches : undefined })
    const base = (activeSource?.name || '节点').slice(0, 230) + ' · ' + (preset?.name || '筛选池')
    const taken = new Set([...state.draft.groups.map(g => g.name), ...view.nodes.map(n => n.name)])
    let name = base
    for (let i = 2; taken.has(name); i++) name = base + ' ' + i
    setBusy(true)
    try {
      await save({ ...state.draft, groups: [...state.draft.groups, { id: newId(), name, type: 'select', enabled: true, ...(hasQuality && activeDeviceId ? { qualityDeviceId: activeDeviceId } : {}), members: [pool] }] }, state.revision, '已保存到代理组「' + name + '」')
    } catch (e) { notify(asError(e).message, 'danger') } finally { setBusy(false) }
  }
  async function saveNote(value: NoteEditor) {
    if (busy) return
    setBusy(true)
    try {
      await call('note', { sourceId: value.row.sourceId, nodeId: value.row.id, favorite: value.favorite, note: value.text })
      await reload()
      guard.leave(() => setNote(null))
      notify('节点备注已保存')
    } catch (cause) { const error = asError(cause); notify(error.message, 'danger') } finally { setBusy(false) }
  }
  return <div className="stack config-page">
    <h1 className="sr-only" tabIndex={-1}>节点管理</h1>
    <Panel className="source-scope" title="节点范围与筛选" count={countText(retained, raw)} actions={<>
      <div className="scope-pills"><Segmented label="来源筛选" items={scopes} value={sourceParam} onChange={changeScope} /></div>
      <div className="scope-select"><NativeSelect aria-label="来源筛选" value={sourceParam} onChange={event => changeScope(event.target.value)}>{scopes.map(([value, name]) => <NativeSelectOption key={value} value={value}>{name}</NativeSelectOption>)}</NativeSelect></div>
      <QualityControl selected={selected} filtered={nodes.map(node => node.key)} />
      <ButtonLink page="quality" id="schedules" size="small" variant="ghost" icon={Clock}>定时与报告</ButtonLink>
    </>} />
    <div className="node-quality-bar">
      <div className="quality-probe-picker">
        {probeOptions.length > 1 ? (
          <NativeSelect aria-label="质量探针" value={activeDeviceId} onChange={e => setProbeParam(e.target.value)}>
            {probeOptions.map(p => <NativeSelectOption key={p.id} value={p.id}>{p.label}</NativeSelectOption>)}
          </NativeSelect>
        ) : probeOptions.length === 1 ? (
          <span className="field-note muted">探针：{probeOptions[0].label}</span>
        ) : (
          <span className="field-note muted">{quality.error ? '' : quality.ready ? '暂无质量记录' : '正在读取质量记录…'}</span>
        )}
        {quality.error && <div className="actions" role="alert"><span className="error-text">{quality.error}</span><Button size="small" onClick={quality.refresh}>重新读取</Button></div>}
      </div>
      <div className="actions"><NativeSelect aria-label="节点质量筛选" value={preset?.name ? presetId : ''} onChange={e => { setPreset(e.target.value); setOffset(0); setSelected([]) }}>
        <NativeSelectOption value="">不限质量</NativeSelectOption>{Object.entries(qualityPresets).map(([id, p]) => <NativeSelectOption key={id} value={id}>{p.name}</NativeSelectOption>)}
      </NativeSelect><Button size="small" icon={Plus} disabled={busy || awaitingQuality || !nodes.some(n => n.kept)} onClick={savePool}>保存为代理组筛选池</Button></div>
    </div>
    {activeSource && <SourcePolicy key={activeSource.id} source={activeSource} busy={busy} saveFilter={saveFilter} />}
    <Panel className="node-detail" title={<>节点明细 <span className="soft-count">共 {formatNumber(raw)}</span> <Badge tone="success">保留 {formatNumber(retained)}</Badge> <Badge>排除 {formatNumber(excluded)}</Badge>
      {unknown > 0 && <> <Badge tone="warning">未知 {formatNumber(unknown)}</Badge></>}{unsupported > 0 && <> <Badge tone="danger">无法导入 {formatNumber(unsupported)}</Badge></>}</>}
      actions={view.nodes.length > 0 && <div className="filters">
        <div className="scope-pills"><Segmented label="节点状态" items={statuses} value={status} onChange={changeStatus} /></div>
        <div className="scope-select"><NativeSelect aria-label="节点状态" value={status} onChange={event => changeStatus(event.target.value)}>{statuses.map(([key, label]) => <NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}</NativeSelect></div>
        <SearchBox placeholder="搜索节点名或备注" value={query} onChange={value => { setQuery(value); setOffset(0) }} />
        <MultiSelect label="地区筛选" options={regionOptions} values={areas} onChange={value => { setAreas(value.join(',')); setOffset(0) }} placeholder="全部地区" />
      </div>}>
      {showQuality && <QualitySortBar sort={sortKey} reverse={reverse} change={value => { setSort(value); setOffset(0) }} />}
      {status === 'conflicts' && nodes.length > 0 && <p className="panel-padding warning-text field-note">可修改名称前缀或排除重名节点。选择「全部订阅源」可查看跨来源的重名节点。</p>}
      {!!selected.length && <div className="batch-bar"><strong>已选 {selected.length} 个节点</strong>
        <Button size="small" onClick={() => setManual(selected, true)} busy={busy}>批量排除</Button>
        <Button size="small" onClick={() => setManual(selected, false)} disabled={busy}>撤销手动排除</Button>
        <Button variant="ghost" size="small" onClick={() => setSelected([])}>清除选择</Button></div>}
      {awaitingQuality ? <p className="panel-padding muted" role="status">{quality.error ? '重新读取质量记录后可显示筛选结果。' : '正在读取质量记录…'}</p> : !visible.length ? <Empty icon={Network} title={view.nodes.length ? '没有匹配的节点' : '暂无节点'}
        actions={view.nodes.length ? <Button onClick={() => { setSource('all'); setStatus('all'); setQuery(''); setAreas(''); setPreset(''); setOffset(0) }}>清除筛选</Button>
          : <ButtonLink icon={ChevronRight} page="sources">查看订阅源</ButtonLink>} />
        : <><Table className="nodes-table mobile-table" scrollLabel="当前页节点"><TableHeader><TableRow><TableHead><PageCheckbox label="选择当前页节点" checked={visible.every(row => selectedSet.has(row.key))} onCheckedChange={enabled => setSelected(enabled ? [...new Set([...selected, ...visible.map(row => row.key)])] : selected.filter(key => !visible.some(row => row.key === key)))} /></TableHead>
          <TableHead>状态</TableHead><TableHead>整合后名称与节点属性</TableHead>{showQuality && <><TableHead>可用率</TableHead><TableHead>{qualitySortLabels[metricSort]}</TableHead><TableHead>AI 解锁</TableHead></>}<TableHead>保留或排除原因</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {visible.map(row => {
            const comment = state.notes[row.key]
            const policy = state.draft.sources.find(entry => entry.id === row.sourceId)?.filter
            const manual = policy?.manual.includes(row.id)
            const qualityRow = readings?.[row.key]
            const exit = qualityRow?.exitRegion
            const marked = row.region === 'unknown' ? identifyRegion(row.originalName) : row.region
            return <TableRow key={row.key} className={cn(row.id === route.detail && 'row-highlight')}>
              <TableCell><Checkbox aria-label={'选择节点 ' + row.name} checked={selectedSet.has(row.key)} onCheckedChange={enabled => setSelected(enabled ? [...selected, row.key] : selected.filter(key => key !== row.key))} /></TableCell>
              <TableCell mobileLabel="状态"><Badge tone={row.kept ? 'success' : 'neutral'}>{row.kept ? '已保留' : '已排除'}</Badge></TableCell>
              <TableCell className="table-row-title"><strong className="node-final-name" translate="no" title={'原名 ' + row.originalName}>{row.name}</strong>
                <div className="node-meta"><RouteLink page="sources" id={row.sourceId} detail="filter">{row.sourceName}</RouteLink><span>{regionLabel(row.region)}</span><code>{row.type.toUpperCase()}</code>
                  {exit && (exit !== marked || qualityRow.exitRegionInferred) && <Badge tone={exit === marked || marked === 'unknown' ? 'neutral' : 'warning'}>
                    {marked !== 'unknown' && exit !== marked && '标称 ' + marked + ' · '}{qualityRow.exitRegionInferred ? '推定' : '实测'} {exit}</Badge>}
                  {comment?.favorite && <Star aria-label="已收藏" />}</div>{comment?.note && <small className="muted">{comment.note}</small>}</TableCell>
              {showQuality && <>
                <TableCell mobileLabel="可用率">{quality.ready ? <AvailabilityReading availability={qualityRow?.availability} fallbackRate={qualityRow?.availabilityRate} infoNode={qualityRow?.infoNode} /> : '读取中…'}</TableCell>
                <TableCell mobileLabel={qualitySortLabels[metricSort]}>{quality.ready ? <NodeQualityValue row={qualityRow} sort={metricSort} /> : '读取中…'}</TableCell>
                <TableCell mobileLabel="AI 解锁" data-col="ai">{quality.ready ? <AiUnlockCell ai={qualityRow?.aiResults} exitRegion={qualityRow?.exitRegion} skipped={qualityRow?.aiSkipped} infoNode={qualityRow?.infoNode} /> : '读取中…'}</TableCell>
              </>}
              <TableCell mobileLabel="筛选依据"><span className="muted">{row.reasons.length ? row.reasons.join(' · ') : policy?.keep.includes(row.region) ? '命中保留地区 · ' + regionLabel(row.region) : '符合当前筛选条件'}</span>
                {row.collision && <div><Badge tone="danger">名称冲突</Badge></div>}
                {!!row.duplicateCount && <small className="warning-text">精确重复 {row.duplicateCount} · {row.duplicates?.map(item => item.source).join('、')}</small>}</TableCell>
              <TableCell><div className="actions row-actions"><Button size="small" onClick={() => setManual([row.key], !manual)} disabled={busy}
                title={!row.kept && !manual ? '固定排除后，调整自动筛选条件仍会排除此节点。' : undefined}>{manual ? '撤销手动排除' : row.kept ? '排除' : '固定排除'}</Button>
                <IconButton icon={Star} className={cn(comment?.favorite && 'starred')} label={'收藏或备注 ' + row.name} onClick={() => setNote({ row, favorite: comment?.favorite ?? false, text: comment?.note ?? '' })} /></div></TableCell>
            </TableRow>
          })}
        </TableBody></Table>{nodes.length > 40 && <Pager offset={offset} count={nodes.length} pageSize={40} onChange={setOffset} />}</>}
    </Panel>
    {note && <Modal title="节点收藏与备注" detail={note.row.name} onClose={() => { if (!busy) guard.close(() => setNote(null)) }} footer={<><Button disabled={busy} onClick={() => guard.close(() => setNote(null))}>取消</Button><Button variant="primary" busy={busy} disabled={busy} onClick={() => saveNote(note)}>保存备注</Button></>}>
      <FieldGroup><Toggle label="收藏此节点" checked={note.favorite} onChange={favorite => setNote({ ...note, favorite })} />
        <Field label="备注"><Textarea maxLength={512} value={note.text} onChange={event => setNote({ ...note, text: event.target.value })} /></Field></FieldGroup>
    </Modal>}
  </div>
}
