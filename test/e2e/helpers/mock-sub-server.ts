import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { stringify as stringifyYaml } from 'yaml'

export type SubFormat = 'yaml' | 'base64'
export type SubRegion = 'US' | 'JP' | 'SG' | 'HK' | 'DE' | 'unknown'

export interface MockProxyNode {
  name: string
  type?: 'ss' | 'trojan' | 'vless' | 'vmess' | 'http' | 'socks5'
  server?: string
  port?: number
  cipher?: string
  password?: string
  uuid?: string
  sni?: string
}

export interface MockSubscriptionInfo {
  upload?: number
  download?: number
  total?: number
  expire?: number
}

export interface MockSubFeed {
  format: SubFormat
  nodes: MockProxyNode[]
  subscriptionInfo?: MockSubscriptionInfo | null
  statusCode?: number
  rawBody?: string
  headers?: Record<string, string>
  delayMs?: number
}

export interface RecordedSubRequest {
  timestamp: string
  feedId: string
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  statusCode: number
}

export interface MockSubServer {
  readonly port: number
  readonly origin: string
  urlFor(feedId: string): string
  setFeed(feedId: string, feed: MockSubFeed): void
  updateFeed(feedId: string, updater: (current: MockSubFeed) => MockSubFeed): void
  replaceNodes(feedId: string, nodes: MockProxyNode[]): void
  addNode(feedId: string, node: MockProxyNode): void
  removeNode(feedId: string, name: string): void
  setStatus(feedId: string, statusCode: number, rawBody?: string): void
  getRequests(feedId?: string): RecordedSubRequest[]
  getRequestCount(feedId?: string): number
  resetRequests(feedId?: string): void
  close(): Promise<void>
}

export function defaultRegionNodes(): MockProxyNode[] {
  return [
    { name: '🇺🇸 US-LAX-01', type: 'ss', server: 'us-lax-01.example.net', port: 10001 },
    { name: '🇺🇸 US-NYC-02', type: 'ss', server: 'us-nyc-02.example.net', port: 10002 },
    { name: '🇯🇵 JP-TYO-01', type: 'ss', server: 'jp-tyo-01.example.net', port: 10003 },
    { name: '🇯🇵 JP-OSA-02', type: 'trojan', server: 'jp-osa-02.example.net', port: 10004 },
    { name: '🇸🇬 SG-SIN-01', type: 'ss', server: 'sg-sin-01.example.net', port: 10005 },
    { name: '🇭🇰 HK-HKG-01', type: 'ss', server: 'hk-hkg-01.example.net', port: 10006 },
    { name: '🇩🇪 DE-FRA-01', type: 'vless', server: 'de-fra-01.example.net', port: 10007 },
    { name: '剩余流量：500 GB', type: 'ss', server: 'info-traffic.example.net', port: 10008 },
    { name: '到期时间：2027-01-01', type: 'ss', server: 'info-expire.example.net', port: 10009 },
  ]
}

interface NormalizedProxy {
  name: string
  type: 'ss' | 'trojan' | 'vless' | 'vmess' | 'http' | 'socks5'
  server: string
  port: number
  cipher?: string
  password?: string
  uuid?: string
  sni?: string
}

function normalizeProxy(node: MockProxyNode, index: number): NormalizedProxy {
  const type = node.type ?? 'ss'
  const server = node.server ?? 'node.example.net'
  const port = node.port ?? 10000 + index
  const password = node.password ?? `e2e-fixture-pass-${index}`
  const cipher = node.cipher ?? 'aes-128-gcm'
  const uuid = node.uuid ?? `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`

  if (type === 'ss') {
    return { name: node.name, type, server, port, cipher, password }
  }
  if (type === 'trojan') {
    return { name: node.name, type, server, port, password, sni: node.sni ?? server }
  }
  if (type === 'vless') {
    return { name: node.name, type, server, port, uuid }
  }
  if (type === 'vmess') {
    return { name: node.name, type, server, port, uuid, cipher: node.cipher ?? 'auto' }
  }
  return { name: node.name, type, server, port }
}

function encodeShareUri(proxy: NormalizedProxy): string {
  const label = encodeURIComponent(proxy.name)
  if (proxy.type === 'trojan') {
    const pass = encodeURIComponent(proxy.password ?? 'e2e-pass')
    const sni = encodeURIComponent(proxy.sni ?? proxy.server)
    return `trojan://${pass}@${proxy.server}:${proxy.port}?sni=${sni}#${label}`
  }
  if (proxy.type === 'vless') {
    return `vless://${proxy.uuid}@${proxy.server}:${proxy.port}?security=none&type=tcp#${label}`
  }
  if (proxy.type === 'vmess') {
    const payload = JSON.stringify({
      v: '2',
      ps: proxy.name,
      add: proxy.server,
      port: String(proxy.port),
      id: proxy.uuid,
      aid: '0',
      scy: proxy.cipher ?? 'auto',
      net: 'tcp',
      type: 'none',
      tls: '',
    })
    return `vmess://${Buffer.from(payload, 'utf8').toString('base64')}`
  }
  if (proxy.type === 'http' || proxy.type === 'socks5') {
    throw new Error(
      `MockSubServer: share URI encoding in base64 format is unsupported for proxy type "${proxy.type}" (node "${proxy.name}")`,
    )
  }
  const userInfo = Buffer.from(`${proxy.cipher ?? 'aes-128-gcm'}:${proxy.password ?? 'e2e-pass'}`, 'utf8').toString('base64')
  return `ss://${userInfo}@${proxy.server}:${proxy.port}#${label}`
}

function formatSubscriptionInfo(info: MockSubscriptionInfo): string {
  const keys = ['upload', 'download', 'total', 'expire'] as const
  return keys
    .filter(k => info[k] !== undefined)
    .map(k => `${k}=${Math.trunc(info[k]!)}`)
    .join('; ')
}

function serializeFeed(feed: MockSubFeed): { contentType: string; body: string } {
  if (feed.rawBody !== undefined) {
    return {
      contentType: feed.format === 'yaml' ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8',
      body: feed.rawBody,
    }
  }
  const normalized = feed.nodes.map((n, i) => normalizeProxy(n, i))
  if (feed.format === 'yaml') {
    return {
      contentType: 'text/yaml; charset=utf-8',
      body: stringifyYaml({ proxies: normalized }),
    }
  }
  const lines = normalized.map(encodeShareUri).join('\n')
  return {
    contentType: 'text/plain; charset=utf-8',
    body: Buffer.from(lines, 'utf8').toString('base64'),
  }
}

export async function startMockSubServer(
  initialFeeds: Record<string, MockSubFeed> = {},
): Promise<MockSubServer> {
  const feeds = new Map<string, MockSubFeed>()
  for (const [feedId, feed] of Object.entries(initialFeeds)) {
    feeds.set(feedId, structuredClone(feed))
  }
  const requests: RecordedSubRequest[] = []
  const sockets = new Set<Socket>()

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = reqUrl.pathname
    const method = req.method ?? 'GET'

    if (path.startsWith('/__control/feeds/') && method === 'PUT') {
      const feedId = decodeURIComponent(path.slice('/__control/feeds/'.length))
      const next = (await readJsonBody(req)) as MockSubFeed
      feeds.set(feedId, structuredClone(next))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, feedId }))
      return
    }

    if (path === '/__control/requests') {
      const feedId = reqUrl.searchParams.get('feedId') ?? undefined
      if (method === 'DELETE') {
        resetRequests(feedId)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(getRequests(feedId)))
        return
      }
    }

    const feedId = path.startsWith('/sub/')
      ? decodeURIComponent(path.slice('/sub/'.length))
      : decodeURIComponent(path.replace(/^\/+/, '') || 'default')

    const feed = feeds.get(feedId)
    const statusCode = feed ? (feed.statusCode ?? 200) : 404

    requests.push({
      timestamp: new Date().toISOString(),
      feedId,
      method,
      url: req.url ?? '/',
      headers: { ...req.headers },
      statusCode,
    })

    if (!feed) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Mock feed not found: ${feedId}`)
      return
    }

    if (feed.delayMs && feed.delayMs > 0) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, feed.delayMs))
      if (res.destroyed) return
    }

    const serialized = serializeFeed(feed)
    const outHeaders: Record<string, string> = {
      'Content-Type': serialized.contentType,
      'Cache-Control': 'no-store',
      ...(feed.headers ?? {}),
    }
    if (feed.subscriptionInfo) {
      const headerVal = formatSubscriptionInfo(feed.subscriptionInfo)
      if (headerVal) outHeaders['Subscription-Userinfo'] = headerVal
    }

    res.writeHead(statusCode, outHeaders)
    res.end(method === 'HEAD' ? undefined : serialized.body)
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(err => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(err instanceof Error ? err.message : 'Internal mock error')
      }
    })
  })

  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`

  function getFeedOrThrow(feedId: string): MockSubFeed {
    const existing = feeds.get(feedId)
    if (!existing) throw new Error(`MockSubServer: unknown feedId "${feedId}"`)
    return existing
  }

  function getRequests(feedId?: string): RecordedSubRequest[] {
    return feedId ? requests.filter(r => r.feedId === feedId) : [...requests]
  }

  function resetRequests(feedId?: string): void {
    if (!feedId) {
      requests.length = 0
      return
    }
    for (let i = requests.length - 1; i >= 0; i--) {
      if (requests[i].feedId === feedId) {
        requests.splice(i, 1)
      }
    }
  }

  return {
    port,
    origin,
    urlFor(feedId: string) {
      return `${origin}/sub/${encodeURIComponent(feedId)}`
    },
    setFeed(feedId: string, feed: MockSubFeed) {
      feeds.set(feedId, structuredClone(feed))
    },
    updateFeed(feedId: string, updater: (current: MockSubFeed) => MockSubFeed) {
      const current = getFeedOrThrow(feedId)
      feeds.set(feedId, structuredClone(updater(structuredClone(current))))
    },
    replaceNodes(feedId: string, nodes: MockProxyNode[]) {
      const current = getFeedOrThrow(feedId)
      feeds.set(feedId, { ...current, nodes: structuredClone(nodes), rawBody: undefined, statusCode: 200 })
    },
    addNode(feedId: string, node: MockProxyNode) {
      const current = getFeedOrThrow(feedId)
      feeds.set(feedId, { ...current, nodes: [...current.nodes, structuredClone(node)], rawBody: undefined, statusCode: 200 })
    },
    removeNode(feedId: string, name: string) {
      const current = getFeedOrThrow(feedId)
      feeds.set(feedId, { ...current, nodes: current.nodes.filter(n => n.name !== name), rawBody: undefined, statusCode: 200 })
    },
    setStatus(feedId: string, statusCode: number, rawBody?: string) {
      const current = feeds.get(feedId) ?? { format: 'yaml' as const, nodes: [] }
      feeds.set(feedId, { ...current, statusCode, rawBody })
    },
    getRequests,
    getRequestCount(feedId?: string) {
      return getRequests(feedId).length
    },
    resetRequests,
    async close() {
      server.closeAllConnections?.()
      for (const socket of sockets) {
        socket.destroy()
      }
      if (server.listening) {
        await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      }
    },
  }
}
