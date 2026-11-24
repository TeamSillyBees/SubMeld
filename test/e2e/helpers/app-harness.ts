import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Page } from '@playwright/test'
import { binaryName, type Verifier } from '../../../server/core.ts'
import { createApplication } from '../../../server/http.ts'
import type { LoadRuleSetList } from '../../../server/rule-set-preview.ts'

export const DEFAULT_E2E_PASSWORD = 'e2e-fixture-password'

const DEFAULT_RULE_SET_LISTS: Record<string, string> = {
  'geosite/openai': '+.openai.com\n+.chatgpt.com\n',
  'geosite/google': '+.google.com\n+.googleapis.com\n',
  'geosite/google-gemini': '+.gemini.google.com\n+.makersuite.google.com\n',
  'geosite/github': '+.github.com\n+.githubusercontent.com\n',
  'geoip/telegram': '91.108.4.0/22\n149.154.160.0/20\n',
}

export interface LegacySqliteSeeder {
  put(space: string, key: string, value: unknown): void
  putRaw(space: string, key: string, jsonText: string): void
  seedEntries(entries: ReadonlyArray<readonly [space: string, key: string, value: unknown]>): void
}

export interface AppHarnessOptions {
  /** Admin password (>=10 chars). Pass `null` or `''` to leave auth unconfigured for `/api/setup` tests. */
  password?: string | null
  /** Whether to auto-login on startup when `password` is configured (default: `true`). */
  autoLogin?: boolean
  /** Background workspace tick interval in ms (default: `0` to disable background timer). */
  tickMs?: number
  /** Allow private/loopback upstream subscription URLs (default: `true`). */
  allowPrivate?: boolean
  /** Path to built SPA directory (default: `resolve('dist')`). */
  staticPath?: string
  /** Optional explicit Mihomo binary path. */
  binary?: string
  /** Use real Mihomo binary if present (`SUBMELD_MIHOMO_BIN` / `bin/mihomo(.exe)`), else stub `verify: async () => null` (default: `true`). */
  useRealCore?: boolean
  /** Custom rule-set list loader; defaults to offline stub map. */
  loadRuleSetList?: LoadRuleSetList
  /** Optional callback to seed raw SQLite `documents` before `createApplication()` boots. */
  seedLegacy?: (seeder: LegacySqliteSeeder) => void | Promise<void>
}

export interface ApiRequestOptions {
  profile?: string
  cookie?: string | null
  headers?: Record<string, string>
}

export interface ApiPostOptions extends ApiRequestOptions {
  origin?: string
}

export interface ApiResponse<T = unknown> {
  status: number
  ok: boolean
  headers: Headers
  data: T
  text: string
}

export interface SubResponse {
  status: number
  headers: Headers
  text: string
}

export interface AppHarness {
  readonly baseUrl: string
  readonly directory: string
  readonly password: string | null
  readonly cookie: string | null
  readonly app: ReturnType<typeof createApplication>
  login(password?: string): Promise<ApiResponse<unknown> & { cookie: string | null }>
  loginPage(page: Page, password?: string): Promise<void>
  apiGet<T = unknown>(path: string, opts?: ApiRequestOptions): Promise<ApiResponse<T>>
  apiPost<T = unknown>(path: string, body?: unknown, opts?: ApiPostOptions): Promise<ApiResponse<T>>
  subGet(tokenOrUrl: string, method?: 'GET' | 'HEAD'): Promise<SubResponse>
  readDbDoc<T = unknown>(space: string, key: string): T | undefined
  listDbSpace<T = unknown>(space: string): Array<{ key: string; data: T }>
  triggerTick(): Promise<void>
  close(): Promise<void>
}

function normalizeApiUrl(baseUrl: string, path: string, profile?: string): URL {
  const cleaned = path.startsWith('/api/')
    ? path
    : path.startsWith('/')
      ? `/api${path}`
      : `/api/${path}`
  const url = new URL(cleaned, baseUrl)
  if (profile !== undefined) {
    url.searchParams.set('profile', profile)
  }
  return url
}

function parseBodyText<T>(text: string, contentType: string | null): T {
  if (!text) return undefined as T
  if (contentType?.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }
  return text as unknown as T
}

async function seedLegacyDatabase(
  directory: string,
  seedFn: (seeder: LegacySqliteSeeder) => void | Promise<void>,
): Promise<void> {
  const dbPath = join(directory, 'submeld.sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS documents (
        space TEXT NOT NULL,
        key TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (space, key)
      ) WITHOUT ROWID;
    `)
    const stmt = db.prepare(
      'INSERT INTO documents (space, key, data) VALUES (?, ?, ?) ON CONFLICT(space, key) DO UPDATE SET data = excluded.data',
    )
    const seeder: LegacySqliteSeeder = {
      put(space: string, key: string, value: unknown) {
        stmt.run(space, key, JSON.stringify(value))
      },
      putRaw(space: string, key: string, jsonText: string) {
        stmt.run(space, key, jsonText)
      },
      seedEntries(entries: ReadonlyArray<readonly [space: string, key: string, value: unknown]>) {
        for (const [space, key, value] of entries) {
          stmt.run(space, key, JSON.stringify(value))
        }
      },
    }
    await seedFn(seeder)
  } finally {
    db.close()
  }
}

export async function startAppHarness(options: AppHarnessOptions = {}): Promise<AppHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'submeld-e2e-'))
  let app: ReturnType<typeof createApplication> | undefined
  let closed = false

  try {
    if (options.seedLegacy) {
      await seedLegacyDatabase(directory, options.seedLegacy)
    }

    const password = options.password === undefined
      ? DEFAULT_E2E_PASSWORD
      : options.password || null

    const configuredBinary = options.binary ?? process.env.SUBMELD_MIHOMO_BIN
    const defaultBinary = resolve('bin', binaryName)
    const resolvedBinary = configuredBinary || (existsSync(defaultBinary) ? defaultBinary : undefined)
    const verifierOptions: { binary?: string; verify?: Verifier } =
      options.useRealCore !== false && resolvedBinary
        ? { binary: resolvedBinary }
        : { verify: async () => null }

    const loadRuleSetList: LoadRuleSetList = options.loadRuleSetList ?? (async key => DEFAULT_RULE_SET_LISTS[key] ?? '')

    app = createApplication({
      directory,
      staticPath: options.staticPath ?? resolve('dist'),
      allowPrivate: options.allowPrivate ?? true,
      tickMs: options.tickMs ?? 0,
      ...(password ? { password } : {}),
      ...verifierOptions,
      loadRuleSetList,
    })

    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const address = app.server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    let sessionCookie: string | null = null

    async function apiGet<T = unknown>(path: string, opts: ApiRequestOptions = {}): Promise<ApiResponse<T>> {
      const url = normalizeApiUrl(baseUrl, path, opts.profile)
      const headers: Record<string, string> = { ...(opts.headers ?? {}) }
      const effectiveCookie = opts.cookie === undefined ? sessionCookie : opts.cookie
      if (effectiveCookie) {
        headers['Cookie'] = effectiveCookie
      }
      const res = await fetch(url, { method: 'GET', headers })
      const text = await res.text()
      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        data: parseBodyText<T>(text, res.headers.get('content-type')),
        text,
      }
    }

    async function apiPost<T = unknown>(
      path: string,
      body: unknown = {},
      opts: ApiPostOptions = {},
    ): Promise<ApiResponse<T>> {
      const url = normalizeApiUrl(baseUrl, path, opts.profile)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(opts.headers ?? {}),
      }
      const effectiveCookie = opts.cookie === undefined ? sessionCookie : opts.cookie
      if (effectiveCookie) {
        headers['Cookie'] = effectiveCookie
      }
      if (opts.origin !== undefined) {
        headers['Origin'] = opts.origin
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
      })
      const text = await res.text()
      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        data: parseBodyText<T>(text, res.headers.get('content-type')),
        text,
      }
    }

    async function login(pwd = password ?? DEFAULT_E2E_PASSWORD) {
      const res = await apiPost<unknown>('/api/login', { password: pwd }, { cookie: null })
      const setCookie = res.headers.get('set-cookie')
      const parsedCookie = setCookie ? setCookie.split(';', 1)[0] : null
      if (res.ok && parsedCookie) {
        sessionCookie = parsedCookie
      }
      return { ...res, cookie: parsedCookie }
    }

    if (password && options.autoLogin !== false) {
      const loginRes = await login(password)
      if (!loginRes.ok) {
        throw new Error(`AppHarness auto-login failed (${loginRes.status}): ${loginRes.text}`)
      }
    }

    async function loginPage(page: Page, pwd = password ?? DEFAULT_E2E_PASSWORD): Promise<void> {
      const res = await page.request.post(`${baseUrl}/api/login`, { data: { password: pwd } })
      if (!res.ok()) {
        throw new Error(`Playwright login failed (${res.status()}): ${await res.text()}`)
      }
    }

    async function subGet(tokenOrUrl: string, method: 'GET' | 'HEAD' = 'GET'): Promise<SubResponse> {
      const target = tokenOrUrl.startsWith('http://') || tokenOrUrl.startsWith('https://')
        ? new URL(tokenOrUrl)
        : tokenOrUrl.startsWith('/')
          ? new URL(tokenOrUrl, baseUrl)
          : new URL(`/sub/${encodeURIComponent(tokenOrUrl)}`, baseUrl)
      const res = await fetch(target, { method })
      const text = method === 'HEAD' ? '' : await res.text()
      return { status: res.status, headers: res.headers, text }
    }

    function readDbDoc<T = unknown>(space: string, key: string): T | undefined {
      const db = new DatabaseSync(join(directory, 'submeld.sqlite'), { readOnly: true })
      try {
        const row = db.prepare('SELECT data FROM documents WHERE space = ? AND key = ?').get(space, key) as
          | { data: string }
          | undefined
        return row ? (JSON.parse(row.data) as T) : undefined
      } finally {
        db.close()
      }
    }

    function listDbSpace<T = unknown>(space: string): Array<{ key: string; data: T }> {
      const db = new DatabaseSync(join(directory, 'submeld.sqlite'), { readOnly: true })
      try {
        const rows = db.prepare('SELECT key, data FROM documents WHERE space = ? ORDER BY key').all(space) as Array<{
          key: string
          data: string
        }>
        return rows.map(row => ({ key: row.key, data: JSON.parse(row.data) as T }))
      } finally {
        db.close()
      }
    }

    const activeApp = app
    return {
      baseUrl,
      directory,
      password,
      get cookie() {
        return sessionCookie
      },
      app: activeApp,
      login,
      loginPage,
      apiGet,
      apiPost,
      subGet,
      readDbDoc,
      listDbSpace,
      async triggerTick() {
        await Promise.resolve(activeApp.workspace.tick())
      },
      async close() {
        if (closed) return
        closed = true
        activeApp.server.closeIdleConnections?.()
        await activeApp.close()
        activeApp.server.closeAllConnections?.()
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      },
    }
  } catch (err) {
    if (!closed) {
      closed = true
      if (app) {
        app.server.closeIdleConnections?.()
        await app.close().catch(() => {})
        app.server.closeAllConnections?.()
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
    }
    throw err
  }
}
