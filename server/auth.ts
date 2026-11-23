import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Store } from './store.ts'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { UserError } from './schema.ts'

const lifetime = 12 * 60 * 60 * 1000
const cookieName = 'submeld_session'
const matchedHeader = new RegExp('(?:^|;\\s*)' + cookieName + '=([A-Za-z0-9_-]{43})(?:;|$)')

function passwordValid(value: unknown) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 256) {
    throw new UserError('管理密码须为 10–256 个字符。')
  }
  return value
}

function hashPassword(value: unknown) {
  const salt = randomBytes(24)
  return { salt: salt.toString('hex'), hash: scryptSync(passwordValid(value), salt, 64).toString('hex') }
}

export function createAuth(store: Store, { password, secure }: { password?: string; secure?: boolean }) {
  const sessions = new Map<string, number>()
  const attempts = new Map<string, { count: number; until: number }>()
  let account = store.get('auth', 'admin')
  if (!account && password) {
    account = hashPassword(password)
    store.set('auth', 'admin', account)
  }

  const tokenFor = (request: IncomingMessage) => request.headers.cookie?.match(matchedHeader)?.[1]
  const local = (request: IncomingMessage) => ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
  const cookie = (token: string, age: number) => cookieName + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + age + (secure ? '; Secure' : '')
  const matches = (value: unknown) => {
    if (!account || typeof value !== 'string' || value.length < 10 || value.length > 256) return false
    const computed = scryptSync(value, Buffer.from(account.salt, 'hex'), 64)
    return timingSafeEqual(computed, Buffer.from(account.hash, 'hex'))
  }

  function issue(response: ServerResponse) {
    const token = randomBytes(32).toString('base64url')
    for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key)
    while (sessions.size >= 128) sessions.delete(sessions.keys().next().value!)
    sessions.set(token, Date.now() + lifetime)
    response.setHeader('Set-Cookie', cookie(token, lifetime / 1000))
    return token
  }

  function check(request: IncomingMessage) {
    const token = tokenFor(request)
    return token && (sessions.get(token) ?? 0) > Date.now() ? token : null
  }

  function setupAvailable(request: IncomingMessage) {
    try {
      const host = new URL('http://' + request.headers.host).hostname
      return !account && local(request) && ['127.0.0.1', 'localhost', '[::1]'].includes(host)
    } catch {
      return false
    }
  }

  return {
    check,
    status(request: IncomingMessage) { return { authenticated: Boolean(check(request)), configured: Boolean(account), setup: setupAvailable(request) } },
    setup(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) {
      if (!setupAvailable(request)) throw new UserError('请从服务端本机初始化管理账号，或配置 SUBMELD_ADMIN_PASSWORD。', 403)
      account = hashPassword(body.password)
      store.set('auth', 'admin', account)
      issue(response)
      return { authenticated: true, configured: true }
    },
    login(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) {
      const now = Date.now()
      const ip = request.socket.remoteAddress ?? ''
      for (const [key, value] of attempts) if (value.until < now) attempts.delete(key)
      const record = attempts.get(ip) ?? { count: 0, until: now + 60000 }
      if (record.count >= 8 || attempts.size > 4096) throw new UserError('尝试过于频繁，请稍后重试。', 429)
      if (!matches(body.password)) {
        record.count++
        attempts.set(ip, record)
        throw new UserError('管理密码不正确。', 401)
      }
      attempts.delete(ip)
      issue(response)
      return { authenticated: true, configured: true }
    },
    logout(request: IncomingMessage, response: ServerResponse) {
      sessions.delete(tokenFor(request) ?? '')
      response.setHeader('Set-Cookie', cookie('', 0))
      return { authenticated: false, configured: Boolean(account) }
    },
    change(response: ServerResponse, body: Record<string, unknown>) {
      if (!matches(body.current)) throw new UserError('当前管理密码不正确。')
      account = hashPassword(body.password)
      store.set('auth', 'admin', account)
      sessions.clear()
      issue(response)
      return { ok: true }
    },
  }
}
