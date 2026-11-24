import type { Draft, EvaluatedRule, Group, Library, Provider, ProviderData, Rule, Service } from '../shared/model.ts'
import type { MatchResponse, ProviderContents as Contents } from './api.ts'
import { asError } from './errors.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ArrowRight, Database, Ellipsis, GitBranch, Globe2, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { builtins, ruleTypes, servicePresets } from '../shared/catalog.ts'
import { classicalEntry, ruleValue } from '../shared/config.ts'
import { ruleSetUrl } from '../shared/rule-sets.ts'
import { RuleSetPicker } from './rule-set-picker.tsx'
import { useConfirm, useUnsavedChanges } from './confirm.tsx'
import { useProject, useSearchValue } from './project.tsx'
import { Alert, Badge, Button, Checkbox, CheckOption, Disclosure, DragHandle, Empty, Field, FieldGroup, IconButton, Input, IssueList, Modal, MoveButtons, NativeSelect, NativeSelectOption, OutletSelect, PageCheckbox, Pager, Panel, RouteLink, SearchBox, SourceStatus, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, Toggle, dragProps, formatNumber, formatTime, moveAt, newId, searchable, splitLines, useListPage } from './ui.tsx'

type CatalogEntry = Library['providers'][number]

const newRule = (serviceId: string, type = 'DOMAIN-SUFFIX', value = '') => ({ id: newId(), serviceId, type, value, enabled: true, noResolve: false })
const newService = (): Service => ({ id: newId(), name: '', enabled: true, target: '', provider: null, preset: null })
const newProvider = (): Provider => ({ url: '', behavior: 'classical', format: 'yaml', minutes: 1440 })
const noResolveTypes = new Set(['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'RULE-SET'])

function outletName(service: Service, groups: Group[]) {
  return builtins[service.target] ?? groups.find(group => group.id === service.target)?.name ?? '出站策略不可用'
}

function rulesWithService(all: Rule[], serviceId: string, entries: Rule[]) {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const old = new Set(all.map(entry => entry.id))
  const kept = all.flatMap(entry => entry.serviceId === serviceId ? (byId.has(entry.id) ? [byId.get(entry.id)!] : []) : [entry])
  const additions = entries.filter(entry => !old.has(entry.id))
  const end = kept.findIndex(entry => entry.type === 'MATCH' && entry.enabled)
  return end < 0 ? [...kept, ...additions] : [...kept.slice(0, end), ...additions, ...kept.slice(end)]
}

function ProviderFields({ value, onChange }: { value: Provider; onChange: (provider: Provider) => void }) {
  return <>
    <Field label="远程规则集地址" hint={value.urlStored ? '原地址已遮挡。可以留空沿用，或填写新地址替换。' : '填写 YAML 或纯文本规则集文件的完整地址，服务端会下载并内嵌条目。'}>
      <Input type="url" autoCapitalize="none" spellCheck={false} placeholder={value.urlStored ? '••••••••••••••••' : 'https://…'} value={value.url} onChange={event => onChange({ ...value, url: event.target.value })} />
    </Field>
    <FieldGroup className="form-grid three">
      <Field label="内容类型"><NativeSelect value={value.behavior} onChange={event => onChange({ ...value, behavior: event.target.value as Provider['behavior'] })}>
        <NativeSelectOption value="classical">经典规则</NativeSelectOption><NativeSelectOption value="domain">域名</NativeSelectOption><NativeSelectOption value="ipcidr">IP 网段</NativeSelectOption>
      </NativeSelect></Field>
      <Field label="文件格式"><NativeSelect value={value.format} onChange={event => onChange({ ...value, format: event.target.value as Provider['format'] })}>
        <NativeSelectOption value="yaml">YAML 规则集</NativeSelectOption><NativeSelectOption value="text">纯文本列表</NativeSelectOption>
      </NativeSelect></Field>
      <Field label="刷新间隔（分钟）"><Input type="number" min="1" max="43200" value={value.minutes} onChange={event => onChange({ ...value, minutes: Number(event.target.value) })} /></Field>
    </FieldGroup>
  </>
}

function ProviderContents({ serviceId, lastSuccess }: { serviceId: string; lastSuccess?: string | null }) {
  const { call } = useProject()
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Contents | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let active = true
    call(`provider-content?id=${encodeURIComponent(serviceId)}&offset=${offset}&q=${encodeURIComponent(query)}`)
      .then(value => { if (active) { setResult(value); setError('') } })
      .catch(error => { if (active) setError(error.message) })
    return () => { active = false }
  }, [serviceId, offset, query, open, lastSuccess, call])
  return <Disclosure title="查看已获取内容" open={open} onOpenChange={setOpen}>
    <div className="stack tight">
      <SearchBox placeholder="搜索规则集条目" value={query} onChange={value => { setQuery(value); setOffset(0) }} />
      {error ? <Alert tone="danger">{error}</Alert> : result ? <>
        {result.entries.length ? <ol className="compact-list" start={offset + 1}>{result.entries.map((value, index) => <li key={index}>{value}</li>)}</ol> : <p className="muted">没有匹配内容。</p>}
        <Pager offset={offset} pageSize={50} count={result.total} onChange={setOffset} />
      </> : <p className="muted">正在读取规则集…</p>}
    </div>
  </Disclosure>
}

function ServiceEditor({ initial, entries, focused, onClose, onBrowseSets }: { initial: Service; entries: Rule[]; focused?: string; onClose: () => void; onBrowseSets: () => void }) {
  const { state, call, save, notify, view, reload } = useProject()
  const revision = useRef(state.revision).current
  const [form, setForm] = useState(() => structuredClone(initial))
  const [rules, setRules] = useState(() => structuredClone(entries))
  const [pasteType, setPasteType] = useState('DOMAIN-SUFFIX')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [invalidField, setInvalidField] = useState<{ name: string; message: string } | null>(null)
  const [tested, setTested] = useState<ProviderData | null>(null)
  const [detailed, setDetailed] = useState(false)
  const exists = state.draft.services.some(service => service.id === form.id)
  const record = state.providers[form.id]
  const usesSet = Boolean(form.provider || form.ruleSet || form.inlineRules)
  const quick = !exists && !usesSet && !detailed && rules.length === 1
  const firstRule = rules[0]
  const suggestedName = (firstRule?.value.trim() || ruleTypes[firstRule?.type]?.[0] || '').slice(0, 256)
  const serviceName = form.name.trim() || (quick ? suggestedName : '')
  const preset = servicePresets.find(preset => preset.id === form.preset?.id)
  const changed = JSON.stringify(initial) !== JSON.stringify(form) || JSON.stringify(entries) !== JSON.stringify(rules) || Boolean(paste)
  const guard = useUnsavedChanges(changed, '出站策略和路由规则将恢复为修改前的设置。')
  const nameInput = useRef<HTMLInputElement>(null)
  const valueInput = useRef<HTMLInputElement>(null)
  const browseOnClose = useRef(false)
  const focus = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focused) focus.current?.scrollIntoView({ block: 'nearest' }) }, [focused])
  const update = <K extends keyof Service>(key: K, value: Service[K]) => {
    setForm(previous => ({ ...previous, [key]: value }))
    if (invalidField?.name === key) setInvalidField(null)
  }
  const updateRow = (index: number, changes: Partial<Rule>) => setRules(previous => previous.map((rule, i) => i === index ? { ...rule, ...changes } : rule))
  function close() {
    if (!busy) return guard.close(onClose)
  }
  function addPasted() {
    const values = splitLines(paste, /[\s,，;；]+/)
    if (!values.length) return []
    const invalid = values.filter(value => ruleValue(pasteType, value) === null)
    if (invalid.length) throw new Error('请检查批量输入，第一个无效值为「' + invalid[0].slice(0, 90) + '」。')
    const known = new Set(rules.map(rule => rule.type + ' ' + ruleValue(rule.type, rule.value)))
    const additions = values.filter(value => !known.has(pasteType + ' ' + ruleValue(pasteType, value)))
      .map(value => newRule(form.id, pasteType, value))
    return additions
  }
  function pasteNow() {
    try {
      const next = addPasted()
      setRules([...rules.filter(rule => rule.value || rule.type === 'MATCH'), ...next])
      setPaste('')
      setError('')
    } catch (cause) { const error = asError(cause); setError(error.message) }
  }
  function buildDraft() {
    const pending = paste ? addPasted() : []
    const entries = [...(pending.length ? rules.filter(rule => rule.value || rule.type === 'MATCH') : rules), ...pending]
    const value = {
      ...form, name: serviceName,
      provider: form.provider ? { ...form.provider, url: form.provider.url.trim() } : null,
    }
    return {
      ...state.draft, services: exists ? state.draft.services.map(service => service.id === form.id ? value : service) : [...state.draft.services, value],
      rules: rulesWithService(state.draft.rules, form.id, entries),
    }
  }
  async function testProvider() {
    if (busy || !form.provider) return
    setBusy('test')
    setError('')
    try { setTested(await call('probe', { kind: 'provider', id: form.id, ...form.provider, url: form.provider.url.trim() })) }
    catch (cause) { const error = asError(cause); setError(error.message) }
    finally { setBusy('') }
  }
  async function commit() {
    if (busy) return
    setError('')
    if (quick && ruleValue(firstRule.type, firstRule.value) === null) {
      setInvalidField({ name: 'value', message: '请填写有效的' + ruleTypes[firstRule.type][0] + '，例如 ' + ruleTypes[firstRule.type][2] + '。' })
      valueInput.current?.focus()
      return
    }
    if (!serviceName) {
      setInvalidField({ name: 'name', message: '请填写服务名称。' })
      nameInput.current?.focus()
      return
    }
    if (!form.target) {
      setInvalidField({ name: 'target', message: '请选择出站策略。' })
      document.querySelector<HTMLElement>('[name="service_outlet"]')?.focus()
      return
    }
    setBusy('save')
    try {
      const draft = buildDraft()
      if (form.inlineRules) {
        if (!form.inlineRules.length) throw new Error('请至少填写一条规则集条目。')
        const index = form.inlineRules.findIndex(line => !classicalEntry(line))
        if (index >= 0) throw new Error('请检查规则集第 ' + (index + 1) + ' 行的匹配方式和值。')
      }
      const invalid = draft.rules.find(rule => rule.serviceId === form.id && rule.enabled && ruleValue(rule.type, rule.value) === null)
      if (invalid) throw new Error('存在无效匹配值，请按示例补全。无需使用的空行可以删除。')
      await save(draft, revision, quick ? '已添加手动规则' : undefined)
      guard.leave(onClose)
    } catch (cause) { const error = asError(cause); setError(error.message) } finally { setBusy('') }
  }

  function returnFocus(event: Event) {
    if (browseOnClose.current) {
      event.preventDefault()
      onBrowseSets()
    }
  }
  const browseSets = !exists && <Button variant="ghost" size="small" disabled={Boolean(busy)} onClick={() => {
    if (busy) return
    return guard.close(() => {
      browseOnClose.current = true
      onClose()
    })
  }}>搜索规则集目录</Button>
  if (quick) {
    const [, hint, example] = ruleTypes[firstRule.type]
    const formId = 'manual-rule-' + form.id
    return <Modal wide title="手动添加规则" onClose={close} onCloseAutoFocus={returnFocus} className="quick-rule-dialog"
      footer={<>{browseSets}<Button variant="ghost" disabled={Boolean(busy)} onClick={close}>取消</Button><Button form={formId} type="submit" variant="primary" icon={Plus} busy={busy === 'save'} disabled={Boolean(busy && busy !== 'save')}>添加规则</Button></>}>
      <form id={formId} className="quick-rule-form" inert={Boolean(busy)} onSubmit={event => { event.preventDefault(); void commit() }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <fieldset disabled={Boolean(busy)} className="quick-rule-fields">
          <legend className="sr-only">设置匹配条件和出站策略</legend>
          <Field label="匹配方式"><NativeSelect value={firstRule.type} onChange={event => {
            updateRow(0, { type: event.target.value, value: '', noResolve: false }); setInvalidField(null)
          }}>{Object.entries(ruleTypes).filter(([type]) => type !== 'RULE-SET').map(([type, [name]]) =>
            <NativeSelectOption key={type} value={type}>{name}</NativeSelectOption>)}</NativeSelect></Field>
          {firstRule.type === 'MATCH' ? <p className="field-note muted quick-match-note">{hint}</p> :
            <Field label="匹配值" error={invalidField?.name === 'value' ? invalidField.message : undefined}>
              <Input ref={valueInput} value={firstRule.value} maxLength={2048} spellCheck={false} placeholder={example} onChange={event => {
                updateRow(0, { value: event.target.value }); setInvalidField(null)
              }} /></Field>}
          <Field label="出站策略" name="service_outlet" error={invalidField?.name === 'target' ? invalidField.message : undefined}>
            <OutletSelect value={form.target} onChange={value => update('target', value)} groups={state.draft.groups} /></Field>
        </fieldset>
        {firstRule.type !== 'MATCH' && <p className="field-note muted">{hint}</p>}
        {noResolveTypes.has(firstRule.type) && <CheckOption label="匹配时不主动解析域名（no-resolve）" disabled={Boolean(busy)} checked={firstRule.noResolve} onCheckedChange={checked => updateRow(0, { noResolve: checked })} />}
        <div><Button variant="ghost" size="small" disabled={Boolean(busy)} onClick={() => {
          if (firstRule.value.trim()) update('name', suggestedName)
          setInvalidField(null); setDetailed(true)
        }}>批量添加与高级设置</Button></div>
      </form>
    </Modal>
  }
  return <Modal wide title={exists ? '编辑服务 · ' + initial.name : form.inlineRules ? '粘贴规则集' : form.provider ? '从链接添加规则集' : '批量添加与高级设置'}
    onClose={close} onCloseAutoFocus={returnFocus}
    footer={<>{browseSets}<Button variant="ghost" disabled={Boolean(busy)} onClick={close}>取消</Button><Button variant="primary" icon={Check} busy={busy === 'save'} disabled={Boolean(busy && busy !== 'save')} onClick={commit}>保存服务</Button></>}>
    <div className="stack" inert={Boolean(busy)}>
      {error && <Alert tone="danger">{error}</Alert>}
      <FieldGroup className="form-grid">
        <Field label="服务名称" name="service_name" error={invalidField?.name === 'name' ? invalidField.message : undefined}>
          <Input ref={nameInput} value={form.name} maxLength={256} onChange={event => update('name', event.target.value)} placeholder="例如 GitHub…" />
        </Field>
        <Field label="出站策略" name="service_outlet" error={invalidField?.name === 'target' ? invalidField.message : undefined}><OutletSelect groups={state.draft.groups} value={form.target} onChange={value => update('target', value)} /></Field>
      </FieldGroup>
      <Toggle label="启用服务" detail="停用后，服务的所有规则从新成品中移除。" checked={form.enabled} onChange={value => update('enabled', value)} />
      {preset && <div className="between flex-wrap field-note">
        <p className="muted">预设覆盖常见域名，可补充实际使用的其他域名。</p>
        {form.preset && preset.version > form.preset.version && <Button size="small" onClick={() => {
          const existing = new Set(rules.filter(rule => rule.type === 'DOMAIN-SUFFIX').map(rule => rule.value))
          setRules([...rules, ...preset.domains.filter(domain => !existing.has(domain)).map(domain => newRule(form.id, 'DOMAIN-SUFFIX', domain))])
          update('preset', { id: preset.id, version: preset.version })
        }}>添加新版域名</Button>}
      </div>}
      {form.inlineRules ? <Disclosure title={'内嵌规则集 · ' + formatNumber(form.inlineRules.length) + ' 条'} defaultOpen={!exists}>
        <Field label="规则集条目" hint="每行填写匹配方式和值，例如 DOMAIN-SUFFIX,example.com。这些条目共用上方的出站策略。">
          <Textarea rows={10} spellCheck={false} defaultValue={form.inlineRules.join('\n')}
            onChange={event => update('inlineRules', event.target.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))} />
        </Field>
      </Disclosure> : form.ruleSet ? <div className="catalog-source"><div className="chips"><span className="tech-chip">RULE-SET</span><strong>{form.ruleSet}</strong></div>
        <p className="field-note muted">Mihomo 从 MetaCubeX 获取 MRS 规则集，每 24 小时更新。</p>
        <a className="text-link" href={ruleSetUrl(form.ruleSet, 'list')} target="_blank" rel="noreferrer">查看上游条目</a>
      </div> : form.provider ? <>
        <ProviderFields value={form.provider} onChange={value => { update('provider', value); setTested(null) }} />
        <div className="actions">
          <Button icon={RefreshCw} onClick={testProvider} busy={busy === 'test'} disabled={Boolean(busy && busy !== 'test') || (!form.provider.url && !form.provider.urlStored && !form.provider.catalogId)}>测试规则集</Button>
          {exists && <Button busy={busy === 'refresh'} disabled={Boolean(busy)} onClick={async () => {
            if (busy) return
            setBusy('refresh')
            setError('')
            try { await call('refresh', { kind: 'provider', id: form.id }); await reload(); notify('规则集刷新已提交') } catch (cause) { const error = asError(cause); setError(error.message) } finally { setBusy('') }
          }}>刷新已保存版本</Button>}
          {(tested || record?.good) && <Badge tone="success">{(tested ?? record.good)?.count} 条有效内容</Badge>}
        </div>
        {record?.error && <Alert tone="warning">{record.error}{record.good ? ' 继续使用上一次取得的规则集。' : ''}</Alert>}
        {record?.lastSuccess && <span className="muted">上次成功 {formatTime(record.lastSuccess)} · 下次计划 {formatTime(record.next)}</span>}
        {record?.good && <ProviderContents serviceId={form.id} lastSuccess={record.lastSuccess} />}
      </> : <Disclosure title="批量粘贴域名" defaultOpen={rules.length === 0}>
        <FieldGroup>
          {!exists && <Field label="常用域名预设"><NativeSelect value="" onChange={event => {
            const selected = servicePresets.find(item => item.id === event.target.value)
            if (!selected) return
            const kept = rules.filter(rule => rule.value || rule.type === 'MATCH')
            const known = new Set(kept.filter(rule => rule.type === 'DOMAIN-SUFFIX').map(rule => rule.value))
            setRules([...kept, ...selected.domains.filter(domain => !known.has(domain)).map(domain => newRule(form.id, 'DOMAIN-SUFFIX', domain))])
            setForm(previous => ({ ...previous, name: previous.name || selected.name, preset: { id: selected.id, version: selected.version } }))
          }}><NativeSelectOption value="">选择预设以补充域名</NativeSelectOption>
            {servicePresets.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Field>}
          <Field label="批量匹配方式"><NativeSelect value={pasteType} onChange={event => setPasteType(event.target.value)}>
            {['DOMAIN-SUFFIX', 'DOMAIN', 'DOMAIN-KEYWORD'].map(type => <NativeSelectOption key={type} value={type}>{ruleTypes[type][0]}</NativeSelectOption>)}
          </NativeSelect></Field>
          <Field label="域名列表" hint="可用换行、空格或逗号分隔。"><Textarea spellCheck={false} placeholder={'github.com\napi.github.com…'} value={paste} onChange={event => setPaste(event.target.value)} /></Field>
          <div><Button icon={Plus} disabled={!paste.trim()} onClick={pasteNow}>添加到规则</Button></div>
        </FieldGroup>
      </Disclosure>}
      <section className="stack tight">
        <div className="between"><h3>匹配规则</h3>{(!usesSet || !rules.some(rule => rule.type === 'RULE-SET')) && <Button size="small" icon={Plus} onClick={() => setRules([...rules, newRule(form.id, usesSet ? 'RULE-SET' : 'DOMAIN-SUFFIX')])}>{usesSet ? '添加规则集匹配' : '添加单条规则'}</Button>}</div>
        {rules.length ? rules.map((rule, index) => {
          const info = ruleTypes[rule.type] ?? ['未识别', '请更换匹配方式。', '']
          const actual = view.rules.find(entry => entry.id === rule.id)
          return <div key={rule.id} className={cn('rule-edit-row', rule.id === focused && 'row-highlight')} ref={rule.id === focused ? focus : null}>
            <div className="between">
              <Badge tone={actual ? 'accent' : 'neutral'}>{actual ? '全局优先级 ' + actual.position : '规则 ' + (index + 1)}</Badge>
              <div className="actions row-actions"><CheckOption label="启用" checked={rule.enabled} onCheckedChange={checked => updateRow(index, { enabled: checked })} />
                {(!(form.ruleSet || form.inlineRules) || rules.length > 1) && <IconButton icon={Trash2} label={'删除匹配规则 ' + (index + 1)} onClick={() => setRules(rules.filter(item => item.id !== rule.id))} />}</div>
            </div>
            {rule.type === 'RULE-SET' && usesSet ? <strong>{form.ruleSet ?? (form.inlineRules ? '内嵌规则集' : '外部规则集')}</strong> : <FieldGroup className="form-grid">
              <Field label="匹配方式" hint={info[1]}><NativeSelect value={rule.type} onChange={event => updateRow(index, { type: event.target.value, value: '', noResolve: false })}>
                {Object.entries(ruleTypes).filter(([type]) => type !== 'RULE-SET').map(([type, [label]]) => <NativeSelectOption key={type} value={type}>{label}</NativeSelectOption>)}
              </NativeSelect></Field>
              {rule.type !== 'MATCH' && <Field label="匹配值"><Input spellCheck={false} value={rule.value} maxLength={2048} placeholder={info[2] ? info[2] + '…' : undefined} onChange={event => updateRow(index, { value: event.target.value })} /></Field>}
            </FieldGroup>}
            {noResolveTypes.has(rule.type) && !form.ruleSet?.startsWith('geosite/') && <CheckOption label="匹配时不主动解析域名（no-resolve）" checked={rule.noResolve} onCheckedChange={checked => updateRow(index, { noResolve: checked })} />}
          </div>
        }) : <p className="muted">{usesSet ? '添加规则集匹配后即可参与分流。' : '可批量粘贴域名或添加单条规则。'}</p>}
      </section>
      <Disclosure title="预览分流结果">
        <MatchForm buildDraft={buildDraft} serviceId={form.id} disabled={!form.name.trim() || !form.target}
          changedKey={JSON.stringify([form, rules, paste, pasteType])} />
      </Disclosure>
    </div>
  </Modal>
}

function MatchForm({ buildDraft, serviceId, disabled, changedKey, onOpen, examples = [] }: { buildDraft?: () => Draft; serviceId?: string; disabled?: boolean; changedKey?: string | number; onOpen?: (rule: EvaluatedRule) => void; examples?: string[] }) {
  const { call, view, state } = useProject()
  const [domain, setDomain] = useState(examples[0] ?? '')
  const [result, setResult] = useState<MatchResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)
  function clearResult() {
    latest.current++
    setBusy(false)
    setResult(null)
  }
  const submitted = useRef<string | undefined>(undefined)
  useEffect(() => {
    clearResult()
    const value = submitted.current ?? examples[0]
    if (!buildDraft && value) void testDomain(value)
    return () => { latest.current++ }
  }, [changedKey, examples[0]])
  const match = result?.match
  const targetId = match && state.draft.services.find(service => service.id === match.serviceId)?.target
  const outletGroup = !buildDraft && targetId ? view.groups.find(group => group.id === targetId) : null
  async function testDomain(value: string) {
    const request = ++latest.current
    submitted.current = value
    setDomain(value)
    setBusy(true)
    setResult(null)
    try {
      const answer = await call('match', { domain: value, draft: buildDraft?.(), serviceId })
      if (latest.current === request) setResult(answer)
    } catch (cause) {
      const error = asError(cause)
      if (latest.current === request) setResult({ error: error.message, issues: [] })
    } finally {
      if (latest.current === request) setBusy(false)
    }
  }
  return <form className="match-form stack tight" onSubmit={event => { event.preventDefault(); void testDomain(domain) }}>
      <div className="match-query"><Field label="测试域名" name="domain"><Input spellCheck={false} placeholder="例如 api.github.com" value={domain} onChange={event => { submitted.current = ''; setDomain(event.target.value); clearResult() }} /></Field>
        <Button type="submit" size="small" variant="primary" icon={Search} busy={busy} disabled={disabled || (!buildDraft && !domain.trim())}>{buildDraft ? '检查并测试' : '测试域名'}</Button></div>
      {examples.length > 0 && <div className="domain-examples">{examples.map(value => <button key={value} type="button" aria-label={'测试 ' + value} onClick={() => testDomain(value)}>{value}</button>)}</div>}
      {buildDraft && <span className="muted">可以留空检查规则。填写域名还可查看预计命中的出站策略。</span>}
      {buildDraft && !!result?.issues.length && result.issues.map((issue, index) => <Alert key={index} tone={issue.severity === 'error' ? 'danger' : 'warning'}>{issue.message}</Alert>)}
      {result?.error ? <Alert tone="danger">{result.error}</Alert> : result?.checkedOnly ? (!result.issues.length && <Alert tone="success">未发现此服务有明显的规则冲突。</Alert>) : result && <>
        {result.message && <Alert tone="warning">{result.message}</Alert>}
        {!!result.uncertain?.length && <Alert tone="warning" title="较早的规则可能优先命中">
          以下条件依赖网络解析、客户端数据或进程信息。结果仅为预计。
          <ul className="compact-list">{result.uncertain.slice(0, 10).map(rule => <li key={rule.id}>第 {rule.position} 条 · {rule.service} · {rule.outlet}</li>)}</ul>
        </Alert>}
        {match ? <div className="match-result" role="status">
          <div className="match-path"><code>{result.domain}</code><ArrowRight aria-hidden="true" /><span className="tech-chip">#{match.position} {match.type}</span><ArrowRight aria-hidden="true" /><Badge tone="accent">{match.outlet}</Badge></div>
          <div><strong>{result.uncertain?.length ? '若上述条件未命中，将匹配' : '预计命中'}：{match.service}</strong><p>第 {formatNumber(match.position)} 条，出站策略为 {match.outlet}</p></div>
          {!!outletGroup?.members.length && <div className="match-members"><span>组内代理（{formatNumber(outletGroup.members.length)}）</span>
            <div className="chips">{outletGroup.members.slice(0, 6).map(member => <code key={member.key} className="tech-chip">{member.name}</code>)}
              {outletGroup.members.length > 6 && <RouteLink className="text-link" page="groups" id={outletGroup.id}>查看其余 {formatNumber(outletGroup.members.length - 6)} 项代理</RouteLink>}
            </div></div>}
          {onOpen && <Button size="small" onClick={() => onOpen(match)}>打开规则</Button>}
        </div> : !result.message && <Alert>没有可确定命中的规则。实际出站策略取决于运行模式和网络条件。</Alert>}
      </>}
    </form>
}

function CatalogDialog({ entry, onClose }: { entry?: CatalogEntry; onClose: () => void }) {
  const { state, call, applyState, notify } = useProject()
  const [form, setForm] = useState(entry ?? { id: newId(), name: '', ...newProvider() })
  const initial = useRef(form).current
  const guard = useUnsavedChanges(JSON.stringify(form) !== JSON.stringify(initial), '规则集目录将沿用原来的设置。')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => { if (!busy) return guard.close(onClose) }
  return <Modal title={entry ? '编辑目录条目' : '添加目录条目'} onClose={close} footer={<><Button disabled={busy} onClick={close}>取消</Button><Button variant="primary" busy={busy} onClick={async () => {
    if (busy) return
    setBusy(true)
    try {
      const providers = entry ? state.library.providers.map(item => item.id === entry.id ? form : item) : [...state.library.providers, form]
      if (!applyState(await call('library', { ...state.library, providers }))) return
      notify('规则集目录已保存')
      guard.leave(onClose)
    } catch (cause) { const error = asError(cause); setError(error.message) } finally { setBusy(false) }
  }}>保存目录条目</Button></>}>
    <FieldGroup inert={busy}>{error && <Alert tone="danger">{error}</Alert>}
      <Field label="目录名称"><Input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
      <ProviderFields value={form} onChange={provider => setForm({ ...form, ...provider })} />
    </FieldGroup>
  </Modal>
}

export function RulesPage() {
  const { state, view, route, save, call, applyState, notify, navigate } = useProject()
  const confirm = useConfirm()
  const section = route.params.get('view')
  const ruleSection = useRef<HTMLElement>(null)
  const catalogSection = useRef<HTMLElement>(null)
  const pickerSection = useRef<HTMLElement>(null)
  const [query, setQuery] = useSearchValue('q')
  const [outlet, setOutlet] = useSearchValue('outlet')
  const [status, setStatus] = useSearchValue('status', 'all')
  const [selected, setSelected] = useState<string[]>([])
  const [batchTarget, setBatchTarget] = useState('')
  const [selectedRules, setSelectedRules] = useState<string[]>([])
  const [ruleService, setRuleService] = useState('')
  const [editing, setEditing] = useState<{ service: Service; entries: Rule[] } | null>(null)
  const [catalog, setCatalog] = useState<{ entry?: CatalogEntry } | null>(null)
  const [undo, setUndo] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const { draft } = state
  const priority = new Map(view.rules.map(rule => [rule.id, rule]))
  const rulesByService = useMemo(() => {
    const map = new Map<string, Rule[]>(draft.services.map(service => [service.id, []]))
    for (const rule of draft.rules) map.get(rule.serviceId)?.push(rule)
    return map
  }, [draft.rules, draft.services])
  const serviceRank = new Map()
  for (const rule of draft.rules) if (!serviceRank.has(rule.serviceId)) serviceRank.set(rule.serviceId, serviceRank.size)
  const services = [...draft.services].sort((left, right) => (serviceRank.get(left.id) ?? Infinity) - (serviceRank.get(right.id) ?? Infinity))
  const byService = new Map(services.map(service => [service.id, service]))
  const visibleServices = services.filter(service => (!outlet || outlet === service.target) && (status === 'all' || service.enabled === (status === 'enabled'))
    && (searchable(service.name, query) || searchable(service.ruleSet ?? '', query) || searchable(outletName(service, draft.groups), query) || rulesByService.get(service.id)?.some(rule => searchable(rule.value, query))))
  const visibleIds = new Set(visibleServices.map(service => service.id))
  const visibleRules = draft.rules.filter(rule => {
    const service = byService.get(rule.serviceId)
    const active = Boolean(rule.enabled && service?.enabled)
    return (!outlet || service?.target === outlet) && (status === 'all' || active === (status === 'enabled'))
      && (visibleIds.has(rule.serviceId) || service && (searchable(rule.value, query) || searchable(service.name, query) || searchable(outletName(service, draft.groups), query)) || !service && !query)
  })
  const [servicesOffset, setServicesOffset] = useListPage(visibleServices.length, 18, 'servicesPage')
  const [rulesOffset, setRulesOffset] = useListPage(visibleRules.length, 40, 'rulesPage')
  const pageRules = visibleRules.slice(rulesOffset, rulesOffset + 40)
  const ruleBatch = new Set(selectedRules)
  const issues = view.issues.filter(issue => issue.pane === 'rules')
  const hasErrors = issues.some(issue => issue.severity === 'error')
  const batch = new Set(selected)
  const focus = byService.get(route.id ?? '')
  const addedSets = new Map(services.filter(service => service.ruleSet && rulesByService.get(service.id)?.some(rule => rule.type === 'RULE-SET')).map(service => [service.ruleSet, service]))
  function focusPicker() {
    pickerSection.current?.scrollIntoView({ block: 'start' })
    pickerSection.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (focus) return
    if (route.id === 'new') focusPicker()
    else if (section === 'catalog') catalogSection.current?.scrollIntoView()
    else if (section === 'rules' || route.id && route.id !== 'new') ruleSection.current?.scrollIntoView()
  }, [section, route.id, Boolean(focus)])

  function addService(provider: Provider | null = null) {
    const service = { ...newService(), provider }
    setEditing({ service, entries: [newRule(service.id, provider ? 'RULE-SET' : 'DOMAIN-SUFFIX')] })
  }

  async function run(action: () => unknown) {
    if (busy) return
    setBusy(true)
    try { await action() } catch (cause) { const error = asError(cause); notify(error.message, 'danger') } finally { setBusy(false) }
  }
  function addRuleSet(key: string, name: string, target: string) {
    if (addedSets.has(key)) return
    return run(async () => {
      const existing = services.find(service => service.ruleSet === key)
      const service = existing ? { ...existing, target, enabled: true } : { ...newService(), ruleSet: key, name, target }
      const rows = [...(rulesByService.get(service.id) ?? []), newRule(service.id, 'RULE-SET')]
      await save({ ...draft,
        services: existing ? draft.services.map(item => item.id === service.id ? service : item) : [...draft.services, service],
        rules: rulesWithService(draft.rules, service.id, rows),
      }, state.revision, '已添加规则集 ' + key)
    })
  }
  function reorder(next: Rule[]) {
    return run(async () => {
      const previous = draft.rules.map(rule => rule.id)
      await save({ ...draft, rules: next })
      setUndo(previous)
    })
  }
  function moveService(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || to >= services.length) return
    const item = services[from]
    const neighbor = services[to]
    const moving = rulesByService.get(item.id)
    if (!moving?.length || !rulesByService.get(neighbor.id)?.length) {
      notify('请先为服务添加匹配规则，再调整优先级', 'info')
      return
    }
    const remaining = draft.rules.filter(rule => rule.serviceId !== item.id)
    const at = from < to ? remaining.findLastIndex(rule => rule.serviceId === neighbor.id) + 1 : remaining.findIndex(rule => rule.serviceId === neighbor.id)
    return reorder([...remaining.slice(0, at), ...moving, ...remaining.slice(at)])
  }
  const moveRule = (from: number, to: number) => reorder(moveAt(draft.rules, from, to))
  const updateService = (ids: string[], changes: Partial<Service>) => run(() => save({ ...draft, services: draft.services.map(service => ids.includes(service.id) ? { ...service, ...changes } : service) }))
  async function deleteServices(ids: string[]) {
    if (!await confirm({ title: '删除所选服务？', detail: '服务及其规则将一并移除。发布配置后，订阅会采用这项更改。', action: '删除服务', danger: true })) return
    await run(async () => {
      await save({ ...draft, services: draft.services.filter(service => !ids.includes(service.id)), rules: draft.rules.filter(rule => !ids.includes(rule.serviceId)) })
      setSelected(selected.filter(id => !ids.includes(id)))
    })
  }
  function saveRuleChanges(rules: Rule[]) {
    const before = new Set(draft.rules.map(rule => rule.serviceId))
    const after = new Set(rules.map(rule => rule.serviceId))
    const services = draft.services.filter(service => !(service.ruleSet || service.inlineRules) || !before.has(service.id) || after.has(service.id))
    return save({ ...draft, rules, services })
  }
  function updateRules(change: (rule: Rule) => Rule[]) {
    return run(async () => {
      await saveRuleChanges(draft.rules.flatMap(rule => ruleBatch.has(rule.id) ? change(rule) : [rule]))
      setSelectedRules([])
    })
  }
  let editor = editing
  if (!editor && focus) editor = { service: focus, entries: rulesByService.get(focus.id) ?? [] }
  function clearFilters() {
    setQuery('')
    setOutlet('')
    setStatus('all')
    setServicesOffset(0)
    setRulesOffset(0)
  }

  const examples = [...new Set(services.map(service => rulesByService.get(service.id)?.find(rule => rule.enabled && ['DOMAIN', 'DOMAIN-SUFFIX'].includes(rule.type))?.value).filter((value): value is string => !!value))].slice(0, 6)
  return <div className="stack config-page">
    <h1 className="sr-only" tabIndex={-1}>路由规则</h1>
    <section ref={pickerSection} className="rule-section"><RuleSetPicker groups={draft.groups} added={addedSets} busy={busy}
      onAdd={addRuleSet} onEdit={id => navigate('rules', id)} onManual={() => addService()} onCustom={() => addService(newProvider())}
      onPaste={() => {
        const service = { ...newService(), inlineRules: [] }
        setEditing({ service, entries: [newRule(service.id, 'RULE-SET')] })
      }} /></section>
    <div className="routing-workspace">
      <Panel title="服务出站策略" count={formatNumber(services.length)}>
        {(query || outlet || status !== 'all') && <div className="config-toolbar"><span>筛选后 {formatNumber(visibleServices.length)} 个服务</span><Button size="small" onClick={clearFilters}>清除筛选</Button></div>}
        {!!selected.length && <div className="batch-bar"><strong>已选 {selected.length} 个服务</strong>
          <Button size="small" busy={busy} onClick={() => updateService(selected, { enabled: true })}>批量启用</Button><Button size="small" disabled={busy} onClick={() => updateService(selected, { enabled: false })}>批量停用</Button>
          <OutletSelect label="批量出站策略" value={batchTarget} onChange={setBatchTarget} groups={draft.groups} /><Button size="small" disabled={!batchTarget || busy} onClick={() => updateService(selected, { target: batchTarget })}>修改策略</Button>
          <Button variant="danger" size="small" disabled={busy} onClick={() => deleteServices(selected)}>删除</Button><Button variant="ghost" size="small" onClick={() => setSelected([])}>清除选择</Button>
        </div>}
        {!visibleServices.length ? <Empty icon={Globe2} title={services.length ? '没有匹配的服务' : '还没有分流服务'}
          detail={!services.length && '在上方选择规则集和出站策略，即可创建分流。'} /> : <ul className="outlet-list">{visibleServices.slice(servicesOffset, servicesOffset + 18).map(service => {
          const rules = rulesByService.get(service.id) ?? []
          const record = state.providers[service.id]
          const index = services.indexOf(service)
          const preset = servicePresets.find(item => item.id === service.preset?.id)
          return <li key={service.id} className="outlet-row" data-sort-row {...dragProps(index, moveService, 'service')}>
            <div className="row-actions"><DragHandle index={index} area="service" /><Checkbox aria-label={'选择服务 ' + service.name} checked={batch.has(service.id)} onCheckedChange={enabled => setSelected(enabled ? [...selected, service.id] : selected.filter(id => id !== service.id))} /></div>
            <div className="outlet-identity"><div className="chips"><RouteLink page="rules" id={service.id}>{service.name}</RouteLink>
              <span className="soft-count">{rules.length} 条</span>
              {service.provider ? <SourceStatus entry={service} record={record} /> : !service.enabled && <Badge>已停用</Badge>}
              {preset && service.preset && preset.version > service.preset.version && <Badge tone="warning">预设有新版</Badge>}</div>
              <p className="outlet-domains" title={service.ruleSet ?? rules.map(rule => rule.value).filter(Boolean).join('、')}>{service.inlineRules ? '内嵌规则集 · ' + formatNumber(service.inlineRules.length) + ' 条' : service.ruleSet ? 'RULE-SET · ' + service.ruleSet : service.provider
                ? record?.error || (record?.good ? formatNumber(record.good.count) + ' 条已获取内容' : '等待获取规则集')
                : rules.slice(0, 4).map(rule => rule.value || ruleTypes[rule.type]?.[0]).join('、') || '暂无匹配条件'}</p>
            </div>
            <OutletSelect label={service.name + ' 的出站策略'} value={service.target} onChange={target => updateService([service.id], { target })} disabled={busy} groups={draft.groups} />
            <Popover><PopoverTrigger asChild><IconButton icon={Ellipsis} label={service.name + ' 的更多操作'} /></PopoverTrigger>
              <PopoverContent className="outlet-menu"><Button icon={Pencil} size="small" onClick={() => navigate('rules', service.id)}>编辑服务</Button>
                <MoveButtons index={index} count={services.length} onMove={moveService} area="service" drag={false} />
                <Button size="small" disabled={busy} onClick={() => updateService([service.id], { enabled: !service.enabled })}>{service.enabled ? '停用' : '启用'}</Button>
                <Button icon={Trash2} size="small" variant="ghost" disabled={busy} onClick={() => deleteServices([service.id])}>删除服务</Button></PopoverContent>
            </Popover>
          </li>
        })}</ul>}
        {visibleServices.length > 18 && <Pager offset={servicesOffset} pageSize={18} count={visibleServices.length} onChange={setServicesOffset} />}
      </Panel>
      <Panel title="路由匹配查询"><div className="panel-padding">
        <MatchForm examples={examples} changedKey={state.revision} onOpen={rule => navigate('rules', rule.serviceId, rule.id)} />
      </div></Panel>
    </div>
    <section ref={ruleSection} className="rule-section">
    <Panel title="路由规则表" count={formatNumber(draft.rules.length)} actions={<>
      {undo && <Button icon={RotateCcw} size="small" disabled={busy} onClick={() => run(async () => {
        const order = new Map(undo.map((id, index) => [id, index]))
        await save({ ...draft, rules: [...draft.rules].sort((left, right) => (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity)) })
        setUndo(null)
      })}>撤销排序</Button>}
      <Button size="small" variant="primary" icon={Plus} onClick={focusPicker}>添加规则集</Button></>}>
      {draft.rules.length > 0 && <div className="config-toolbar rule-filters"><div className="filters">
        <NativeSelect aria-label="筛选出站策略" value={outlet} onChange={event => { setOutlet(event.target.value); setServicesOffset(0); setRulesOffset(0) }}><NativeSelectOption value="">全部出站策略</NativeSelectOption>
          {[...Object.entries(builtins), ...draft.groups.map(group => [group.id, group.name])].map(([key, label]) => <NativeSelectOption value={key} key={key}>{label}</NativeSelectOption>)}
        </NativeSelect>
        <SearchBox placeholder="搜索网站、域名或出站策略" value={query} onChange={value => { setQuery(value); setServicesOffset(0); setRulesOffset(0) }} />
        <NativeSelect aria-label="筛选启用状态" value={status} onChange={event => { setStatus(event.target.value); setServicesOffset(0); setRulesOffset(0) }}><NativeSelectOption value="all">全部状态</NativeSelectOption><NativeSelectOption value="enabled">已启用</NativeSelectOption><NativeSelectOption value="disabled">已停用</NativeSelectOption></NativeSelect></div>
        <span className="soft-count">{formatNumber(view.counts.rules)} 条生成规则</span>
      </div>}
      {issues.length > 0 && <Disclosure defaultOpen={hasErrors} title={<span className={hasErrors ? 'error-text' : 'warning-text'}>
        {formatNumber(issues.length)} 项规则{hasErrors ? '问题' : '提醒'}</span>}><IssueList items={issues} className="issue-list-inset" /></Disclosure>}
      {!!selectedRules.length && <div className="batch-bar">
        <strong>已选 {selectedRules.length} 条规则</strong>
        <Button size="small" disabled={busy} onClick={() => updateRules(rule => [{ ...rule, enabled: true }])}>批量启用规则</Button>
        <Button size="small" disabled={busy} onClick={() => updateRules(rule => [{ ...rule, enabled: false }])}>批量停用规则</Button>
        <NativeSelect aria-label="归入服务" value={ruleService} onChange={event => setRuleService(event.target.value)}>
          <NativeSelectOption value="">选择目标服务</NativeSelectOption>
          {services.filter(service => !service.provider && !service.ruleSet && !service.inlineRules).map(service => <NativeSelectOption key={service.id} value={service.id}>{service.name}</NativeSelectOption>)}
        </NativeSelect>
        <Button size="small" disabled={!ruleService || busy || draft.rules.some(rule => ruleBatch.has(rule.id) && rule.type === 'RULE-SET')}
          onClick={() => updateRules(rule => [{ ...rule, serviceId: ruleService }])}>归入服务</Button>
        <Button size="small" variant="danger" disabled={busy} onClick={async () => {
          if (busy) return
          if (await confirm({ title: '删除规则？', detail: '选中的匹配规则将从规则表中移除。', action: '删除选中规则', danger: true })) {
            if (!busy) updateRules(() => [])
          }
        }}>删除选中规则</Button>
        <Button size="small" variant="ghost" onClick={() => setSelectedRules([])}>清除选择</Button>
      </div>}
      {!visibleRules.length ? <Empty icon={GitBranch} title={draft.rules.length ? '没有匹配规则' : '还没有路由规则'}
        actions={draft.rules.length > 0 && <Button onClick={clearFilters}>清除筛选</Button>} /> : <>
        <Table className="rule-table mobile-table" scrollLabel="规则优先级"><TableHeader><TableRow><TableHead><PageCheckbox label="选择当前页规则" checked={pageRules.every(rule => ruleBatch.has(rule.id))}
          onCheckedChange={enabled => setSelectedRules(enabled ? [...new Set([...selectedRules, ...pageRules.map(rule => rule.id)])] : selectedRules.filter(id => !pageRules.some(rule => rule.id === id)))} /></TableHead>
          <TableHead>优先级</TableHead><TableHead>服务</TableHead><TableHead>条件</TableHead><TableHead>出站策略</TableHead><TableHead>状态</TableHead><TableHead>顺序与操作</TableHead></TableRow></TableHeader><TableBody>
          {pageRules.map(rule => {
            const service = byService.get(rule.serviceId)
            const index = draft.rules.findIndex(item => item.id === rule.id)
            const generated = priority.get(rule.id)
            return <TableRow key={rule.id} data-sort-row {...dragProps(index, moveRule, 'rule')} className={cn((route.id === rule.id || route.detail === rule.id) && 'row-highlight')}>
              <TableCell><Checkbox aria-label={'选择规则 ' + (rule.value || rule.type)}
                checked={ruleBatch.has(rule.id)} onCheckedChange={enabled => setSelectedRules(enabled ? [...selectedRules, rule.id] : selectedRules.filter(id => id !== rule.id))} /></TableCell>
              <TableCell className="numeric table-row-title" mobileLabel="优先级">{generated?.position ?? '—'}</TableCell>
              <TableCell mobileLabel="服务">{service?.name ?? '服务已删除'}</TableCell>
              <TableCell mobileLabel="匹配条件"><strong>{rule.type === 'RULE-SET' ? (service?.ruleSet ?? service?.name ?? '外部规则集') : rule.value || ruleTypes[rule.type]?.[0] || rule.type}</strong>
                <small className="muted">{rule.type}</small></TableCell>
              <TableCell mobileLabel="出站策略">{service ? outletName(service, draft.groups) : '—'}</TableCell>
              <TableCell mobileLabel="状态"><Badge tone={!generated && rule.enabled && service?.enabled ? 'warning' : 'neutral'}>{generated ? '已生成' : !rule.enabled || !service?.enabled ? '已停用' : '有错误'}</Badge></TableCell>
              <TableCell className="table-row-wide"><div className="actions row-actions"><MoveButtons index={index} count={draft.rules.length} onMove={moveRule} area="rule" />
                {service && <IconButton icon={Pencil} label="编辑规则" onClick={() => navigate('rules', service.id, rule.id)} />}
                <Button variant="ghost" size="small" disabled={busy} onClick={() => run(() => save({ ...draft, rules: draft.rules.map(item => item.id === rule.id ? { ...item, enabled: !item.enabled } : item) }))}>{rule.enabled ? '停用' : '启用'}</Button>
                <IconButton icon={Trash2} label="删除单条规则" disabled={busy} onClick={async () => {
                  if (busy) return
                  if (await confirm({ title: '删除匹配规则？', detail: '此规则将从规则表中移除。', action: '删除规则', danger: true })) {
                    if (!busy) await run(() => saveRuleChanges(draft.rules.filter(item => item.id !== rule.id)))
                  }
                }} />
              </div></TableCell>
            </TableRow>
          })}
        </TableBody></Table>
        {visibleRules.length > 40 && <Pager offset={rulesOffset} pageSize={40} count={visibleRules.length} onChange={setRulesOffset} />}
      </>}
    </Panel></section>
    <section ref={catalogSection} className="rule-section"><Panel title="自定义规则集目录" count={state.library.providers.length} detail="保存常用远程地址。为服务添加后可独立设置出站策略和刷新周期。"
      actions={<Button icon={Plus} onClick={() => setCatalog({})}>添加目录条目</Button>}>
      {state.library.providers.length ? <div className="panel-padding stack tight">{state.library.providers.map(entry => <div className="list-option" key={entry.id}>
        <div><strong>{entry.name}</strong><p>{entry.behavior} · {entry.format} · 每 {entry.minutes} 分钟</p></div>
        <div className="actions"><Button icon={Plus} size="small" onClick={() => {
          const service = { ...newService(), name: entry.name, provider: { ...entry, catalogId: entry.id } }
          setEditing({ service, entries: [newRule(service.id, 'RULE-SET')] })
        }}>作为规则集添加</Button>
          <IconButton icon={Pencil} label={'编辑目录 ' + entry.name} onClick={() => setCatalog({ entry })} />
          <IconButton icon={Trash2} label={'删除目录 ' + entry.name} disabled={busy} onClick={async () => {
            if (busy) return
            if (await confirm({ title: '删除目录条目？', detail: '已添加的规则集会保有各自的设置。', action: '删除目录条目', danger: true })) {
              if (!busy) await run(async () => {
                if (applyState(await call('library', { ...state.library, providers: state.library.providers.filter(item => item.id !== entry.id) }))) {
                  notify('目录条目已删除')
                }
              })
            }
          }} /></div>
      </div>)}</div> : <Empty icon={Database} title="暂无目录条目" detail="支持经典规则、域名和 IP 网段列表。" />}
    </Panel></section>

    {editor && <ServiceEditor key={editor.service.id + '/' + (route.detail ?? '')} initial={editor.service} entries={editor.entries} focused={route.detail}
      onClose={() => { setEditing(null); navigate('rules') }} onBrowseSets={focusPicker} />}
    {catalog && <CatalogDialog entry={catalog.entry} onClose={() => setCatalog(null)} />}
  </div>
}
