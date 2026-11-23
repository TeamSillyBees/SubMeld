import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { QualityNode } from '../shared/quality.ts'
import { entryHosts } from './preflight.ts'

const exec = promisify(execFile)
const protocols = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'http', 'socks5', 'wireguard', 'snell', 'anytls', 'ssh'])
export interface Outlet { port: number; password: string }
export interface RoutedNode { node: QualityNode; outlet: Outlet }
const host = '127.0.0.1'
function allowed(node: QualityNode) {
  const c = node.connection
  if (!protocols.has(String(c.type)) || typeof c.server !== 'string' || !Number.isInteger(c.port) || c['dialer-proxy']) return false
  // Never let a subscription select credentials or certificate files from this PC.
  for (const field of ['ca', 'certificate', 'private-key']) {
    if (c[field] && !(field === 'private-key' && c.type === 'wireguard') && !String(c[field]).startsWith('-----BEGIN ')) return false
  }
  return !['interface-name', 'routing-mark', 'private-key-path', 'certificate-path'].some(field => c[field] !== undefined)
}
async function reserve(held: Server[]) {
  const server = createServer()
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, host, resolve))
  held.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法分配探针端口。')
  return address.port
}
const release = (held: Server[]) => Promise.all(held.splice(0).map(server => new Promise<void>(done => server.close(() => done()))))

type Measure<T> = (routes: RoutedNode[], invalid: QualityNode[], signal: AbortSignal) => Promise<T>
class ListenerBindError extends Error {}

export async function withCore<T>(binary: string, nodes: QualityNode[], signal: AbortSignal, measure: Measure<T>): Promise<T> {
  // Keep each process below common Linux open-file limits, with shared measurement phases across all groups.
  const groupSize = 240
  const next: Measure<T> = nodes.length <= groupSize ? measure : (routes, invalid, active) =>
    withCore(binary, nodes.slice(groupSize), active, (rest, rejected, combined) => measure([...routes, ...rest], [...invalid, ...rejected], combined))
  for (let attempt = 0; ; attempt++) {
    let ready = false
    try {
      return await withGroup(binary, nodes.slice(0, groupSize), signal, (routes, invalid, active) => {
        ready = true
        return next(routes, invalid, active)
      })
    } catch (error) {
      if (ready || !(error instanceof ListenerBindError) || attempt >= 2) throw error
      signal.throwIfAborted()
    }
  }
}

async function withGroup<T>(binary: string, nodes: QualityNode[], signal: AbortSignal, measure: Measure<T>): Promise<T> {
  signal.throwIfAborted()
  const home = await mkdtemp(join(tmpdir(), 'submeld-probe-'))
  const file = join(home, 'probe.json')
  const held: Server[] = []
  const local = new AbortController()
  const active = AbortSignal.any([signal, local.signal])
  const password = randomBytes(24).toString('hex')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
  for (const key of Object.keys(env)) if (/^(?:https?_proxy|all_proxy|clash_home_dir|safe_paths|skip_safe_path_check)$/i.test(key)) delete env[key]
  const base = { 'allow-lan': false, 'bind-address': host, 'mixed-port': 0, 'external-controller': '', 'log-level': 'info', mode: 'rule',
    ...(process.env.SUBMELD_PROBE_INTERFACE ? { 'interface-name': process.env.SUBMELD_PROBE_INTERFACE } : {}),
    tun: { enable: false }, dns: { enable: false }, profile: { 'store-selected': false }, rules: ['MATCH,REJECT'] }
  const proxy = (node: QualityNode) => ({ ...node.connection, name: 'out-' + Buffer.from(node.key).toString('base64url') })
  const invalid: QualityNode[] = []
  // A single malformed proxy must not discard the rest of a subscription.
  async function validate(batch: QualityNode[]): Promise<QualityNode[]> {
    if (!batch.length) return []
    active.throwIfAborted()
    await writeFile(file, JSON.stringify({ ...base, proxies: batch.map(proxy) }), { mode: 0o600 })
    try { await exec(binary, ['-t', '-d', home, '-f', file], { env, signal: active, timeout: 20_000, windowsHide: true }); return batch }
    catch (error) {
      active.throwIfAborted()
      if (typeof (error as NodeJS.ErrnoException).code !== 'number') throw new Error('Mihomo 核心无法执行，请检查安装。')
      if (batch.length === 1) { invalid.push(batch[0]); return [] }
      const half = Math.ceil(batch.length / 2)
      return [...await validate(batch.slice(0, half)), ...await validate(batch.slice(half))]
    }
  }
  try {
    const candidates = nodes.filter(node => { if (allowed(node)) return true; invalid.push(node); return false })
    const usable = await validate(candidates)
    const routes: RoutedNode[] = []
    for (const node of usable) routes.push({ node, outlet: { port: await reserve(held), password } })
    if (!routes.length) return await measure([], invalid, active)
    const listeners = routes.map(({ node, outlet }, i) => ({
      name: 'probe-' + i, type: 'http', listen: host, port: outlet.port, proxy: proxy(node).name,
      users: [{ username: 'probe', password }],
    }))
    const hosts = await entryHosts(usable, active)
    await writeFile(file, JSON.stringify({ ...base, hosts, proxies: usable.map(proxy), listeners }), { mode: 0o600 })
    await release(held)
    active.throwIfAborted()
    const child = spawn(binary, ['-d', home, '-f', file], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stopChild = () => { child.kill('SIGKILL') }
    process.once('exit', stopChild)
    const closed = new Promise<void>(done => child.once('close', () => { local.abort(new Error('Mihomo 进程已退出。')); done() }))
    child.on('error', () => local.abort(new Error('Mihomo 无法启动。')))
    // Verify readiness from this child's own bind events. Never trust another process occupying a released port.
    const pending = new Set(routes.map(({ outlet }) => outlet.port))
    let partial = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop()!.slice(-4096)
      for (const line of lines) {
        const port = /listening at[^\d]*127\.0\.0\.1:(\d+)/i.exec(line)
        if (port) pending.delete(Number(port[1]))
      }
    })
    child.stderr.resume()
    try {
      const readyBy = Date.now() + 15_000
      while (pending.size) {
        active.throwIfAborted()
        if (Date.now() > readyBy) throw new ListenerBindError('独立监听端口启动失败，请重新运行探针。')
        await delay(25, undefined, { signal: active })
      }
      await rm(file, { force: true })
      return await measure(routes, invalid, active)
    } finally {
      child.kill()
      const force = setTimeout(() => child.kill('SIGKILL'), 1500)
      try { await closed } finally { clearTimeout(force); process.off('exit', stopChild) }
    }
  } finally {
    await release(held)
    await rm(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
}
