import { cloneElement, isValidElement, useId, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Copy, GripVertical, Info, Search, TriangleAlert, X } from 'lucide-react'
import { Alert as AlertRoot, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge as BadgeRoot } from '@/components/ui/badge'
import { Button as ButtonRoot } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty as EmptyRoot, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field as FieldRoot, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input as InputRoot } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea as TextareaRoot } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { builtins } from '../shared/catalog.js'
import { useProject, useSearchValue } from './project.jsx'

export { Checkbox, FieldGroup, FieldLegend, FieldSet, NativeSelect, NativeSelectOptGroup, NativeSelectOption }
export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false })
const numberFormat = new Intl.NumberFormat('zh-CN')
export const newId = () => globalThis.crypto?.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('')
export const formatTime = value => value ? dateFormat.format(new Date(value)) : '—'
export const formatNumber = value => numberFormat.format(value ?? 0)
export const searchable = (value, search) => String(value ?? '').toLowerCase().includes(search.trim().toLowerCase())
export const splitLines = (value, separators = /[\r\n,，;；]+/) => [...new Set(value.split(separators).map(x => x.trim()).filter(Boolean))]

export async function api(path, body, options) {
  const response = await fetch(path, body === undefined ? options : {
    ...options, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (response.ok) return response.json()
  const payload = await response.json().catch(() => null)
  throw Object.assign(new Error(payload?.message ?? '请求失败，请检查服务是否在线。'), { status: response.status, detail: payload?.detail })
}

const variants = { primary: 'default', secondary: 'outline', danger: 'destructive' }
const sizes = { small: 'sm' }

export function Button({ children, icon: Icon, variant = 'secondary', size = 'default', busy, type = 'button', disabled, ...props }) {
  return <ButtonRoot variant={variants[variant] ?? variant} size={sizes[size] ?? size} type={type}
    disabled={disabled || busy} aria-busy={busy || undefined} {...props}>
    {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : Icon && <Icon data-icon="inline-start" aria-hidden="true" />}
    {children}
  </ButtonRoot>
}

export function IconButton({ icon, label, size = 'icon', ...props }) {
  return <Button variant="ghost" size={size} icon={icon} title={label} aria-label={label} {...props} />
}

export function RouteLink({ page, id, detail, onClick, ...props }) {
  const { hrefFor, navigate } = useProject()
  return <a href={hrefFor(page, id, detail)} {...props} onClick={event => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    void navigate(page, id, detail)
  }} />
}

export function ButtonLink({ icon: Icon, children, variant = 'secondary', size = 'default', ...props }) {
  return <ButtonRoot asChild variant={variants[variant] ?? variant} size={sizes[size] ?? size}>
    <RouteLink {...props}>{Icon && <Icon data-icon="inline-start" aria-hidden="true" />}{children}</RouteLink>
  </ButtonRoot>
}

export function Badge({ children, tone = 'neutral', dot, ...props }) {
  const variant = tone === 'danger' ? 'destructive' : 'secondary'
  return <BadgeRoot variant={variant} data-tone={tone} {...props}>
    {dot && <span className="status-dot" aria-hidden="true" />}{children}
  </BadgeRoot>
}

export function Alert({ children, tone = 'info', title, action }) {
  const Icon = tone === 'success' ? CircleCheck : tone === 'warning' || tone === 'danger' ? TriangleAlert : Info
  return <AlertRoot data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'} variant={tone === 'danger' ? 'destructive' : 'default'}>
    <Icon aria-hidden="true" />
    {title && <AlertTitle>{title}</AlertTitle>}
    {children && <AlertDescription>{children}</AlertDescription>}
    {action && <AlertAction>{action}</AlertAction>}
  </AlertRoot>
}

export function PageTitle({ title, detail, actions }) {
  return <header className="page-title">
    <div className="min-w-0"><h1 tabIndex={-1}>{title}</h1>{detail && <p>{detail}</p>}</div>
    {actions && <div className="actions page-actions">{actions}</div>}
  </header>
}

export function Panel({ title, count, detail, actions, footer, className, children }) {
  const id = useId()
  return <Card role={title ? 'region' : undefined} aria-labelledby={title ? id : undefined} className={cn('workspace-panel', className)}>
    {(title || actions) && <CardHeader className="workspace-panel-header">
      <div className="min-w-0">{title && <CardTitle><h2 id={id}>{title}{count != null && <span className="panel-count">{count}</span>}</h2></CardTitle>}
        {detail && <CardDescription>{detail}</CardDescription>}</div>
      {actions && <CardAction className="actions">{actions}</CardAction>}
    </CardHeader>}
    <CardContent className="workspace-panel-content">{children}</CardContent>
    {footer && <CardFooter className="workspace-panel-footer">{footer}</CardFooter>}
  </Card>
}

export function Empty({ icon: Icon, title, detail, actions }) {
  return <EmptyRoot className="workspace-empty">
    <EmptyHeader>
      {Icon && <EmptyMedia variant="icon"><Icon aria-hidden="true" /></EmptyMedia>}
      <EmptyTitle>{title}</EmptyTitle>
      {detail && <EmptyDescription>{detail}</EmptyDescription>}
    </EmptyHeader>
    {actions && <EmptyContent className="actions">{actions}</EmptyContent>}
  </EmptyRoot>
}

export function IssueList({ items, className }) {
  const [offset, setOffset] = usePage(items.length, 10)
  return <>
    <ul className={cn('issue-list', className)}>
      {items.slice(offset, offset + 10).map((issue, index) => <li key={issue.code + '/' + index}>
        <Badge tone={issue.severity === 'error' ? 'danger' : 'warning'}>{issue.severity === 'error' ? '错误' : '提醒'}</Badge>
        <p>{issue.message}</p>
        {issue.pane && issue.pane !== 'publish' && <ButtonLink size="small" variant="ghost" icon={ArrowRight} page={issue.pane} id={issue.id} detail={issue.relatedId}>定位</ButtonLink>}
      </li>)}
    </ul>
    {items.length > 10 && <Pager offset={offset} pageSize={10} count={items.length} onChange={setOffset} />}
  </>
}

export const Input = ({ autoComplete = 'off', name, ...props }) => <InputRoot autoComplete={autoComplete} name={name ?? props['aria-label']} {...props} />
export const Textarea = ({ autoComplete = 'off', ...props }) => <TextareaRoot autoComplete={autoComplete} {...props} />

export function Field({ label, hint, error, children, className, name, disabled }) {
  const id = useId()
  const inputId = children?.props?.id ?? id
  const describedBy = [hint ? id + '-hint' : null, error ? id + '-error' : null].filter(Boolean).join(' ') || undefined
  const control = isValidElement(children) ? cloneElement(children, {
    id: inputId,
    name: children.props.name ?? name ?? label,
    'aria-describedby': describedBy,
    'aria-invalid': Boolean(error) || undefined,
    disabled: disabled ?? children.props.disabled,
  }) : children
  return <FieldRoot className={cn('min-w-0', className)} data-invalid={error ? true : undefined} data-disabled={disabled ?? children?.props?.disabled}>
    <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
    {control}
    {hint && <FieldDescription id={id + '-hint'}>{hint}</FieldDescription>}
    {error && <FieldError id={id + '-error'} aria-live="polite">{error}</FieldError>}
  </FieldRoot>
}

export function Toggle({ checked, onChange, label, detail }) {
  const id = useId()
  return <FieldRoot orientation="horizontal" className="setting-toggle">
    <FieldContent className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {detail && <FieldDescription id={id + '-description'}>{detail}</FieldDescription>}
    </FieldContent>
    <Switch id={id} name={label} checked={checked} onCheckedChange={onChange} aria-describedby={detail ? id + '-description' : undefined} />
  </FieldRoot>
}

export function CheckOption({ label, children, checked, onCheckedChange, ...props }) {
  const id = useId()
  return <FieldRoot orientation="horizontal" className="check-option">
    <Checkbox id={id} name={typeof label === 'string' ? label : undefined} checked={checked} onCheckedChange={onCheckedChange} {...props} />
    <FieldLabel htmlFor={id}>{label ?? children}</FieldLabel>
  </FieldRoot>
}

export function PageCheckbox({ label, ...props }) {
  return <label className="page-checkbox">
    <Checkbox aria-label={label} {...props} />
    <span className="mobile-cell-label" aria-hidden="true">本页全选</span>
  </label>
}

export function SearchBox({ value, onChange, placeholder = '搜索', label, name = 'search' }) {
  return <InputGroup className="search-box">
    <InputGroupInput type="search" name={name} autoComplete="off" spellCheck={false} aria-label={label ?? placeholder}
      value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder + '…'} />
    <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
  </InputGroup>
}

export function SecretInput({ type = 'password', actions, ...props }) {
  return <InputGroup>
    <InputGroupInput type={type} autoComplete="off" spellCheck={false} {...props} />
    {actions && <InputGroupAddon align="inline-end">{actions}</InputGroupAddon>}
  </InputGroup>
}

export function InputAction({ icon: Icon, label, ...props }) {
  return <InputGroupButton size="icon-sm" title={label} aria-label={label} {...props}>
    <Icon aria-hidden="true" data-icon="inline-start" />
  </InputGroupButton>
}

export function Segmented({ items, value, onChange, label }) {
  return <ToggleGroup className="segmented" type="single" role="radiogroup" aria-label={label} value={value} spacing={1}
    onValueChange={next => { if (next) onChange(next) }}>
    {items.map(([key, name]) => <ToggleGroupItem key={key} value={key} title={typeof name === 'string' ? name : undefined}><span>{name}</span></ToggleGroupItem>)}
  </ToggleGroup>
}

export function MultiSelect({ label, options, values, onChange, placeholder = '全部' }) {
  const id = useId()
  const [query, setQuery] = useState('')
  const selected = new Set(values)
  const available = options.filter(([, name]) => searchable(name, query))
  return <FieldRoot className="multi-field">
    <FieldLabel id={id + '-label'} htmlFor={id}>{label}</FieldLabel>
    <Popover onOpenChange={open => { if (!open) setQuery('') }}>
      <PopoverTrigger asChild>
        <Button id={id} aria-labelledby={id + '-label ' + id + '-value'} className="multi-trigger">
          <span className="truncate" id={id + '-value'}>{values.length ? options.filter(([key]) => selected.has(key)).map(([, name]) => name).join('、') : placeholder}</span>
          <ChevronDown data-icon="inline-end" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="option-popover" aria-label={label + '选项'}>
        <SearchBox value={query} onChange={setQuery} placeholder="搜索地区" />
        <FieldSet>
          <FieldLegend className="sr-only">{label}</FieldLegend>
          <FieldGroup className="option-scroll">
            {available.map(([key, name]) => <CheckOption key={key} label={name} checked={selected.has(key)} onCheckedChange={enabled => {
              onChange(enabled ? [...values, key] : values.filter(value => value !== key))
            }} />)}
            {!available.length && <p className="muted">没有匹配的地区。</p>}
          </FieldGroup>
        </FieldSet>
        {values.length > 0 && <Button size="small" variant="ghost" onClick={() => onChange([])}>清除选择</Button>}
      </PopoverContent>
    </Popover>
  </FieldRoot>
}

export function Modal({ title, detail, wide, className, initialFocusRef, onClose, onCloseAutoFocus, children, footer }) {
  const heading = useRef(null)
  const trigger = useRef(document.activeElement)
  return <Dialog open onOpenChange={open => { if (!open) void onClose() }}>
    <DialogContent className={cn('workspace-dialog', wide && 'workspace-dialog-wide', className)}
      showCloseButton={false} {...(!detail ? { 'aria-describedby': undefined } : {})}
      onPointerDownOutside={event => event.preventDefault()}
      onOpenAutoFocus={event => {
        event.preventDefault()
        if (initialFocusRef?.current) initialFocusRef.current.focus()
        else heading.current?.focus({ preventScroll: true })
      }}
      onCloseAutoFocus={event => {
        onCloseAutoFocus?.(event)
        if (event.defaultPrevented) return
        event.preventDefault()
        const target = trigger.current?.isConnected && trigger.current !== document.body
          ? trigger.current : document.querySelector('#main-content h1')
        if (target && !target.closest('[aria-hidden="true"]')) target.focus({ preventScroll: true })
      }}>
      <DialogHeader className="workspace-dialog-header">
        <div className="min-w-0">
          <DialogTitle ref={heading} tabIndex={-1}>{title}</DialogTitle>
          {detail && <DialogDescription>{detail}</DialogDescription>}
        </div>
        <IconButton icon={X} label="关闭" onClick={onClose} />
      </DialogHeader>
      <div className="workspace-dialog-body">{children}</div>
      {footer && <DialogFooter className="workspace-dialog-footer">{footer}</DialogFooter>}
    </DialogContent>
  </Dialog>
}

export function Disclosure({ title, defaultOpen, open, onOpenChange, compact, children }) {
  return <Collapsible defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange} className={cn('disclosure', compact && 'disclosure-compact')}>
    <CollapsibleTrigger asChild>
      <Button variant="ghost" size={compact ? 'small' : 'default'} className="disclosure-trigger">
        <ChevronRight data-icon="inline-start" aria-hidden="true" />{title}
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="disclosure-content">{children}</CollapsibleContent>
  </Collapsible>
}

export function Pager({ offset, pageSize, count, onChange }) {
  const start = count ? offset + 1 : 0
  return <nav className="pager" aria-label="分页">
    <span aria-live="polite">第 {formatNumber(start)}–{formatNumber(Math.min(offset + pageSize, count))} 项，共 {formatNumber(count)} 项</span>
    <IconButton icon={ChevronLeft} label="上一页" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))} />
    <IconButton icon={ChevronRight} label="下一页" disabled={offset + pageSize >= count} onClick={() => onChange(offset + pageSize)} />
  </nav>
}

export function usePage(count, pageSize = 40) {
  const [position, setPosition] = useState(0)
  return [Math.min(position, Math.max(0, Math.ceil(count / pageSize) - 1) * pageSize), setPosition]
}

export function useListPage(count, pageSize = 40, parameter = 'page') {
  const [value, setValue] = useSearchValue(parameter, '1')
  const page = Math.floor(Number(value))
  const pages = Math.max(1, Math.ceil(count / pageSize))
  const current = Number.isFinite(page) ? Math.max(1, Math.min(page, pages)) : 1
  return [(current - 1) * pageSize, offset => setValue(String(Math.floor(offset / pageSize) + 1))]
}

export function moveAt(values, from, to) {
  if (from < 0 || to < 0 || from === to || to >= values.length) return values
  const next = [...values]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

export function dragProps(index, onMove, area = 'items') {
  return {
    onDragOver: event => { if (event.dataTransfer.types.includes('application/x-submeld-' + area)) event.preventDefault() },
    onDrop: event => {
      const value = event.dataTransfer.getData('application/x-submeld-' + area)
      if (!value) return
      event.preventDefault()
      event.stopPropagation()
      const from = Number(value)
      if (Number.isInteger(from) && from !== index) onMove(from, index)
    },
  }
}

export function DragHandle({ index, area }) {
  return <span className="grip" draggable title="拖动排序" aria-hidden="true" onDragStart={event => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('application/x-submeld-' + area, String(index))
      const row = event.currentTarget.closest('[data-sort-row]')
      if (row) {
        row.setAttribute('inert', '')
        window.addEventListener('dragend', () => row.removeAttribute('inert'), { once: true })
      }
    }}><GripVertical /></span>
}

export function MoveButtons({ index, count, onMove, area = 'items', drag = true }) {
  return <span className="moves">
    {drag && <DragHandle index={index} area={area} />}
    <IconButton icon={ArrowUp} size="icon-sm" label="上移" disabled={index === 0} onClick={() => onMove(index, index - 1)} />
    <IconButton icon={ArrowDown} size="icon-sm" label="下移" disabled={index + 1 >= count} onClick={() => onMove(index, index + 1)} />
  </span>
}

export function OutletSelect({ groups, value, onChange, disabled, className, label = '出站策略', ...props }) {
  return <NativeSelect className={className} aria-label={props.id ? undefined : label} name={label} disabled={disabled}
    value={value} onChange={event => onChange(event.target.value)} {...props}>
    <NativeSelectOption value="">选择代理组或内置策略</NativeSelectOption>
    <NativeSelectOptGroup label="内置代理策略">{Object.entries(builtins).map(([key, text]) => <NativeSelectOption key={key} value={key}>{key} · {text}</NativeSelectOption>)}</NativeSelectOptGroup>
    <NativeSelectOptGroup label="代理组">{groups.map(group => <NativeSelectOption disabled={!group.enabled} key={group.id} value={group.id}>{group.name}{group.enabled ? '' : '（已停用）'}</NativeSelectOption>)}</NativeSelectOptGroup>
    {value && !Object.hasOwn(builtins, value) && !groups.some(group => group.id === value) && <NativeSelectOption value={value} disabled>已删除的代理组</NativeSelectOption>}
  </NativeSelect>
}

export function SourceStatus({ entry, record }) {
  if (record?.status === 'running' || record?.status === 'queued') return <Badge tone="accent"><Spinner aria-hidden="true" />{record.status === 'queued' ? '等待刷新' : '刷新中…'}</Badge>
  if (!entry.enabled) return <Badge dot>已停用</Badge>
  if (entry.local && record?.good) return <Badge dot>本地文件</Badge>
  if (record?.error) return <Badge tone="danger" dot>{record.good ? '失败，使用旧数据' : '获取失败'}</Badge>
  if (entry.paused) return <Badge tone="warning" dot>更新已暂停</Badge>
  if (record?.good) return <Badge tone="success" dot>可用</Badge>
  return <Badge dot>待获取</Badge>
}

export function Schedule({ record }) {
  return <dl className="schedule">
    <div><dt>最近成功</dt><dd><TimeLabel value={record?.lastSuccess} /></dd></div>
    <div><dt>最近尝试</dt><dd><TimeLabel value={record?.lastAttempt} /></dd></div>
    <div><dt>下次计划</dt><dd><TimeLabel value={record?.next} /></dd></div>
  </dl>
}

export async function copyText(value) {
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(value); return } catch { /* Try the selection-based copy command. */ }
  }
  const active = document.activeElement
  const input = Object.assign(document.createElement('textarea'), { value, readOnly: true, className: 'sr-only' })
  const container = active?.closest('[role="dialog"],[role="alertdialog"]') ?? document.body
  container.append(input)
  try {
    input.select()
    if (!document.execCommand('copy')) throw new Error('浏览器阻止了复制。请在安全与备份中显示链接后手动复制。')
  } finally {
    input.remove()
    active?.focus({ preventScroll: true })
  }
}

export function CopyLinkButton({ variant = 'primary', size, children = '复制订阅链接' }) {
  const { call, notify, navigate } = useProject()
  const [busy, setBusy] = useState(false)
  return <Button icon={Copy} variant={variant} size={size} aria-label="复制订阅链接" busy={busy} onClick={async () => {
    setBusy(true)
    try {
      const { url } = await call('link')
      if (!url) { await navigate('safety'); return }
      await copyText(url)
      notify('私有订阅链接已复制')
    } catch (error) { notify(error.message, 'danger') } finally { setBusy(false) }
  }}>{children}</Button>
}

export function downloadJson(name, data) {
  const address = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href: address, download: name })
  link.click()
  setTimeout(() => URL.revokeObjectURL(address), 1000)
}

export const versionLabel = version => version ? 'v' + formatNumber(version.seq) : '—'
export const versionKind = version => ({ publish: '手动发布', auto: '自动更新', rollback: '回滚' }[version?.kind] ?? '')

export function TimeLabel({ value }) {
  return value ? <time className="numeric" dateTime={value}>{formatTime(value)}</time> : <span className="muted">—</span>
}
