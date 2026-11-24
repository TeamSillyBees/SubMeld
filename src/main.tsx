import type { ReactNode, ComponentType, FormEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Draft, Issue, WorkspaceState } from '../shared/model.ts'
import type { ProbeDevice } from '../shared/quality.ts'
import { hasQualityConditions } from '../shared/group-filter.ts'
import { latestQualitySnapshot, type LatestQualityMap } from '../shared/quality-snapshot.ts'
import { api, type Call, type Endpoint, type LocalInput, type Payload, type ResponseFor, type Session } from './api.ts'
import type { ChangeProfile, Destination, Feedback, NavigationGuard, ProfileAction, ProjectQuality, Route, View } from './project.tsx'
import { asError } from './errors.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import logo from '../docs/assets/submeld-logo.svg'
import { setNonce } from 'get-nonce'
import { Activity, CircleHelp, Filter, Gauge, GitFork, History, Layers3, Link2, LogOut, Send, Server, Settings2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from '@/components/ui/breadcrumb'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from './confirm.tsx'
import { Dashboard } from './dashboard.tsx'
import { GroupsPage } from './groups.tsx'
import { createFeedbackNotifier } from './notify.ts'
import { ProfileNameDialog, ProfileSelector, type NameAction } from './profiles.tsx'
import { ProjectContext, projection } from './project.tsx'
import { PublishPage, UpdatesPage } from './release.tsx'
import { QualityPage } from './quality-page.tsx'
import { RulesPage } from './rules.tsx'
import { SafetyPage, SettingsPage } from './settings.tsx'
import { NodesPage, SourcesPage } from './sources.tsx'
import { refreshWorkspace } from './workspace-sync.ts'
import { Alert, Button, ButtonLink, Field, FieldGroup, IconButton, Input, Modal, RouteLink, formatNumber, versionLabel } from './ui.tsx'

// Radix injects the scrollbar compensation for open dialogs.
const styleNonce = document.querySelector<HTMLElement>('meta[property="csp-nonce"]')?.nonce
if (styleNonce) setNonce(styleNonce)

const pages: [string, string, LucideIcon, ComponentType][] = [
  ['home', '概览', Activity, Dashboard],
  ['sources', '订阅源', Server, SourcesPage],
  ['nodes', '节点管理', Filter, NodesPage],
  ['groups', '代理组', Layers3, GroupsPage],
  ['quality', '质量检测', Gauge, QualityPage],
  ['rules', '路由规则', GitFork, RulesPage],
  ['settings', '基础设置', Settings2, SettingsPage],
  ['publish', '配置发布', Send, PublishPage],
  ['updates', '更新记录', History, UpdatesPage],
  ['safety', '安全与备份', ShieldCheck, SafetyPage],
]

const sections: [string, typeof pages][] = [
  ['订阅分发', pages.slice(0, 2)],
  ['聚合与分流', pages.slice(2, 6)],
  ['系统与发布', pages.slice(6)],
]

function routeFromHash(hash = location.hash) {
  const [path, query] = hash.replace(/^#\/?/, '').split('?', 2)
  const [area, id, detail] = path.split('/').map(value => {
    try { return decodeURIComponent(value) } catch { return '' }
  })
  return { page: pages.some(([page]) => page === area) ? area : 'home', id, detail, path, params: new URLSearchParams(query) }
}

function Brand() {
  return <span className="brand" translate="no">
    <img className="brand-symbol" src={logo} alt="" width={32} height={32} />
    <strong className="brand-type">SubMeld</strong>
  </span>
}

function SignIn({ session, onDone }: { session: Session; onDone: (next: Session) => void }) {
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<{ field: string | null; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const passwordInput = useRef<HTMLInputElement>(null)
  const repeatInput = useRef<HTMLInputElement>(null)
  const setup = session.setup
  const needsSetup = !session.configured && !setup

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (setup && password !== repeat) {
      setError({ field: 'repeat', text: '请让两次输入的密码一致。' })
      repeatInput.current?.focus()
      return
    }
    setBusy(true)
    try { onDone(await api<Session>(setup ? '/api/setup' : '/api/login', { password })) }
    catch (cause) {
      const error = asError(cause)
      setError({ field: error.status === 401 ? 'password' : null, text: error.message })
      if (error.status === 401) passwordInput.current?.focus()
    }
    finally { setBusy(false) }
  }

  return <main className="auth-shell">
    <div className="auth-form">
      <Brand />
      <Card className="auth-card">
        <CardHeader>
          <CardTitle><h1>{needsSetup ? '等待初始化' : setup ? '创建管理密码' : '登录工作台'}</h1></CardTitle>
        </CardHeader>
        <CardContent>
          {needsSetup ? <Alert tone="warning">请在服务端本机创建管理密码，或配置启动密码后重试。</Alert> : <form onSubmit={submit}>
            <FieldGroup>
              {error && !error.field && <Alert tone="danger">{error.text}</Alert>}
              <Field label="管理密码" name="password" hint={setup ? '至少 10 个字符' : undefined} error={error?.field === 'password' ? error.text : undefined}>
                <Input ref={passwordInput} type="password" autoComplete={setup ? 'new-password' : 'current-password'}
                  required minLength={setup ? 10 : undefined} value={password} onChange={event => { setPassword(event.target.value); setError(null) }} />
              </Field>
              {setup && <Field label="确认密码" name="password_confirmation" error={error?.field === 'repeat' ? error.text : undefined}>
                <Input ref={repeatInput} type="password" autoComplete="new-password"
                  required value={repeat} onChange={event => { setRepeat(event.target.value); setError(null) }} />
              </Field>}
              <Button variant="primary" type="submit" busy={busy}>{setup ? '创建并登录' : '登录'}</Button>
            </FieldGroup>
          </form>}
        </CardContent>
      </Card>
    </div>
  </main>
}

function Loading({ error, retry, children }: { error?: string; retry: () => void; children: ReactNode }) {
  return <main className="auth-shell">
    <div className="auth-form">
      <Brand />
      {error ? <Alert tone="danger" action={<Button size="small" onClick={retry}>重试</Button>}>{error}</Alert>
        : <div role="status" className="stack tight"><Skeleton className="h-9 w-42" /><p className="muted">{children}</p></div>}
    </div>
  </main>
}

function WorkspaceLayout({ state, view, route, changeProfile, signOut, onHelp, children }: { state: WorkspaceState; view: View; route: Route; changeProfile: ChangeProfile; signOut: () => void; onHelp: () => void; children: ReactNode }) {
  const [, title] = pages.find(([page]) => page === route.page) ?? pages[0]
  const { setOpenMobile, openMobile, isMobile, open } = useSidebar()
  const [profileEditor, setProfileEditor] = useState<{ action: NameAction; id: string } | null>(null)
  const profileTrigger = useRef<HTMLButtonElement>(null)
  const sidebarTrigger = useRef<HTMLButtonElement>(null)
  const publishedCounts = state.current?.counts
  const summary = publishedCounts ?? view.counts
  const navCounts: Record<string, string | null> = {
    sources: formatNumber(state.draft.sources.length),
    nodes: formatNumber(view.counts.nodes) + '/' + formatNumber(view.originalNodes),
    groups: formatNumber(state.draft.groups.length),
    rules: formatNumber(view.counts.rules),
    publish: state.current && versionLabel(state.current),
  }

  useEffect(() => { setOpenMobile(false) }, [route.path, state.id, setOpenMobile])

  return <>
    <a href="#main-content" className="skip-link" onClick={event => {
      event.preventDefault()
      document.querySelector<HTMLElement>('#main-content h1')?.focus()
    }}>跳到正文</a>
    <Sidebar variant="sidebar" collapsible="offcanvas" className="workspace-sidebar">
      <SidebarHeader className="workspace-sidebar-header">
        <RouteLink page="home" className="brand-link" onClick={() => { if (route.page === 'home') setOpenMobile(false) }}>
          <Brand /><span className="sr-only">返回概览</span>
        </RouteLink>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="主导航" className="workspace-navigation">{sections.map(([heading, items]) => <SidebarGroup key={heading ?? 'overview'}>
          {heading && <SidebarGroupLabel>{heading}</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu>{items.map(([key, label, Icon]) => <SidebarMenuItem key={key}>
              <SidebarMenuButton asChild isActive={key === route.page}>
                <RouteLink page={key} aria-current={key === route.page ? 'page' : undefined}
                  onClick={() => { if (route.page === key && !route.id) setOpenMobile(false) }}>
                  <Icon aria-hidden="true" /><span>{label}</span>
                </RouteLink>
              </SidebarMenuButton>
              {navCounts[key] && <SidebarMenuBadge className="nav-count" aria-hidden="true">{navCounts[key]}</SidebarMenuBadge>}
              {key === 'updates' && state.unread && <SidebarMenuBadge><span className="nav-indicator" role="img" aria-label="有新记录" /></SidebarMenuBadge>}
            </SidebarMenuItem>)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>)}</nav>
      </SidebarContent>
      <Separator />
      <SidebarFooter className="workspace-sidebar-footer">
        <ProfileSelector triggerRef={profileTrigger} onChange={changeProfile} onEdit={action => {
          setProfileEditor({ action, id: state.id })
          setOpenMobile(false)
        }}>
          <IconButton size="icon-sm" icon={CircleHelp} label="键盘快捷键" onClick={() => { setOpenMobile(false); onHelp() }} />
          <IconButton size="icon-sm" icon={LogOut} label="退出登录" onClick={signOut} />
        </ProfileSelector>
      </SidebarFooter>
    </Sidebar>
    <div className="workspace-shell">
      <header className="workspace-bar">
        <div className="bar-leading">
          <SidebarTrigger ref={sidebarTrigger} aria-label={isMobile ? '打开导航' : open ? '收起导航' : '展开导航'} aria-expanded={isMobile ? openMobile : open} />
          <Separator orientation="vertical" />
          <Breadcrumb aria-label="当前位置">
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbPage role={undefined} aria-disabled={undefined}>{title}</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <span className="bar-summary" title={publishedCounts ? '订阅版本的配置数量' : '工作台的配置数量'}>
            {state.current && <><span className="status-dot" data-live="true" aria-hidden="true" /><b>{versionLabel(state.current)}</b></>}
            <span>{formatNumber(summary.nodes)} 节点 · {formatNumber(summary.groups)} 组 · {formatNumber(summary.rules)} 规则</span>
          </span>
        </div>
        <div className="bar-actions">
          <ButtonLink page="safety" icon={Link2} size="small">订阅链接</ButtonLink>
          <ButtonLink page="publish" icon={Send} size="small">发布检查</ButtonLink>
        </div>
      </header>
      <main id="main-content" className="workspace-main" tabIndex={-1}>{children}</main>
    </div>
    {profileEditor?.id === state.id && <ProfileNameDialog action={profileEditor.action} onChange={changeProfile}
      returnFocusRef={isMobile ? sidebarTrigger : profileTrigger} onClose={() => setProfileEditor(null)} />}
  </>
}

const emptyLatest: LatestQualityMap = {}
const emptyDevices: ProbeDevice[] = []

function useLatestQuality(state: WorkspaceState | null, call: Call): ProjectQuality {
  const profileId = state?.id
  const [data, setData] = useState<{ profileId: string; latest: LatestQualityMap; devices: ProbeDevice[]; latestJson: string; devicesJson: string }>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!profileId) {
      setData(undefined)
      return
    }
    const id = profileId
    let alive = true, timer: ReturnType<typeof setTimeout>
    setError('')
    async function poll() {
      try {
        const [latest, devices] = await Promise.all([call('quality/latest'), call('quality/devices')])
        if (!alive) return
        const latestJson = JSON.stringify(latest)
        const devicesJson = JSON.stringify(devices)
        setData(prev => {
          if (prev && prev.profileId === id && prev.latestJson === latestJson && prev.devicesJson === devicesJson) {
            return prev
          }
          return {
            profileId: id,
            latest: prev?.profileId === id && prev.latestJson === latestJson ? prev.latest : latest,
            devices: prev?.profileId === id && prev.devicesJson === devicesJson ? prev.devices : devices,
            latestJson,
            devicesJson,
          }
        })
        setError('')
      } catch (e) { if (alive) setError(asError(e).message) }
      if (alive) timer = setTimeout(poll, 8000)
    }
    void poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [call, profileId, attempt])
  const scoped = profileId && data?.profileId === profileId ? data : null
  const latest = scoped ? scoped.latest : emptyLatest
  const devices = scoped ? scoped.devices : emptyDevices
  const deviceNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const d of devices) map.set(d.id, d.remark || d.name)
    for (const deviceId of Object.keys(latest)) {
      if (!map.has(deviceId)) map.set(deviceId, '历史探针')
    }
    return map
  }, [devices, latest])
  const snapshotFor = useCallback((deviceId?: string | null) => {
    if (!deviceId || !Object.hasOwn(latest, deviceId)) return null
    const snapshot = latestQualitySnapshot(latest[deviceId], deviceId)
    return { ...snapshot, targetDeviceName: deviceNames.get(deviceId) ?? null }
  }, [latest, deviceNames])
  const hasData = useMemo(() => Object.values(latest).some(rows => Object.keys(rows).length > 0), [latest])
  const refresh = useCallback(() => setAttempt(n => n + 1), [])
  return useMemo(() => ({
    latest, devices, deviceNames, hasData,
    ready: Boolean(scoped) && !error,
    error,
    refresh,
    snapshotFor,
  }), [latest, devices, deviceNames, hasData, scoped, error, refresh, snapshotFor])
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionError, setSessionError] = useState('')
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [route, setRoute] = useState(routeFromHash)
  const [help, setHelp] = useState(false)
  const profile = useRef(localStorage.getItem('submeld.profile') || '')
  const requestOrder = useRef(0)
  const switchOrder = useRef(0)
  const switchInFlight = useRef(0)
  const navigationGuard = useRef<NavigationGuard | null>(null)
  const previousHash = useRef(location.hash)
  const permittedHash = useRef<string | null>(null)
  const latestState = useRef<WorkspaceState | null>(null)
  const loadingRequest = useRef<number | null>(null)

  const notifier = useMemo(() => createFeedbackNotifier({
    dismiss: () => toast.dismiss(),
    show: (message, tone, duration) => {
      const show = { danger: toast.error, warning: toast.warning, info: toast.info, success: toast.success }[tone] ?? toast
      return show(message, { duration })
    },
  }), [])
  useEffect(() => {
    notifier.activate()
    return () => notifier.dispose()
  }, [notifier])
  const notify = notifier.notify

  const setNavigationGuard = useCallback((handler: NavigationGuard | null) => {
    navigationGuard.current = handler
    return () => { if (navigationGuard.current === handler) navigationGuard.current = null }
  }, [])

  const pathFor = useCallback((path: string, id = profile.current) => '/api/' + path + (id ? (path.includes('?') ? '&' : '?') + 'profile=' + encodeURIComponent(id) : ''), [])

  const applyState = useCallback((next: WorkspaceState, options?: { allowProfileSwitch?: boolean }) => {
    if (!next?.draft) return false
    const allowSwitch = options?.allowProfileSwitch === true
    if (!allowSwitch && (switchInFlight.current > 0 || (profile.current && next.id !== profile.current))) {
      return false
    }
    requestOrder.current++
    if (latestState.current?.statusVersion === next.statusVersion && latestState.current?.id === next.id) return true
    latestState.current = next
    if (profile.current !== next.id) localStorage.setItem('submeld.profile', next.id)
    profile.current = next.id
    setState(next)
    return true
  }, [])

  const clearState = useCallback(() => {
    requestOrder.current++
    latestState.current = null
    setState(null)
  }, [])

  const call: Call = useCallback(async <P extends Endpoint, const B extends Payload<P>>(path: P, body?: B) => {
    try { return await api<ResponseFor<P, B>>(pathFor(path), body) }
    catch (cause) {
      const error = asError(cause)
      if (error.status === 401 && path !== 'password') {
        clearState()
        setSession({ authenticated: false, configured: true })
      }
      throw error
    }
  }, [pathFor, clearState])

  const reload = useCallback(async (id = profile.current, background = false, allowProfileSwitch = false) => {
    if (!allowProfileSwitch && (switchInFlight.current > 0 || (profile.current && id !== profile.current))) return
    if (background && loadingRequest.current !== null) return
    const order = ++requestOrder.current
    loadingRequest.current = order
    const previous = latestState.current
    const get = <P extends 'state' | 'status' | 'state?nodes=0' | `source-nodes?id=${string}`>(path: P) => api<ResponseFor<P>>(pathFor(path, id))
    try {
      const next = previous && previous.id === id ? await refreshWorkspace(previous, get) : await get('state')
      if (order === requestOrder.current && next !== previous) applyState(next, { allowProfileSwitch })
    } catch (cause) {
      const error = asError(cause)
      if (order !== requestOrder.current) return
      if (error.status === 401) {
        clearState()
        setSession({ authenticated: false, configured: true })
      } else if (id && error.status === 404) {
        if (!background && (allowProfileSwitch || (switchInFlight.current === 0 && (!latestState.current || id === profile.current)))) {
          const next = await api<WorkspaceState>('/api/state')
          if (order === requestOrder.current && (allowProfileSwitch || switchInFlight.current === 0)) {
            applyState(next, { allowProfileSwitch: true })
          }
        }
      } else throw error
    } finally {
      if (loadingRequest.current === order) loadingRequest.current = null
    }
  }, [applyState, pathFor, clearState])

  const loadSession = useCallback(() => {
    setSessionError('')
    api<Session>('/api/session').then(setSession).catch(error => setSessionError(error.message))
  }, [])
  useEffect(loadSession, [loadSession])

  const running = Boolean(state && [...Object.values(state.sources), ...Object.values(state.providers), ...state.publishedOnly].some(record => record.status === 'running' || record.status === 'queued'))
  useEffect(() => {
    if (!session?.authenticated) return
    if (!latestState.current) reload().catch(error => setSessionError(error.message))
    const timer = setInterval(() => reload(profile.current, true).catch(() => {}), running ? 900 : 4500)
    return () => clearInterval(timer)
  }, [session?.authenticated, running, reload])

  const hrefFor = useCallback((...[page, id, detail]: Destination) => {
    const current = routeFromHash()
    const query = page === current.page ? current.params.toString() : ''
    return '#/' + [page, id, detail].filter((part): part is string => Boolean(part)).map(encodeURIComponent).join('/') + (query ? '?' + query : '')
  }, [])

  const replaceSearch = useCallback((name: string, value: string) => {
    const current = routeFromHash()
    if (value) current.params.set(name, value)
    else current.params.delete(name)
    const query = current.params.toString()
    const hash = '#/' + (current.path || current.page) + (query ? '?' + query : '')
    if (hash === location.hash) return
    history.replaceState(history.state, '', hash)
    previousHash.current = hash
    setRoute(routeFromHash(hash))
  }, [])

  const navigate = useCallback(async (...[page, id, detail]: Destination) => {
    const hash = hrefFor(page, id, detail)
    if (hash === location.hash) return true
    if (navigationGuard.current && !await navigationGuard.current()) return false
    permittedHash.current = hash
    location.hash = hash
    return true
  }, [hrefFor])

  useEffect(() => {
    const changed = async () => {
      const nextHash = location.hash
      if (permittedHash.current !== nextHash && navigationGuard.current) {
        history.replaceState(history.state, '', previousHash.current || '#/home')
        if (!await navigationGuard.current()) return
        history.replaceState(history.state, '', nextHash || '#/home')
      }
      const next = routeFromHash()
      const pageChanged = next.page !== routeFromHash(previousHash.current).page
      permittedHash.current = null
      previousHash.current = location.hash
      setRoute(next)
      if (pageChanged) {
        window.scrollTo(0, 0)
        requestAnimationFrame(() => document.querySelector<HTMLElement>('#main-content h1')?.focus({ preventScroll: true }))
      }
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])

  useEffect(() => {
    if (!state) return
    function shortcut(event: KeyboardEvent) {
      const target = event.target
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]') ||
        (target instanceof HTMLElement && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable))) return
      if (event.altKey && /^[0-9]$/.test(event.key)) {
        const index = event.key === '0' ? 9 : Number(event.key) - 1
        if (pages[index]) {
          event.preventDefault()
          void navigate(pages[index][0])
        }
      }
      if (event.key === '?') setHelp(true)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [Boolean(state), navigate])

  const save = useCallback(async (draft: Draft, revision = state!.revision, message?: string, localInputs?: Record<string, LocalInput>) => {
    const targetProfile = profile.current
    try {
      const next = await call('draft', { revision, draft, localInputs })
      if (!applyState(next)) return next
      if (message) notify(message)
      return next
    } catch (cause) {
      const error = asError(cause)
      if (error.status === 409) await reload(targetProfile).catch(() => {})
      throw error
    }
  }, [state?.revision, call, applyState, notify, reload])

  async function changeProfile(action: ProfileAction, value?: string) {
    const changesWorkspace = action !== 'rename'
    if (changesWorkspace && navigationGuard.current && !await navigationGuard.current()) return false
    if (action === 'switch') {
      const mySwitch = ++switchOrder.current
      switchInFlight.current++
      try {
        await reload(value, false, true)
      } finally {
        switchInFlight.current--
      }
      if (mySwitch !== switchOrder.current || !latestState.current || (value && latestState.current.id !== value)) return false
      notify('已切换至「' + latestState.current.title + '」')
    } else {
      const mySwitch = ++switchOrder.current
      if (changesWorkspace) switchInFlight.current++
      try {
        const next = await call('profiles', { action, title: value })
        if (mySwitch !== switchOrder.current) return false
        applyState(next, { allowProfileSwitch: changesWorkspace })
      } finally {
        if (changesWorkspace) switchInFlight.current--
      }
    }
    if (changesWorkspace) {
      navigationGuard.current = null
      await navigate('home')
    }
    return true
  }

  async function signOut() {
    if (navigationGuard.current && !await navigationGuard.current()) return
    try {
      setSession(await api<Session>('/api/logout', {}))
      clearState()
    } catch (cause) { const error = asError(cause); notify(error.message, 'danger') }
  }

  const datasetVersions = state && JSON.stringify([
    Object.values(state.sources).map(record => record.nodesVersion),
    Object.values(state.providers).map(record => record.good),
  ])
  const quality = useLatestQuality(state, call)
  const hasQualityPools = Boolean(state?.draft.groups.some(g => g.enabled && g.members.some(m => m.kind === 'pool' && hasQualityConditions(m.quality))))
  const qualityConsumingRoute = route.page === 'nodes' || route.page === 'groups' || (route.page === 'publish' && hasQualityPools)
  const prevRoutePage = useRef(route.page)
  useEffect(() => {
    const changed = prevRoutePage.current !== route.page
    prevRoutePage.current = route.page
    if (changed && state && qualityConsumingRoute) quality.refresh()
  }, [route.page, Boolean(state), qualityConsumingRoute, quality.refresh])
  const usesQuality = Boolean(state?.draft.groups.some(g => g.qualityDeviceId && g.members.some(m => m.kind === 'pool' && hasQualityConditions(m.quality))))
  const viewQuality = usesQuality ? quality.latest : null
  const view = useMemo(() => state ? projection(state.draft, state, viewQuality) : null, [state?.draft, datasetVersions, viewQuality])
  if (!session) return <Loading error={sessionError} retry={loadSession}>正在连接服务端…</Loading>
  if (!session.authenticated) return <SignIn session={session} onDone={next => { setSessionError(''); setSession(next) }} />
  if (!state || !view) return <Loading error={sessionError} retry={() => {
    setSessionError('')
    reload().catch(error => setSessionError(error.message))
  }}>正在读取配置…</Loading>
  const [, , , Page] = pages.find(([page]) => page === route.page) ?? pages[0]
  const jump = ({ pane, id, relatedId }: Pick<Issue, 'pane' | 'id' | 'relatedId'>) => navigate(pane, id, relatedId)
  const context = { state, view, quality, route, running, call, pathFor, hrefFor, replaceSearch, save, reload, applyState, notify, navigate, jump, setNavigationGuard }

  return <ProjectContext.Provider value={context}>
    <SidebarProvider className="workspace-layout" style={{ '--sidebar-width': 'clamp(14rem, 13.4vw, 20rem)' }}>
      <WorkspaceLayout state={state} view={view} route={route} changeProfile={changeProfile} signOut={signOut} onHelp={() => setHelp(true)}>
        <Page key={state.id + '/' + route.page} />
      </WorkspaceLayout>
    </SidebarProvider>
    {help && <Modal title="键盘快捷键" onClose={() => setHelp(false)}>
      <dl className="shortcut-list">
        {pages.slice(0, 10).map(([, name], i) => <div className="key-row" key={name}><dt>{name}</dt><dd><kbd>Alt + {i < 9 ? i + 1 : 0}</kbd></dd></div>)}
      </dl>
    </Modal>}
  </ProjectContext.Provider>
}

createRoot(document.getElementById('root')!).render(
  <TooltipProvider><ConfirmProvider><App /><Toaster closeButton visibleToasts={1} /></ConfirmProvider></TooltipProvider>,
)
