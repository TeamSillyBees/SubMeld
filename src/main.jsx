import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { setNonce } from 'get-nonce'
import { Activity, CircleHelp, Filter, GitFork, History, Layers3, Link2, LogOut, Send, Server, Settings2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from '@/components/ui/breadcrumb'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from './confirm.jsx'
import { Dashboard } from './dashboard.jsx'
import { GroupsPage } from './groups.jsx'
import { ProjectContext, projection } from './project.jsx'
import { PublishPage, UpdatesPage } from './release.jsx'
import { RulesPage } from './rules.jsx'
import { SafetyPage, SettingsPage } from './settings.jsx'
import { NodesPage, SourcesPage } from './sources.jsx'
import { refreshWorkspace } from './workspace-sync.js'
import { Alert, api, Button, ButtonLink, Field, FieldGroup, IconButton, Input, Modal, NativeSelect, NativeSelectOption, RouteLink, formatNumber, versionLabel } from './ui.jsx'

// Radix injects the scrollbar compensation for open dialogs.
setNonce(document.querySelector('script[src="/assets/app.js"]')?.nonce)

const pages = [
  ['home', '概览', Activity, Dashboard],
  ['sources', '订阅源', Server, SourcesPage],
  ['nodes', '节点管理', Filter, NodesPage],
  ['groups', '代理组', Layers3, GroupsPage],
  ['rules', '路由规则', GitFork, RulesPage],
  ['settings', '基础设置', Settings2, SettingsPage],
  ['publish', '配置发布', Send, PublishPage],
  ['updates', '更新记录', History, UpdatesPage],
  ['safety', '安全与备份', ShieldCheck, SafetyPage],
]

const sections = [
  ['订阅分发', pages.slice(0, 2)],
  ['聚合与分流', pages.slice(2, 5)],
  ['系统与发布', pages.slice(5)],
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
    <img className="brand-symbol" src="/assets/submeld-logo.svg" alt="" width={32} height={32} />
    <strong className="brand-type">SubMeld</strong>
  </span>
}

function SignIn({ session, onDone }) {
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const passwordInput = useRef(null)
  const repeatInput = useRef(null)
  const setup = session.setup
  const needsSetup = !session.configured && !setup

  async function submit(event) {
    event.preventDefault()
    setError(null)
    if (setup && password !== repeat) {
      setError({ field: 'repeat', text: '请让两次输入的密码一致。' })
      repeatInput.current?.focus()
      return
    }
    setBusy(true)
    try { onDone(await api(setup ? '/api/setup' : '/api/login', { password })) }
    catch (error) {
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

function Loading({ error, retry, children }) {
  return <main className="auth-shell">
    <div className="auth-form">
      <Brand />
      {error ? <Alert tone="danger" action={<Button size="small" onClick={retry}>重试</Button>}>{error}</Alert>
        : <div role="status" className="stack tight"><Skeleton className="h-9 w-42" /><p className="muted">{children}</p></div>}
    </div>
  </main>
}

function WorkspaceLayout({ state, view, route, switchProfile, signOut, onHelp, children }) {
  const [, title] = pages.find(([page]) => page === route.page)
  const { setOpenMobile, openMobile, isMobile, open } = useSidebar()
  const publishedCounts = state.current?.counts
  const summary = publishedCounts ?? view.counts
  const navCounts = {
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
      document.querySelector('#main-content h1')?.focus()
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
        {state.profiles.length > 1 ? <NativeSelect className="profile-select" aria-label="切换配置方案" name="profile" value={state.id}
          onChange={event => { void switchProfile(event.target.value) }}>
          {state.profiles.map(profile => <NativeSelectOption key={profile.id} value={profile.id}>{profile.title}</NativeSelectOption>)}
        </NativeSelect> : <span className="profile-name" title={state.title}>{state.title}</span>}
        <IconButton icon={CircleHelp} label="键盘快捷键" onClick={() => { setOpenMobile(false); onHelp() }} />
        <IconButton icon={LogOut} label="退出登录" onClick={signOut} />
      </SidebarFooter>
    </Sidebar>
    <div className="workspace-shell">
      <header className="workspace-bar">
        <div className="bar-leading">
          <SidebarTrigger aria-label={isMobile ? '打开导航' : open ? '收起导航' : '展开导航'} aria-expanded={isMobile ? openMobile : open} />
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
  </>
}

function App() {
  const [session, setSession] = useState(null)
  const [sessionError, setSessionError] = useState('')
  const [state, setState] = useState(null)
  const [route, setRoute] = useState(routeFromHash)
  const [help, setHelp] = useState(false)
  const profile = useRef(localStorage.getItem('submeld.profile') || '')
  const requestOrder = useRef(0)
  const navigationGuard = useRef(null)
  const previousHash = useRef(location.hash)
  const permittedHash = useRef(null)
  const latestState = useRef(null)
  const loadingRequest = useRef(null)

  const notify = useCallback((message, tone = 'success') => {
    const show = { danger: toast.error, warning: toast.warning, info: toast.info, success: toast.success }[tone] ?? toast
    show(message, { id: 'workspace-feedback', duration: tone === 'danger' ? 6500 : 2800 })
  }, [])

  const setNavigationGuard = useCallback(handler => {
    navigationGuard.current = handler
    return () => { if (navigationGuard.current === handler) navigationGuard.current = null }
  }, [])

  const pathFor = useCallback((path, id = profile.current) => '/api/' + path + (id ? (path.includes('?') ? '&' : '?') + 'profile=' + encodeURIComponent(id) : ''), [])

  const applyState = useCallback(next => {
    requestOrder.current++
    if (!next?.draft) return
    if (latestState.current?.statusVersion === next.statusVersion && latestState.current?.id === next.id) return
    latestState.current = next
    if (profile.current !== next.id) localStorage.setItem('submeld.profile', next.id)
    profile.current = next.id
    setState(next)
  }, [])

  const clearState = useCallback(() => {
    requestOrder.current++
    latestState.current = null
    setState(null)
  }, [])

  const call = useCallback(async (path, body) => {
    try { return await api(pathFor(path), body) }
    catch (error) {
      if (error.status === 401 && path !== 'password') {
        clearState()
        setSession({ authenticated: false, configured: true })
      }
      throw error
    }
  }, [pathFor, clearState])

  const reload = useCallback(async (id = profile.current, background = false) => {
    if (background && loadingRequest.current !== null) return
    const order = ++requestOrder.current
    loadingRequest.current = order
    const previous = latestState.current
    const get = path => api(pathFor(path, id))
    try {
      const next = previous && previous.id === id ? await refreshWorkspace(previous, get) : await get('state')
      if (order === requestOrder.current && next !== previous) applyState(next)
    } catch (error) {
      if (order !== requestOrder.current) return
      if (error.status === 401) {
        clearState()
        setSession({ authenticated: false, configured: true })
      } else if (id && error.status === 404) {
        const next = await api('/api/state')
        if (order === requestOrder.current) applyState(next)
      } else throw error
    } finally {
      if (loadingRequest.current === order) loadingRequest.current = null
    }
  }, [applyState, pathFor, clearState])

  const loadSession = useCallback(() => {
    setSessionError('')
    api('/api/session').then(setSession).catch(error => setSessionError(error.message))
  }, [])
  useEffect(loadSession, [loadSession])

  const running = Boolean(state && [...Object.values(state.sources), ...Object.values(state.providers), ...state.publishedOnly].some(record => record.status === 'running' || record.status === 'queued'))
  useEffect(() => {
    if (!session?.authenticated) return
    if (!latestState.current) reload().catch(error => setSessionError(error.message))
    const timer = setInterval(() => reload(profile.current, true).catch(() => {}), running ? 900 : 4500)
    return () => clearInterval(timer)
  }, [session?.authenticated, running, reload])

  const hrefFor = useCallback((page, id, detail) => {
    const current = routeFromHash()
    const query = page === current.page ? current.params.toString() : ''
    return '#/' + [page, id, detail].filter(Boolean).map(encodeURIComponent).join('/') + (query ? '?' + query : '')
  }, [])

  const replaceSearch = useCallback((name, value) => {
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

  const navigate = useCallback(async (page, id, detail) => {
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
        requestAnimationFrame(() => document.querySelector('#main-content h1')?.focus({ preventScroll: true }))
      }
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])

  useEffect(() => {
    if (!state) return
    function shortcut(event) {
      if (document.querySelector('[role="dialog"],[role="alertdialog"]') || /^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable) return
      if (event.altKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault()
        void navigate(pages[Number(event.key) - 1][0])
      }
      if (event.key === '?') setHelp(true)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [Boolean(state), navigate])

  const save = useCallback(async (draft, revision = state?.revision, message) => {
    try {
      const next = await call('draft', { revision, draft })
      applyState(next)
      if (message) notify(message)
      return next
    } catch (error) {
      if (error.status === 409) await reload().catch(() => {})
      throw error
    }
  }, [state?.revision, call, applyState, notify, reload])

  async function switchProfile(id) {
    if (navigationGuard.current && !await navigationGuard.current()) return
    try {
      await reload(id)
      navigationGuard.current = null
      await navigate('home')
    } catch (error) { notify(error.message, 'danger') }
  }

  async function signOut() {
    if (navigationGuard.current && !await navigationGuard.current()) return
    try {
      setSession(await api('/api/logout', {}))
      clearState()
    } catch (error) { notify(error.message, 'danger') }
  }

  const datasetVersions = state && JSON.stringify([
    Object.values(state.sources).map(record => record.nodesVersion),
    Object.values(state.providers).map(record => record.good),
  ])
  const view = useMemo(() => state ? projection(state.draft, state) : null, [state?.draft, datasetVersions])
  if (!session) return <Loading error={sessionError} retry={loadSession}>正在连接服务端…</Loading>
  if (!session.authenticated) return <SignIn session={session} onDone={next => { setSessionError(''); setSession(next) }} />
  if (!state) return <Loading error={sessionError} retry={() => {
    setSessionError('')
    reload().catch(error => setSessionError(error.message))
  }}>正在读取配置…</Loading>
  const [, , , Page] = pages.find(([page]) => page === route.page)
  const jump = ({ pane, id, relatedId }) => navigate(pane, id, relatedId)
  const context = { state, view, route, running, call, pathFor, hrefFor, replaceSearch, save, reload, applyState, notify, navigate, jump, setNavigationGuard }

  return <ProjectContext.Provider value={context}>
    <SidebarProvider className="workspace-layout" style={{ '--sidebar-width': 'clamp(14rem, 13.4vw, 20rem)' }}>
      <WorkspaceLayout state={state} view={view} route={route} switchProfile={switchProfile} signOut={signOut} onHelp={() => setHelp(true)}>
        <Page key={state.id + '/' + route.page} />
      </WorkspaceLayout>
    </SidebarProvider>
    {help && <Modal title="键盘快捷键" onClose={() => setHelp(false)}>
      <dl className="shortcut-list">
        {pages.map(([, name], i) => <div className="key-row" key={name}><dt>{name}</dt><dd><kbd>Alt + {i + 1}</kbd></dd></div>)}
      </dl>
    </Modal>}
  </ProjectContext.Provider>
}

createRoot(document.getElementById('root')).render(
  <TooltipProvider><ConfirmProvider><App /><Toaster closeButton visibleToasts={1} /></ConfirmProvider></TooltipProvider>,
)
