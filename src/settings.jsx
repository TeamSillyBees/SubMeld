import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Copy, Download, Eye, EyeOff, Layers3, Link2, Plus, RotateCcw, ShieldCheck, SlidersHorizontal, Trash2, Upload } from 'lucide-react'
import { dnsPresets } from '../shared/catalog.js'
import { networkIssues } from '../shared/config.js'
import { useConfirm, useUnsavedChanges } from './confirm.jsx'
import { useProject } from './project.jsx'
import { Alert, Badge, Button, ButtonLink, Disclosure, Field, FieldGroup, FieldLegend, FieldSet, IconButton, Input, InputAction, Modal, NativeSelect, NativeSelectOption, PageTitle, Panel, PrivateLinkInput, Segmented, Textarea, Toggle, copyText, downloadJson, splitLines } from './ui.jsx'

function ListField({ label, hint, value, onChange, placeholder }) {
  return <Field label={label} hint={hint}><Textarea rows={3} spellCheck={false} defaultValue={value.join('\n')} onChange={event => onChange(splitLines(event.target.value))} placeholder={placeholder ? placeholder + '…' : undefined} /></Field>
}

export function SettingsPage() {
  const { state, view, save, call, applyState, notify } = useProject()
  const confirm = useConfirm()
  const [basedOn, setBasedOn] = useState(state.revision)
  const [original, setOriginal] = useState(state.draft.base)
  const [form, setForm] = useState(() => structuredClone(original))
  const [advancedText, setAdvancedText] = useState(() => JSON.stringify(original.advanced ?? {}, null, 2))
  const [fieldKey, setFieldKey] = useState(0)
  const [profiles, setProfiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lastField = useRef(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(original) || advancedText !== JSON.stringify(original.advanced ?? {}, null, 2)
  useUnsavedChanges(dirty, '网络与 DNS 将沿用原来的设置。')
  const issues = networkIssues(form, view.rules)
  const modeWarning = issues.find(issue => issue.code === 'base-mode')?.message
  const processWarning = issues.find(issue => issue.code === 'base-process')?.message
  const rememberField = event => { lastField.current = event.target }
  const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }))
  const dns = (key, value) => setForm(previous => ({ ...previous, dns: { ...previous.dns, [key]: value } }))
  function reset(next = state) {
    setOriginal(next.draft.base)
    setForm(structuredClone(next.draft.base))
    setAdvancedText(JSON.stringify(next.draft.base.advanced ?? {}, null, 2))
    setBasedOn(next.revision)
    setFieldKey(value => value + 1)
    setError('')
  }
  useEffect(() => {
    if (!dirty && state.revision !== basedOn) reset()
  }, [state.revision, dirty, basedOn])

  function finishEdit(next) {
    reset(next)
    requestAnimationFrame(() => {
      if (lastField.current?.isConnected) lastField.current.focus({ preventScroll: true })
      else document.querySelector('#main-content h1')?.focus()
    })
  }

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const advanced = JSON.parse(advancedText.trim() || '{}')
      if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) throw new SyntaxError()
      const base = { ...form, advanced: Object.keys(advanced).length ? advanced : undefined }
      finishEdit(await save({ ...state.draft, base }, basedOn, '基础设置已更新'))
    } catch (error) { setError(error instanceof SyntaxError ? '高级配置需要有效的 JSON 对象。' : error.message) }
    finally { setBusy(false) }
  }
  const dnsChoices = [['default', '系统 DNS'], ['encrypted', '加密 DNS · Fake IP'], ['real', '真实 IP · Redir-Host']]
  const { nameserverPolicy, ...presetFields } = form.dns
  const selectedPreset = dnsChoices.find(([id]) => JSON.stringify(presetFields) === JSON.stringify(dnsPresets[id]))?.[0]
  function applyDnsPreset(id) {
    set('dns', { ...structuredClone(dnsPresets[id]), ...(nameserverPolicy?.length ? { nameserverPolicy } : {}) })
    setFieldKey(value => value + 1)
  }
  return <div className="stack config-page">
    <h1 className="sr-only" tabIndex={-1}>基础设置</h1>
    <Panel title={<>基础配置 <code className="tech-chip">{form.mode} · {form.dns.enabled ? form.dns.mode : '系统 DNS'}</code></>}
      actions={<><Button size="small" icon={Layers3} disabled={dirty || busy} onClick={() => setProfiles(true)}>配置方案</Button>
        <Button size="small" icon={Check} disabled={!dirty || busy} onClick={submit}>保存基础设置</Button></>}>
      <div className="config-toolbar" onFocusCapture={rememberField}><div className="template-strip"><SlidersHorizontal aria-hidden="true" /><span>DNS 预设</span>
        {dnsChoices.map(([id, label]) => <Button size="small" key={id} aria-pressed={selectedPreset === id} disabled={busy} onClick={() => applyDnsPreset(id)}>{label}</Button>)}</div></div>
    </Panel>
    <div className="settings-grid" inert={busy} onFocusCapture={rememberField} onChangeCapture={rememberField}>
      <Panel title="连接与端口">
        <div className="panel-padding stack">
          {issues.filter(issue => issue.code === 'base-ports').map(issue => <Alert key={issue.code} tone="danger">{issue.message}</Alert>)}
          <FieldGroup className="form-grid">
            <Field label="混合端口（mixed-port）"><Input type="number" min="0" max="65535" value={form.port} onChange={event => set('port', Number(event.target.value))} /></Field>
            <FieldSet><FieldLegend variant="label">运行模式</FieldLegend><Segmented label="运行模式" value={form.mode} onChange={value => set('mode', value)} items={ [['rule', '规则模式'], ['global', '全局模式'], ['direct', '直连模式']] } />
              {modeWarning && <span className="field-note warning-text">{modeWarning}</span>}</FieldSet>
          </FieldGroup>
          <Disclosure title="独立端口与本机控制器" defaultOpen={Boolean(form.httpPort || form.socksPort || form.controllerPort)}><FieldGroup className="form-grid">
            {[['httpPort', 'HTTP 代理端口'], ['socksPort', 'SOCKS 代理端口'], ['controllerPort', '本机控制端口（127.0.0.1）']].map(([key, label]) =>
              <Field key={key} label={label}><Input type="number" min="0" max="65535" value={form[key] ?? 0} onChange={event => set(key, Number(event.target.value))} /></Field>)}
          </FieldGroup></Disclosure>
          <FieldGroup className="toggle-list" aria-label="网络开关">
            <Toggle label="允许局域网访问（allow-lan）" detail="开放代理端口供同一网络的设备使用。" checked={form.allowLan} onChange={value => set('allowLan', value)} />
            <Toggle label="IPv6" checked={form.ipv6 ?? true} detail={form.ipv6 === undefined ? '使用客户端默认值。' : undefined} onChange={value => set('ipv6', value)} />
            <Toggle label="统一延迟测量（unified-delay）" checked={form.unifiedDelay} onChange={value => set('unifiedDelay', value)} />
            <Toggle label="TCP 并发连接（tcp-concurrent）" checked={form.concurrent} onChange={value => set('concurrent', value)} />
          </FieldGroup>
          <Disclosure title="日志与进程识别"><FieldGroup className="form-grid">
            <Field label="日志级别"><NativeSelect value={form.logLevel} onChange={event => set('logLevel', event.target.value)}>
              <NativeSelectOption value="silent">静默</NativeSelectOption><NativeSelectOption value="error">错误</NativeSelectOption><NativeSelectOption value="warning">警告</NativeSelectOption><NativeSelectOption value="info">信息</NativeSelectOption><NativeSelectOption value="debug">调试</NativeSelectOption>
            </NativeSelect></Field>
            <Field label="进程识别" hint={processWarning ? <span className="warning-text">{processWarning}</span> : '进程规则依赖系统权限和客户端支持。'}><NativeSelect value={form.findProcess} onChange={event => set('findProcess', event.target.value)}>
              <NativeSelectOption value="strict">按需识别</NativeSelectOption><NativeSelectOption value="always">始终识别</NativeSelectOption><NativeSelectOption value="off">关闭识别</NativeSelectOption>
            </NativeSelect></Field>
          </FieldGroup></Disclosure>
          <Disclosure title="Mihomo 高级配置"><Field label="附加配置（JSON）" hint="可设置 profile、sniffer，以及 dns 的 listen、use-system-hosts、fake-ip-range 和 fallback-filter。">
            <Textarea rows={10} spellCheck={false} value={advancedText} onChange={event => setAdvancedText(event.target.value)} />
          </Field></Disclosure>
          <p className="field-note muted">端口设为 0 时关闭对应监听。</p>
        </div>
      </Panel>
      <Panel title="DNS 行为与策略">
        <div className="panel-padding stack">
          {issues.filter(issue => issue.code.startsWith('dns-')).map(issue => <Alert key={issue.code} tone="danger">{issue.message}</Alert>)}
          <Toggle label="启用 DNS（dns.enable）" checked={form.dns.enabled} onChange={value => dns('enabled', value)} detail="关闭内置 DNS 时使用系统解析器。" />
          <fieldset className="dns-fields stack" key={fieldKey} disabled={!form.dns.enabled}>
            <FieldSet><FieldLegend variant="label">增强模式（enhanced-mode）</FieldLegend>
              <Segmented label="DNS 响应方式" value={form.dns.mode} onChange={value => dns('mode', value)} items={ [['fake-ip', 'Fake IP'], ['redir-host', 'Redir-Host']] } />
            </FieldSet>
            <Toggle label="遵循路由规则（respect-rules）" checked={form.dns.respectRules ?? false} onChange={value => dns('respectRules', value)} />
            <ListField label="主要解析服务器（nameserver）" value={form.dns.nameservers} onChange={value => dns('nameservers', value)} placeholder="https://dns.alidns.com/dns-query" hint="每行一个，可填写 IP、DoH 或 DoT 地址。" />
            <ListField label="备用解析服务器（fallback）" value={form.dns.fallback} onChange={value => dns('fallback', value)} placeholder="tls://1.1.1.1" />
            <Disclosure title="解析策略与例外"><FieldGroup>
              <ListField label="引导 DNS" value={form.dns.bootstrap} onChange={value => dns('bootstrap', value)} placeholder="223.5.5.5" hint="用于解析 DNS 服务自身域名，请使用 IP 地址。" />
              <ListField label="节点域名解析服务器" value={form.dns.proxyNameservers} onChange={value => dns('proxyNameservers', value)} placeholder="119.29.29.29" />
              <ListField label="按域名指定 DNS（nameserver-policy）" value={form.dns.nameserverPolicy ?? []} onChange={value => dns('nameserverPolicy', value)}
                hint="每行填写域名和解析服务器，用空格分隔。+.example.com 包含其子域名。" placeholder="+.example.com tls://1.1.1.1" />
              {form.dns.mode === 'fake-ip' && <ListField label="Fake IP 例外域名" value={form.dns.fakeIPFilter} onChange={value => dns('fakeIPFilter', value)} placeholder="*.lan" />}
              <Toggle label="使用 Hosts 映射" checked={form.dns.useHosts ?? true} onChange={value => dns('useHosts', value)} />
              <ListField label="Hosts 映射" value={form.hosts ?? []} onChange={value => set('hosts', value)} hint="每行填写域名和 IP，用空格分隔。" placeholder="printer.lan 192.168.1.10" />
            </FieldGroup></Disclosure>
          </fieldset>
        </div>
      </Panel>
    </div>
    {state.library.filters.length > 0 && <Panel title="筛选模板">
      <div className="panel-padding stack tight">{state.library.filters.map(template => <div className="list-option" key={template.id}>
        <strong>{template.name}</strong><IconButton icon={Trash2} label={'删除筛选模板 ' + template.name} onClick={async () => {
          if (!await confirm({ title: '删除筛选模板？', detail: '已应用此模板的订阅源会保留其筛选条件。', action: '删除模板', danger: true })) return
          try { applyState(await call('library', { ...state.library, filters: state.library.filters.filter(item => item.id !== template.id) })); notify('筛选模板已删除') } catch (error) { notify(error.message, 'danger') }
        }} />
      </div>)}</div>
    </Panel>}
    {dirty && <div className="settings-save-bar">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="actions">
        <Button icon={RotateCcw} variant="ghost" disabled={busy} onClick={() => finishEdit(state)}>撤销更改</Button>
        <Button icon={Check} variant="primary" busy={busy} onClick={submit}>保存设置</Button>
      </div>
    </div>}
    {profiles && <ProfilesDialog onClose={() => setProfiles(false)} />}
  </div>
}

function ProfilesDialog({ onClose }) {
  const { state, call, applyState, notify, navigate } = useProject()
  const confirm = useConfirm()
  const [action, setAction] = useState('create')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const guard = useUnsavedChanges(Boolean(title.trim() && (action !== 'rename' || title !== state.title)), '下次需重新填写方案名称。')
  const close = () => { if (!busy) return guard.close(onClose) }
  async function commit() {
    setBusy(true)
    setError('')
    try {
      applyState(await call('profiles', { action, title }))
      notify('配置方案已保存')
      guard.leave(() => {
        onClose()
        if (action !== 'rename') void navigate('home')
      })
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  return <Modal title="独立配置方案" detail="每个方案都有独立的订阅源、配置、发布历史和私有链接。可从侧栏切换。" onClose={close} footer={<>
    <Button onClick={close}>取消</Button><Button variant="primary" icon={Plus} disabled={!title.trim()} busy={busy} onClick={commit}>{action === 'rename' ? '保存名称' : action === 'clone' ? '复制方案' : '新建方案'}</Button>
  </>}>
    <div className="stack">
      {error && <Alert tone="danger">{error}</Alert>}
      <FieldGroup className="form-grid"><Field label="方案操作"><NativeSelect value={action} onChange={event => { const value = event.target.value; setAction(value); setTitle(value === 'rename' ? state.title : '') }}>
        <NativeSelectOption value="create">新建空白方案</NativeSelectOption><NativeSelectOption value="clone">复制当前配置和节点</NativeSelectOption><NativeSelectOption value="rename">重命名当前方案</NativeSelectOption>
      </NativeSelect></Field>
        <Field label="方案名称"><Input maxLength={64} value={title} onChange={event => setTitle(event.target.value)} /></Field></FieldGroup>
      {state.profiles.length > 1 && <div><Button variant="danger" icon={Trash2} disabled={busy} onClick={async () => {
        if (!await confirm({ title: '删除当前配置方案？', detail: '将删除「' + state.title + '」及其历史。此方案的私有链接会失效。', action: '删除配置方案', danger: true })) return
        setBusy(true)
        try {
          applyState(await call('profiles', { action: 'delete' }))
          guard.leave(() => { onClose(); void navigate('home') })
          notify('配置方案已删除')
        }
        catch (error) { setError(error.message) }
        finally { setBusy(false) }
      }}>删除当前方案</Button></div>}
    </div>
  </Modal>
}

function PasswordDialog({ onClose }) {
  const { call, notify } = useProject()
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const guard = useUnsavedChanges(Boolean(current || password || repeat), '已输入的密码会从此表单清除。')
  const close = () => { if (!busy) return guard.close(onClose) }
  return <Modal title="更改管理密码" detail="更改后，其他管理页面需要重新登录。" onClose={close} footer={<>
    <Button onClick={close}>取消</Button><Button variant="primary" busy={busy} onClick={async () => {
      if (!current || password.length < 10) return setError('请填写当前密码及至少 10 个字符的新密码。')
      if (password !== repeat) return setError('两次输入的新密码不一致。')
      setBusy(true)
      try { await call('password', { current, password }); notify('管理密码已修改'); guard.leave(onClose) }
      catch (error) { setError(error.message) } finally { setBusy(false) }
    }}>更改密码</Button>
  </>}>
    <FieldGroup>{error && <Alert tone="danger">{error}</Alert>}
      <Field label="当前密码"><Input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} /></Field>
      <Field label="新密码" hint="至少 10 个字符"><Input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></Field>
      <Field label="确认新密码"><Input type="password" autoComplete="new-password" value={repeat} onChange={event => setRepeat(event.target.value)} /></Field>
    </FieldGroup>
  </Modal>
}

function BackupDialog({ mode, onClose }) {
  const { call, applyState, notify } = useProject()
  const confirm = useConfirm()
  const [password, setPassword] = useState('')
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const restore = mode === 'restore'
  const guard = useUnsavedChanges(Boolean(password || file), '已选择的备份文件和口令会从此表单清除。')
  const close = () => { if (!busy) return guard.close(onClose) }
  async function commit() {
    if (restore && !await confirm({ title: '恢复备份并替换配置？', detail: '当前方案、历史版本和节点缓存都会被替换。恢复后需重新生成私有订阅链接。', action: '恢复备份', danger: true })) return
    setError('')
    setBusy(true)
    try {
      if (restore) {
        const backup = JSON.parse(await file.text())
        applyState(await call('backup/import', { backup, passphrase: password }))
        notify('备份已恢复，私有链接可重新生成')
      } else {
        const result = await call('backup/export', { passphrase: password })
        downloadJson('SubMeld-加密备份.json', result)
        notify('加密备份已下载')
      }
      guard.leave(onClose)
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  return <Modal title={restore ? '从备份恢复' : '导出加密备份'} onClose={close}
    footer={<><Button disabled={busy} onClick={close}>取消</Button><Button variant={restore ? 'danger' : 'primary'} icon={restore ? Upload : Download} busy={busy}
      disabled={password.length < 10 || restore && !file} onClick={commit}>{restore ? '恢复备份' : '下载备份'}</Button></>}>
    <FieldGroup>
      <Alert tone={restore ? 'warning' : 'info'}>{restore
        ? '恢复会替换全部配置方案及历史版本，保留当前管理密码。原私有链接将失效，恢复后需生成新的订阅链接。'
        : '文件包含订阅源凭证、节点连接参数、配置和发布历史。请将口令与文件分开保存。'}</Alert>
      {error && <Alert tone="danger">{error}</Alert>}
      {restore && <Field label="备份文件"><Input type="file" accept=".json,application/json" onChange={event => setFile(event.target.files?.[0] ?? null)} /></Field>}
      <Field label="备份口令" hint="至少 10 个字符"><Input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></Field>
    </FieldGroup>
  </Modal>
}

export function SafetyPage() {
  const { state, call, reload, notify } = useProject()
  const confirm = useConfirm()
  const [password, setPassword] = useState(false)
  const [backup, setBackup] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  async function manage(action) {
    if (action === 'rotate' && state.hasLink && !await confirm({
      title: '更换私有订阅链接？', detail: '旧地址会立即失效，已订阅的设备需要更新链接。', action: '更换链接', danger: true,
    })) return
    if (action === 'revoke' && !await confirm({
      title: '撤销私有订阅链接？', detail: '保存此链接的客户端将无法再次下载配置。', action: '撤销链接', danger: true,
    })) return
    setBusy(true)
    try {
      const result = await call('link', action ? { action } : undefined)
      if (action) {
        setLink('')
        await reload()
        notify(action === 'rotate' ? '私有链接已生成' : '私有链接已撤销')
      } else setLink(result.url ?? '')
    } catch (error) { notify(error.message, 'danger') } finally { setBusy(false) }
  }
  useEffect(() => { if (!state.hasLink) setLink('') }, [state.hasLink])
  return <div className="stack">
    <PageTitle title="安全与备份" />
    <div className="settings-grid">
      <Panel title="私有订阅链接"
        actions={<Badge tone={state.hasLink ? 'success' : 'neutral'} dot>{state.hasLink ? '有效链接' : state.revoked ? '已撤销' : '尚未生成'}</Badge>}>
        <div className="panel-padding stack">
          {state.hasLink && <Field label="私有订阅链接" name="private_subscription_url" hint="持有链接的人可以下载节点连接和认证信息。请勿公开分享。">
            <PrivateLinkInput value={link} placeholder="••••••••••••••••••••••••••••"
              onFocus={event => { if (link) event.target.select() }} actions={<>
                <InputAction icon={link ? EyeOff : Eye} label={link ? '遮挡私有链接' : '显示私有链接'} disabled={busy} onClick={() => link ? setLink('') : manage()} />
                <InputAction icon={Copy} label="复制私有链接" disabled={busy} onClick={async () => {
                  try { const { url } = await call('link'); if (url) { await copyText(url); notify('私有链接已复制') } } catch (error) { notify(error.message, 'danger') }
                }} />
              </>} />
          </Field>}
          {!state.current && <p className="muted field-note">首次发布后可在此获取订阅链接。 <ButtonLink size="small" variant="ghost" icon={ArrowUpRight} page="publish">配置发布</ButtonLink></p>}
          <div className="actions"><Button icon={Link2} onClick={() => manage('rotate')} busy={busy}>{state.hasLink ? '更换链接' : '生成私有链接'}</Button>
            {state.hasLink && <Button icon={Trash2} variant="danger" disabled={busy} onClick={() => manage('revoke')}>撤销链接</Button>}</div>
        </div>
      </Panel>
      <Panel title="管理访问" detail="管理员可查看和修改全部配置方案。">
        <div className="panel-padding">
          <div><Button icon={ShieldCheck} onClick={() => setPassword(true)}>更改管理密码</Button></div>
        </div>
      </Panel>
    </div>
    <Panel title="备份与恢复" detail="保存全部方案、节点缓存、规则以及版本历史。">
      <div className="panel-padding">
        <div className="actions"><Button icon={Download} onClick={() => setBackup('export')}>导出备份</Button><Button icon={Upload} onClick={() => setBackup('restore')}>从备份恢复</Button></div>
      </div>
    </Panel>
    {password && <PasswordDialog onClose={() => setPassword(false)} />}
    {backup && <BackupDialog mode={backup} onClose={() => setBackup('')} />}
  </div>
}
