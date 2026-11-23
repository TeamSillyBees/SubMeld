import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { get } from 'node:https'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import { probeProtocol } from '../shared/quality-options.ts'
import type { ProbeCapabilities } from '../shared/quality.ts'
import { countryCode } from './regions.ts'

const require = createRequire(import.meta.url)
const { version } = require(import.meta.url.endsWith('.ts') ? './package.json' : '../package.json') as { version: string }

async function networkLocation(signal: AbortSignal, localAddress?: string) {
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    get('https://ipinfo.io/json', { signal, localAddress }, resolve).once('error', reject)
  })
  try {
    if (response.statusCode !== 200) return null
    let text = ''
    for await (const chunk of response) {
      text += chunk
      if (text.length > 16_384) return null
    }
    const data = JSON.parse(text)
    return { localRegion: countryCode(data.country), localIsp: typeof data.org === 'string' ? data.org.slice(0, 120) : null }
  } finally { response.destroy() }
}

export async function capabilities(binary: string, iface: string | undefined, signal: AbortSignal): Promise<ProbeCapabilities> {
  const interfaces = networkInterfaces()
  const entries = (iface ? interfaces[iface] ?? [] : Object.values(interfaces).flat()).filter(entry =>
    entry && !entry.internal && !entry.scopeid && !entry.address.startsWith('169.254.'))
  const ipv4 = entries.some(entry => entry?.family === 'IPv4'), ipv6 = entries.some(entry => entry?.family === 'IPv6')
  const address = iface ? entries.find(entry => entry?.family === 'IPv4')?.address ?? entries[0]?.address : undefined
  const [core, location] = await Promise.all([
    promisify(execFile)(binary, ['-v'], { signal, timeout: 3000, windowsHide: true }).then(({ stdout }) => /mihomo\s+(?:meta\s+)?([^\s]+)/i.exec(stdout)?.[1]?.slice(0, 100) ?? null).catch(() => null),
    iface && !address ? null : networkLocation(AbortSignal.any([signal, AbortSignal.timeout(3000)]), address).catch(() => null),
  ])
  signal.throwIfAborted()
  return { agentVersion: version, protocolVersion: probeProtocol, mihomoVersion: core, ipStack: ipv4 && ipv6 ? 'dual' : ipv4 ? 'ipv4' : ipv6 ? 'ipv6' : null,
    localRegion: location?.localRegion ?? null, localIsp: location?.localIsp ?? null }
}
