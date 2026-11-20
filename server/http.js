import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { openStore } from './store.js'
import { createAuth } from './auth.js'
import { createWorkspace } from './workspace.js'
import { createVerifier } from './core.js'
import { exportBackup, restoreBackup } from './backup.js'
import { UserError } from './schema.js'

const adminBodyMax = 8 * 1024 * 1024
const backupBodyMax = 180 * 1024 * 1024
const contentPolicy = "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
const clientFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/app.js', ['assets/app.js', 'text/javascript; charset=utf-8']],
  ['/assets/app.css', ['assets/app.css', 'text/css; charset=utf-8']],
])

function send(response, status, contentType, body) {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
  response.end(body)
}

function json(response, status, value) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

async function readBody(request, origin, limit) {
  if ((request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new UserError('请求来源与当前管理页面不一致。', 403)
  }
  if (request.headers['content-type']?.split(';', 1)[0].trim() !== 'application/json') {
    throw new UserError('此操作需要 JSON 数据。', 415)
  }
  if (Number(request.headers['content-length']) > limit) throw new UserError('上传文件或请求过大。', 413)
  let length = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length
    if (length > limit) {
      request.resume()
      throw new UserError('上传文件或请求过大。', 413)
    }
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error()
    return body
  } catch {
    throw new UserError('无法读取请求数据。')
  }
}

function yaml(response, content, inline) {
  response.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="SubMeld.yaml"')
  send(response, 200, 'text/yaml; charset=utf-8', content)
}

export function createApplication(options = {}) {
  const directory = resolve(options.directory ?? 'data')
  const store = openStore(directory)
  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : null
  if (publicUrl && (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash)) {
    throw new Error('SUBMELD_PUBLIC_URL must be an HTTP(S) origin without a path.')
  }
  const secure = options.secure ?? publicUrl?.protocol === 'https:'
  const verify = options.verify ?? createVerifier({ binary: options.binary, directory })
  const auth = createAuth(store, { password: options.password, secure })
  const workspace = createWorkspace({ store, verify, remote: { allowPrivate: options.allowPrivate, timeout: options.remoteTimeout }, tickMs: options.tickMs, loadRuleSetList: options.loadRuleSetList })
  const staticPath = resolve(options.staticPath ?? 'dist')
  const files = new Map()

  const server = createServer({ requestTimeout: 120000, headersTimeout: 20000 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', contentPolicy)
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000')
    try {
      const host = request.headers.host ?? ''
      const origin = new URL((secure ? 'https://' : 'http://') + host).origin
      const address = new URL(request.url, origin)
      if (address.origin !== origin) throw new UserError('请求地址无效。', 400)
      const path = address.pathname
      const method = request.method
      const head = method === 'HEAD'
      if ((method === 'GET' || head) && path.startsWith('/sub/')) {
        const content = workspace.subscription(path.slice(5))
        if (!content) return send(response, 404, 'text/plain; charset=utf-8', '此订阅链接不可用。请向管理员获取有效链接。')
        return yaml(response, head ? undefined : content, true)
      }
      if ((method === 'GET' || head) && clientFiles.has(path)) {
        const [filename, type] = clientFiles.get(path)
        let data = files.get(path)
        if (!data) {
          try {
            data = await readFile(join(staticPath, filename))
            files.set(path, data)
          } catch {
            if (path !== '/') throw new UserError('找不到资源。', 404)
            return send(response, 503, 'text/plain; charset=utf-8', '管理界面尚未构建，请在部署时运行 npm run build。')
          }
        }
          if (path === '/') {
            const nonce = randomBytes(18).toString('base64')
            response.setHeader('Content-Security-Policy', contentPolicy + "; style-src 'self' 'nonce-" + nonce + "'")
            const html = data.toString('utf8').replace('SUBMELD_STYLE_NONCE', nonce)
            return send(response, 200, type, head ? undefined : html)
          }
          return send(response, 200, type, head ? undefined : data)
      }
      if (!path.startsWith('/api/')) throw new UserError('找不到此页面。', 404)
      if (method === 'GET' && path === '/api/session') return json(response, 200, auth.status(request))
      const open = ['/api/setup', '/api/login'].includes(path) && method === 'POST'
      const owner = auth.check(request)
      if (!open && !owner) throw new UserError('请先登录管理页面。', 401)
      if (method !== 'GET' && method !== 'POST') throw new UserError('不支持此请求方法。', 405)
      const profile = address.searchParams.get('profile')
      const page = Math.min(1000000, Math.max(0, Math.trunc(Number(address.searchParams.get('offset')) || 0)))
      const body = method === 'POST' ? await readBody(request, origin, path === '/api/backup/import' ? backupBodyMax : adminBodyMax) : null
      const route = method + ' ' + path
      const link = async action => {
        const { token, ...status } = await workspace.link(profile, action)
        return { url: token ? (publicUrl?.origin ?? origin) + '/sub/' + token : null, ...status }
      }
      let result
      switch (route) {
        case 'POST /api/setup': result = auth.setup(request, response, body); break
        case 'POST /api/login': result = auth.login(request, response, body); break
        case 'POST /api/logout': result = auth.logout(request, response); break
        case 'POST /api/password': result = auth.change(response, body); break
        case 'GET /api/state': result = workspace.state(profile, address.searchParams.get('nodes') !== '0'); break
        case 'GET /api/status': result = workspace.status(profile); break
        case 'GET /api/source-nodes': result = workspace.sourceNodes(profile, address.searchParams.get('id')); break
        case 'POST /api/draft': result = await workspace.saveDraft(profile, owner, body); break
        case 'POST /api/probe': result = await workspace.probe(profile, owner, body); break
        case 'POST /api/refresh': result = await workspace.refresh(profile, body); break
        case 'POST /api/renewal-reminders': result = await workspace.claimRenewalReminders(profile, body); break
        case 'POST /api/candidate': result = await workspace.candidate(profile, body.id, body.accept === true); break
        case 'POST /api/match': result = await workspace.match(profile, owner, body); break
        case 'GET /api/provider-content': result = workspace.providerContent(profile, address.searchParams.get('id'), page, (address.searchParams.get('q') ?? '').slice(0, 500)); break
        case 'POST /api/check': result = await workspace.check(profile); break
        case 'POST /api/publish': result = await workspace.publish(profile, body.revision); break
        case 'POST /api/rollback': result = await workspace.rollback(profile, body.seq); break
        case 'GET /api/current': result = workspace.current(profile); break
        case 'GET /api/history': result = workspace.history(profile, page); break
        case 'GET /api/updates': result = workspace.logs(profile, page); break
        case 'POST /api/updates/read': result = await workspace.readLogs(profile); break
        case 'GET /api/link': result = await link(); break
        case 'POST /api/link':
          if (!['rotate', 'revoke'].includes(body.action)) throw new UserError('无效的链接操作。')
          result = await link(body.action)
          break
        case 'POST /api/note': result = await workspace.note(profile, body); break
        case 'POST /api/library': result = await workspace.library(profile, body); break
        case 'POST /api/profiles': result = await workspace.profiles(profile, body); break
        case 'GET /api/sources/export': result = workspace.sourceExport(profile); break
        case 'POST /api/sources/import': result = await workspace.sourceImport(profile, owner, body); break
        case 'POST /api/backup/export': result = exportBackup(store, body.passphrase); break
        case 'POST /api/backup/import': result = await restoreBackup(workspace, body.backup, body.passphrase, verify); break
        case 'GET /api/download': {
          const version = workspace.activeVersion(workspace.profileFor(profile))
          if (!version) throw new UserError('请先发布配置，再下载。', 404)
          return yaml(response, version.yaml, false)
        }
        default: throw new UserError('找不到此操作。', 404)
      }
      json(response, 200, result)
    } catch (error) {
      if (response.headersSent || response.destroyed) return
      if (error instanceof UserError) json(response, error.status, { message: error.message, detail: error.detail })
      else {
        console.error('SubMeld: an internal request failed.')
        json(response, 500, { message: '服务端处理失败，请稍后重试。' })
      }
    }
  })
  return {
    server, workspace,
    async close() {
      if (server.listening) await new Promise(resolve => server.close(resolve))
      await workspace.stop()
      store.close()
    },
  }
}
