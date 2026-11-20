import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import ipaddr from 'ipaddr.js'
import { UserError, read, url } from './schema.js'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_SIZE = 12 * 1024 * 1024
const decoders = new Map([['gzip', gunzipSync], ['deflate', inflateSync], ['br', brotliDecompressSync]])

export function parseSubscriptionInfo(header) {
  if (typeof header !== 'string') return null
  const info = {}
  for (const field of header.split(';')) {
    const match = /^\s*(upload|download|total|expire)\s*=\s*(\d+)\s*$/i.exec(field)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = Number(match[2])
    // Expiry is Unix seconds, within the same four-digit year range as renewal dates.
    if (Number.isSafeInteger(value) && (key !== 'expire' || value <= 253402300799)) info[key] = value
  }
  return Object.keys(info).length ? { ...info, updatedAt: new Date().toISOString() } : null
}

async function publicAddress(hostname, options, signal) {
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  let addresses
  try {
    addresses = await Promise.race([lookup(hostname, { all: true }), aborted])
  } catch {
    throw new UserError(signal.aborted ? '连接上游超时。' : '无法解析上游地址，请检查链接和服务端网络。')
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  if (!addresses.length) throw new UserError('没有解析到可用的上游地址。')
  if (!options.allowPrivate && addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
    throw new UserError('该地址指向内网、本机或保留网段。请选择公开的 HTTP(S) 地址。')
  }
  return addresses.find(address => address.family === 4) ?? addresses[0]
}

function request(address, ip, signal, accept) {
  const transport = address.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = transport.get(address, {
      signal, agent: false, autoSelectFamily: false, family: ip.family,
      lookup: (_host, _options, callback) => callback(null, ip.address, ip.family),
      headers: { 'user-agent': 'clash.meta (SubMeld)', 'accept-encoding': 'gzip, deflate, br', accept },
    }, response => {
      response.on('error', reject)
      if (REDIRECTS.has(response.statusCode)) {
        const redirect = response.headers.location
        response.destroy()
        return redirect ? resolve({ redirect, bytes: null }) : reject(new UserError('上游返回了缺少目标地址的跳转。'))
      }
      if (response.statusCode !== 200) {
        response.destroy()
        return reject(new UserError('上游返回 HTTP ' + response.statusCode + '，请检查链接是否有效。'))
      }
      const encoding = (response.headers['content-encoding'] ?? 'identity').toLowerCase().trim()
      if (encoding !== 'identity' && !decoders.has(encoding)) {
        response.destroy()
        return reject(new UserError('上游返回了不支持的压缩编码。'))
      }
      let size = 0
      const chunks = []
      response.on('data', data => {
        size += data.length
        if (size > MAX_SIZE) {
          response.destroy(new UserError('上游响应超过 12 MiB。'))
          return
        }
        chunks.push(data)
      })
      response.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks)
          const bytes = encoding === 'identity' ? buffer : decoders.get(encoding)(buffer, { maxOutputLength: MAX_SIZE })
          resolve({ bytes, redirect: null, subscriptionInfo: parseSubscriptionInfo(response.headers['subscription-userinfo']) })
        } catch {
          reject(new UserError('上游压缩格式无效或解压后超过 12 MiB。'))
        }
      })
    })
    req.on('error', reject)
  })
}

export async function download(input, options = {}) {
  if (!read(url, input)) throw new UserError('请输入上游链接。')
  const signal = AbortSignal.timeout(options.timeout ?? 18000)
  const urls = []
  try {
    let address = new URL(input)
    for (let i = 0; i < 5; i++) {
      if (!read(url, address.href)) throw new UserError('上游跳转到了无法访问的地址。')
      urls.push(address.href)
      const ip = await publicAddress(address.hostname.replace(/^\[|\]$/g, ''), options, signal)
      const result = await request(address, ip, signal, options.accept ?? '*/*')
      if (!result.redirect) return { ...result, urls }
      address = new URL(result.redirect, address)
    }
    throw new UserError('上游跳转次数过多。')
  } catch (error) {
    if (error instanceof UserError) throw error
    if (signal.aborted) throw new UserError('获取上游数据超时，请检查服务端网络并重试。')
    throw new UserError('连接上游失败，请检查服务端网络、TLS 证书或订阅是否仍有效。')
  }
}

function decode(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

const credentialParameter = /^(?:(?:access|api|auth|sub|subscription)[_-]?)?(?:token|key|secret|auth|authorization|password|passwd|signature|sig)$/i
const opaqueToken = /^(?=[A-Za-z0-9_-]{20,}$)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+$/
const credentialSegment = /^(?:token|key|secret)$/i

export function subscriptionSecrets(urls) {
  const links = new Set()
  const tokens = new Set()
  for (const value of urls) {
    if (!value) continue
    let address
    try { address = new URL(value) } catch { continue }
    links.add(value)
    links.add(address.href)
    links.add(decode(address.href))
    if (address.hash) {
      address.hash = ''
      links.add(address.href)
      links.add(decode(address.href))
    }
    for (const [key, parameter] of address.searchParams) {
      if (parameter && (credentialParameter.test(key) || opaqueToken.test(parameter))) tokens.add(parameter)
    }
    const segments = address.pathname.split('/').filter(Boolean).map(decode)
    segments.forEach((segment, index) => {
      if (opaqueToken.test(segment) || credentialSegment.test(segments[index - 1] ?? '')) tokens.add(segment)
    })
  }
  return {
    links: [...links],
    tokens: [...tokens].map(value => {
      if (value.length >= 8) return value
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp('(?:^|[^A-Za-z0-9])' + escaped + '(?:$|[^A-Za-z0-9])')
    }),
  }
}

export function hasSecret(value, secrets) {
  if (typeof value !== 'string') return false
  const decoded = decode(value)
  const candidates = decoded === value ? [value] : [value, decoded]
  return candidates.some(candidate => secrets.links.some(link => candidate.includes(link))
    || secrets.tokens.some(token => typeof token === 'string' ? candidate.includes(token) : token.test(candidate)))
}

export function containsSubscriptionSecret(value, secrets) {
  if (typeof value === 'string') return hasSecret(value, secrets)
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(item => containsSubscriptionSecret(item, secrets))
  return Object.entries(value).some(([key, item]) => hasSecret(key, secrets) || containsSubscriptionSecret(item, secrets))
}
