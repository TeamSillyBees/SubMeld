import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { connect } from 'node:tls'
import { isIP, type Socket } from 'node:net'
import { once } from 'node:events'
import type { LatencySample, QualityConfig, QualityRow, SpeedReading } from '../shared/quality.ts'
import type { Outlet } from './core.ts'

export const targets = {
  latency: 'https://www.gstatic.com/generate_204',
  exit: 'https://www.cloudflare.com/cdn-cgi/trace',
  download: 'https://speed.cloudflare.com/__down',
}
export type Targets = typeof targets
const round = (value: number) => Math.round(value * 10) / 10

async function viaOutlet<T>(outlet: Outlet, target: string, signal: AbortSignal,
  consume: (res: IncomingMessage) => Promise<T> | T, onHandshake?: (ms: number) => void, headers: Record<string, string> = {}): Promise<T> {
  signal.throwIfAborted()
  const url = new URL(target)
  const authority = url.hostname + ':' + (url.port || '443')
  const socket = await new Promise<Socket>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: outlet.port, method: 'CONNECT', path: authority, agent: false, signal,
      headers: { Host: authority, 'Proxy-Authorization': 'Basic ' + Buffer.from('probe:' + outlet.password).toString('base64') } })
    request.once('error', reject)
    request.once('connect', (response, stream, head) => {
      if (response.statusCode !== 200 || head.length) { stream.destroy(); reject(new Error('代理隧道连接失败。')); return }
      resolve(stream)
    })
    request.end()
  })
  const agent = new https.Agent({ keepAlive: false })
  try {
    signal.throwIfAborted()
    const startTls = performance.now()
    const secure = connect({ socket, servername: url.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] })
    try {
      await once(secure, 'secureConnect', { signal })
      onHandshake?.(round(performance.now() - startTls))
      agent.createConnection = () => secure
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        https.get(url, { agent, signal, headers: { 'Accept-Encoding': 'identity', Connection: 'close', ...headers } }, resolve).once('error', reject)
      })
      try { return await consume(response) } finally { response.destroy() }
    } finally { secure.destroy() }
  } finally { agent.destroy(); socket.destroy() }
}

async function sample(outlet: Outlet, signal: AbortSignal, target: string): Promise<LatencySample> {
  const start = performance.now()
  let tlsMs: number | null = null
  try {
    const httpsMs = await viaOutlet(outlet, target, AbortSignal.any([signal, AbortSignal.timeout(6000)]),
      res => res.statusCode === 204 ? round(performance.now() - start) : null, value => { tlsMs = value })
    return { tlsMs, httpsMs }
  } catch { signal.throwIfAborted(); return { tlsMs, httpsMs: null } }
}
function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2)
}
export function summarize(samples: LatencySample[]) {
  const https = samples.flatMap(s => s.httpsMs ?? [])
  const tls = samples.flatMap(s => s.tlsMs ?? [])
  const differences = https.slice(1).map((value, i) => Math.abs(value - https[i]))
  return {
    available: https.length > 0, tlsMedianMs: median(tls), httpsMedianMs: median(https),
    jitterMs: differences.length ? round(differences.reduce((a, b) => a + b, 0) / differences.length) : null,
    lossRate: samples.length ? (samples.length - https.length) / samples.length : null,
  }
}
async function readExit(outlet: Outlet, signal: AbortSignal, target: string): Promise<QualityRow['exit']> {
  try {
    return await viaOutlet(outlet, target, AbortSignal.any([signal, AbortSignal.timeout(6000)]), async res => {
      if (res.statusCode !== 200) return null
      const parts: Buffer[] = []
      let size = 0
      for await (const chunk of res) {
        size += chunk.length
        if (size > 16_384) return null
        parts.push(chunk)
      }
      const trace = Buffer.concat(parts).toString()
      const ip = /^ip=(\S+)\s*$/m.exec(trace)?.[1]
      const region = /^loc=([A-Z]{2})\s*$/m.exec(trace)?.[1] ?? null
      if (!ip || !isIP(ip)) return null
      return { ip: isIP(ip) === 6 ? new URL('http://[' + ip + ']').hostname.slice(1, -1) : ip, region }
    })
  } catch { signal.throwIfAborted(); return null }
}

export async function measureLatency(key: string, outlet: Outlet, config: QualityConfig, signal: AbortSignal, endpoints = targets): Promise<QualityRow> {
  await sample(outlet, signal, endpoints.latency)
  const samples: LatencySample[] = []
  for (let i = 0; i < config.rounds; i++) samples.push(await sample(outlet, signal, endpoints.latency))
  const metrics = summarize(samples)
  return { key, samples, ...metrics, error: metrics.available ? null : 'no_response',
    exit: metrics.available ? await readExit(outlet, signal, endpoints.exit) : null, speed: null, ai: null }
}

export async function measureSpeed(outlet: Outlet, config: QualityConfig, signal: AbortSignal, target = targets.download): Promise<SpeedReading> {
  const limit = config.mebibytes * 1024 ** 2
  const duration = config.seconds * 1000
  const deadline = AbortSignal.timeout(duration)
  const active = AbortSignal.any([signal, deadline])
  const start = performance.now()
  const buckets: number[] = Array(config.seconds).fill(0)
  let bytes = 0
  let stop: SpeedReading['stop'] = 'end'
  const url = new URL(target)
  url.searchParams.set('bytes', String(limit))
  try {
    await viaOutlet(outlet, url.href, active, async res => {
      if (![200, 206].includes(res.statusCode ?? 0)) { stop = 'error'; return }
      for await (const chunk of res) {
        const elapsed = performance.now() - start
        if (elapsed >= duration) { stop = 'duration'; break }
        const count = Math.min(chunk.length, limit - bytes)
        buckets[Math.floor(elapsed / 1000)] += count
        bytes += count
        if (bytes >= limit) { stop = 'bytes'; break }
      }
    }, undefined, { Range: 'bytes=0-' + (limit - 1) })
  } catch {
    signal.throwIfAborted()
    stop = deadline.aborted ? 'duration' : 'error'
  }
  const elapsedMs = Math.max(1, Math.min(duration, performance.now() - start))
  const perSecondBps = buckets.slice(0, Math.ceil(elapsedMs / 1000)).map((count, i) =>
    Math.round(count * 1000 / Math.max(1, Math.min(1000, elapsedMs - 1000 * i))))
  return { bytes, elapsedMs: round(elapsedMs), averageBps: Math.round(bytes * 1000 / elapsedMs),
    peakBps: Math.max(0, ...perSecondBps), perSecondBps, stop }
}
