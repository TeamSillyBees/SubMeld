import dns from 'node:dns/promises'
import { BlockList, connect, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { QualityNode } from '../shared/quality.ts'

const privateAddresses = new BlockList()
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) privateAddresses.addSubnet(ip, prefix)
for (const [ip, prefix] of [['::', 96], ['fc00::', 7], ['fe80::', 10]] as const) privateAddresses.addSubnet(ip, prefix, 'ipv6')
const udpOnly = new Set(['hysteria', 'hysteria2', 'tuic', 'wireguard'])

async function sampleDns(host: string, signal: AbortSignal) {
  const answers = await Promise.all(['1.1.1.1', '8.8.8.8', '9.9.9.9'].map(async server => {
    const resolver = new dns.Resolver({ timeout: 1200, tries: 1 })
    resolver.setServers([server])
    const cancel = () => resolver.cancel()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      return (await Promise.all([resolver.resolve4(host).catch(() => []), resolver.resolve6(host).catch(() => [])])).flat()
    } finally { signal.removeEventListener('abort', cancel) }
  }))
  return answers.flat()
}

async function reachable(addresses: string[], ports: Set<number>, signal: AbortSignal) {
  const finish = new AbortController()
  const probe = AbortSignal.any([signal, finish.signal, AbortSignal.timeout(2000)])
  const iface = process.env.SUBMELD_PROBE_INTERFACE
  const local = iface ? networkInterfaces()[iface] ?? [] : []
  try {
    return await Promise.any([...new Set(addresses)].slice(0, 8).map(async ip => {
      const localAddress = local.find(i => i.family === (isIP(ip) === 6 ? 'IPv6' : 'IPv4'))?.address
      if (iface && !localAddress) throw new Error('interface')
      for (const port of ports) await new Promise<void>((resolve, reject) => {
        probe.throwIfAborted()
        const socket = connect({ host: ip, port, localAddress, signal: probe })
        socket.once('error', reject).once('connect', () => { socket.destroy(); resolve() })
      })
      return ip
    }))
  } catch { signal.throwIfAborted(); return null }
  finally { finish.abort() }
}

// A temporary hosts entry preserves the original TLS name and transport Host header.
// Pin only an address that answers on every assigned TCP port for that hostname.
export async function entryHosts(nodes: QualityNode[], signal: AbortSignal) {
  const endpoints = new Map<string, Set<number>>(), skip = new Set<string>()
  for (const { connection: c } of nodes) {
    const host = String(c.server).toLowerCase()
    if (isIP(host) || !/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(host)) continue
    if (udpOnly.has(String(c.type)) || c.network === 'quic' || c.ports || c['ip-version']) { skip.add(host); continue }
    const ports = endpoints.get(host) ?? new Set<number>()
    ports.add(Number(c.port))
    endpoints.set(host, ports)
  }
  const hosts: Record<string, string> = Object.create(null)
  const groups = [...endpoints].filter(([host]) => !skip.has(host))
  let next = 0
  async function worker() {
    while (next < groups.length) {
      signal.throwIfAborted()
      const [host, ports] = groups[next++]
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(2000)])
      const system = await new Promise<string[]>(resolve => {
        const stop = () => resolve([])
        timeout.addEventListener('abort', stop, { once: true })
        dns.lookup(host, { all: true }).then(result => resolve(result.map(r => r.address)), stop)
          .finally(() => timeout.removeEventListener('abort', stop))
      })
      signal.throwIfAborted()
      let ip = await reachable(system, ports, signal)
      const local = !host.includes('.') || /\.(?:localhost|local|lan|internal|invalid|test|example|onion|home\.arpa)$/.test(host) ||
        system.some(a => privateAddresses.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4'))
      if (!ip && !local) {
        const answers = await sampleDns(host, signal)
        ip = await reachable(answers.filter(a => !privateAddresses.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4')), ports, signal)
      }
      if (ip) hosts[host] = ip
    }
  }
  await Promise.all(Array.from({ length: Math.min(groups.length, 6) }, worker))
  return hosts
}
