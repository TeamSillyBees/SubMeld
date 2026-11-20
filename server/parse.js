import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { parseDocument } from 'yaml'
import ipaddr from 'ipaddr.js'
import { identifyRegion } from '../shared/catalog.js'
import { classicalEntry, normalizeDomain, parseRange } from '../shared/config.js'
import { containsSubscriptionSecret, hasSecret, subscriptionSecrets } from './remote.js'
import { UserError } from './schema.js'

const words = value => value.split(/\s+/).filter(Boolean)
const common = words('type server port ports ip-version udp interface-name routing-mark tfo mptcp smux')
const tls = words('tls sni servername alpn skip-cert-verify fingerprint client-fingerprint certificate private-key reality-opts ech-opts')
const transport = words('network ws-opts grpc-opts http-opts h2-opts xhttp-opts')
const protocols = {
  ss: words('cipher password plugin plugin-opts udp-over-tcp udp-over-tcp-version ip-version'),
  ssr: words('cipher password obfs obfs-param protocol protocol-param'),
  vmess: [...words('uuid alterId cipher global-padding authenticated-length packet-encoding xudp'), ...tls, ...transport],
  vless: [...words('uuid flow packet-encoding xudp encryption'), ...tls, ...transport],
  trojan: [...words('password ss-opts'), ...tls, ...transport],
  hysteria: [...words('auth auth-str protocol obfs up down ca ca-str recv-window-conn recv-window disable-mtu-discovery hop-interval fast-open'), ...tls],
  hysteria2: [...words('password obfs obfs-password up down ca ca-str hop-interval cwnd bbr-profile'), ...tls],
  tuic: [...words('uuid password token ip heartbeat-interval reduce-rtt request-timeout udp-relay-mode congestion-controller max-udp-relay-packet-size disable-sni version fast-open max-open-streams cwnd bbr-profile'), ...tls],
  http: [...words('username password headers'), ...tls],
  socks5: [...words('username password'), ...tls],
  wireguard: words('ip ipv6 private-key public-key pre-shared-key reserved allowed-ips peers mtu remote-dns-resolve dns keepalive amnezia-wg'),
  snell: words('psk version obfs-opts reuse'),
  anytls: [...words('password idle-session-check-interval idle-session-timeout min-idle-session'), ...tls],
  ssh: words('username password private-key private-key-passphrase host-key host-key-algorithms'),
}
const connectionOptions = new Map(Object.entries(protocols)
  .map(([type, options]) => [type, new Set([...common, ...options])]))
const ignoredMetadata = new Set(words('remarks remark tag source source-name airport provider subscription sub-url subscription-url subscription-token description metadata id token'))
const requiredKeys = {
  ss: ['cipher', 'password'], ssr: ['cipher', 'password', 'protocol', 'obfs'],
  vmess: ['uuid', 'cipher'], vless: ['uuid'], trojan: ['password'], hysteria2: ['password'],
  anytls: ['password'], snell: ['psk'], wireguard: ['private-key'], ssh: ['username'],
}
const ssCiphers = new Set(words('aes-128-gcm aes-192-gcm aes-256-gcm chacha20-ietf-poly1305 xchacha20-ietf-poly1305 2022-blake3-aes-128-gcm 2022-blake3-aes-256-gcm 2022-blake3-chacha20-poly1305 aes-128-cfb aes-192-cfb aes-256-cfb aes-128-ctr aes-192-ctr aes-256-ctr rc4-md5 chacha20 chacha20-ietf xchacha20 dummy none'))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NODES = 16000

export const digest = value => createHash('sha256').update(value).digest('hex')
const decode = value => decodeURIComponent(value)
const decoder = new TextDecoder('utf-8', { fatal: true })

function asText(bytes) {
  try {
    return decoder.decode(bytes)
  } catch {
    throw new UserError('上游响应并非 UTF-8 文本。')
  }
}

function base64(value) {
  const normalized = value.replace(/\s+/g, '')
  if (!normalized || !/^[a-z0-9+/_-]+={0,2}$/i.test(normalized) || normalized.replace(/=+$/, '').length % 4 === 1) {
    throw new UserError('Base64 数据格式无效。')
  }
  return asText(Buffer.from(normalized, 'base64url'))
}

export function safeYaml(text) {
  try {
    const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true, logLevel: 'silent', schema: 'core' })
    if (document.errors.length) throw new Error()
    return document.toJS({ maxAliasCount: 20 })
  } catch {
    throw new UserError('YAML 格式无效或包含过于复杂的别名。')
  }
}

function plain(value, depth = 0) {
  if (depth > 16) throw new UserError('节点选项的嵌套层级过多。')
  if (value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(child => plain(child, depth + 1))
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
      .map(([key, child]) => [key, plain(child, depth + 1)]))
  }
  throw new UserError('节点包含无法识别的选项值。')
}

export function connectionFrom(node) {
  if (!node || Object.getPrototypeOf(node) !== Object.prototype) throw new UserError('节点须为一组连接参数。')
  const { name, type } = node
  if (typeof name !== 'string' || !name.trim() || name.length > 512) throw new UserError('缺少有效的原始节点名。')
  const allowed = connectionOptions.get(type)
  if (!allowed) throw new UserError('该代理协议暂不可导入。')
  if (node['dialer-proxy']) throw new UserError('该节点依赖上游的链式代理配置。')
  const { server } = node
  if (typeof server !== 'string' || (!ipaddr.isValid(server) && !normalizeDomain(server))) throw new UserError('服务器域名或 IP 无效。')
  const port = typeof node.port === 'string' && /^\d+$/.test(node.port) ? Number(node.port) : node.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('节点端口须在 1–65535 范围内。')
  const connection = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'name' || ignoredMetadata.has(key.toLowerCase()) && !(type === 'tuic' && key === 'token')) continue
    if (key === 'dialer-proxy' && !value) continue
    const option = type === 'hysteria2' && key === 'mport' ? 'ports' : key
    if (option !== key && Object.hasOwn(node, option)) continue
    if (!allowed.has(option)) throw new UserError('含未识别的连接选项，未导入该节点以免丢失连接参数。')
    connection[option] = plain(value)
  }
  connection.port = port
  if (node.network && !words('tcp ws grpc h2 http xhttp').includes(node.network)) throw new UserError('该节点的传输方式暂不可导入。')
  for (const key of requiredKeys[type] ?? []) {
    if (typeof connection[key] === 'number') connection[key] = String(connection[key])
    if (typeof connection[key] !== 'string' || !connection[key]) throw new UserError('缺少协议所需的认证或加密参数。')
  }
  if ((type === 'vless' || type === 'vmess') && !uuid.test(connection.uuid)) throw new UserError('节点 UUID 格式无效。')
  if (type === 'vmess' && !words('auto none zero aes-128-gcm chacha20-poly1305').includes(connection.cipher)) {
    throw new UserError('VMess 加密方式无效。')
  }
  if (type === 'ss' && !ssCiphers.has(connection.cipher)) throw new UserError('不支持此 Shadowsocks 加密方式。')
  if (type === 'ss' && connection.plugin && !words('obfs v2ray-plugin shadow-tls restls gost-plugin kcptun').includes(connection.plugin)) {
    throw new UserError('暂不支持此 Shadowsocks 插件。')
  }
  if (type === 'ss' && connection.cipher.startsWith('2022-')) {
    const size = connection.cipher.includes('128') ? 16 : 32
    if (connection.password.split(':').some(key => !/^[a-z0-9+/_-]+={0,2}$/i.test(key) || Buffer.from(key, 'base64url').length !== size)) {
      throw new UserError('Shadowsocks 2022 的密钥长度无效。')
    }
  }
  if (type === 'tuic' && !(connection.token || (uuid.test(connection.uuid ?? '') && connection.password))) {
    throw new UserError('TUIC 缺少相应版本所需的认证参数。')
  }
  if (type === 'wireguard' && (!connection.publicKey && !connection['public-key'] && !connection.peers?.length)) {
    throw new UserError('WireGuard 缺少对端公钥或对端配置。')
  }
  return { name, type, server, port, connection }
}

export function configHasSubscriptionSecret(config, secrets) {
  const { proxies, ...rest } = config ?? {}
  if (containsSubscriptionSecret(rest, secrets)) return true
  if (!Array.isArray(proxies)) return containsSubscriptionSecret(proxies, secrets)

  // A node can use the same value for connection authentication and subscription downloads.
  const linksOnly = { links: secrets.links, tokens: [] }
  return proxies.some(node => {
    const allowed = connectionOptions.get(node?.type)
    if (!allowed) return containsSubscriptionSecret(node, secrets)
    return Object.entries(node).some(([key, value]) => {
      const protection = allowed.has(key) ? linksOnly : secrets
      return hasSecret(key, protection) || containsSubscriptionSecret(value, protection)
    })
  })
}

function tcpTransport(node, params) {
  const network = params.get('type') || 'tcp'
  const host = params.get('host')
  const path = params.get('path')
  node.network = network
  if (network === 'ws') node['ws-opts'] = { path: path || '/', ...(host ? { headers: { Host: host } } : {}) }
  else if (network === 'grpc') node['grpc-opts'] = { 'grpc-service-name': params.get('serviceName') || path || '' }
  else if (network === 'http' || network === 'h2') {
    node[network + '-opts'] = network === 'h2'
      ? { path: path || '/', ...(host ? { host: host.split(',') } : {}) }
      : { path: [path || '/'], ...(host ? { headers: { Host: host.split(',') } } : {}) }
  } else if (network === 'xhttp' || params.get('headerType') === 'http' || params.get('extra')) {
    throw new UserError('该分享链接使用了暂未支持的高级传输选项。')
  }
}

function tlsTransport(node, params, force = false) {
  const security = params.get('security')
  if (security && !['none', 'tls', 'reality'].includes(security)) throw new UserError('不支持此 TLS 类型。')
  if (force || security === 'tls' || security === 'reality') node.tls = true
  const servername = params.get('sni') || params.get('peer')
  if (servername) node[node.type === 'vless' || node.type === 'vmess' ? 'servername' : 'sni'] = servername
  if (/^(1|true)$/i.test(params.get('insecure') || params.get('allowInsecure') || '')) node['skip-cert-verify'] = true
  if (params.has('fp')) node['client-fingerprint'] = params.get('fp')
  if (params.has('alpn')) node.alpn = params.get('alpn').split(',')
  if (params.has('pinSHA256')) node.fingerprint = params.get('pinSHA256')
  if (security === 'reality') {
    if (!params.get('pbk')) throw new UserError('Reality 分享链接缺少公钥。')
    node['reality-opts'] = { 'public-key': params.get('pbk'), 'short-id': params.get('sid') || '' }
  }
}

function parseSS(value) {
  const hash = value.indexOf('#')
  if (hash < 0) throw new UserError('分享链接未提供原始节点名。')
  const name = decode(value.slice(hash + 1))
  let address = value.slice(5, hash)
  if (!address.includes('@')) address = base64(address)
  const separator = address.lastIndexOf('@')
  if (separator < 0) throw new UserError('Shadowsocks 分享链接格式无效。')
  let login = decode(address.slice(0, separator))
  if (!login.includes(':')) login = base64(login)
  const colon = login.indexOf(':')
  if (colon < 0) throw new UserError('Shadowsocks 分享链接缺少密码。')
  const uri = new URL('ss://' + address.slice(separator + 1))
  const node = { name, type: 'ss', server: uri.hostname.replace(/^\[|\]$/g, ''), port: Number(uri.port), cipher: login.slice(0, colon), password: login.slice(colon + 1), udp: true }
  const plugin = uri.searchParams.get('plugin')
  if (plugin) {
    const [type, ...params] = plugin.split(';')
    const options = new Map(params.map(entry => {
      const index = entry.indexOf('=')
      return index < 0 ? [entry, true] : [entry.slice(0, index), entry.slice(index + 1)]
    }))
    if (type === 'obfs-local' || type === 'simple-obfs') {
      node.plugin = 'obfs'
      node['plugin-opts'] = { mode: options.get('obfs'), host: options.get('obfs-host') }
    } else if (type === 'v2ray-plugin') {
      node.plugin = type
      node['plugin-opts'] = { mode: 'websocket', ...Object.fromEntries(options) }
    } else throw new UserError('该分享链接的 Shadowsocks 插件暂不可导入。')
  }
  return node
}

function parseVMess(value) {
  const json = JSON.parse(base64(value.slice(8)))
  const node = {
    type: 'vmess', name: json.ps, server: json.add, port: Number(json.port),
    uuid: json.id, alterId: Number(json.aid ?? 0), cipher: json.scy || 'auto', udp: true,
  }
  const params = new URLSearchParams({
    type: json.net || 'tcp', headerType: json.type || '', host: json.host || '', path: json.path || '',
    security: json.tls === 'tls' ? 'tls' : 'none', sni: json.sni || '',
  })
  if (json.fp) params.set('fp', json.fp)
  if (json.alpn) params.set('alpn', json.alpn)
  tcpTransport(node, params)
  tlsTransport(node, params)
  return node
}

function uriNode(value) {
  if (value.startsWith('ss://')) return parseSS(value)
  if (value.startsWith('vmess://')) return parseVMess(value)
  const uri = new URL(value)
  const scheme = uri.protocol.slice(0, -1)
  const type = ({ hy2: 'hysteria2', socks: 'socks5' })[scheme] ?? scheme
  if (!['vless', 'trojan', 'hysteria2', 'socks5', 'anytls'].includes(type)) throw new UserError('该分享链接协议暂不可导入。')
  const node = { name: decode(uri.hash.slice(1)), type, server: uri.hostname.replace(/^\[|\]$/g, ''), port: Number(uri.port || 443), udp: true }
  const params = uri.searchParams
  if (type === 'socks5') {
    if (uri.username) node.username = decode(uri.username)
    if (uri.password) node.password = decode(uri.password)
    return node
  }
  if (type === 'vless') {
    node.uuid = decode(uri.username)
    if (params.get('flow')) node.flow = params.get('flow')
    if (params.get('encryption') && params.get('encryption') !== 'none') node.encryption = params.get('encryption')
    if (params.get('packetEncoding')) node['packet-encoding'] = params.get('packetEncoding')
  } else node.password = decode(uri.username + (uri.password ? ':' + uri.password : ''))
  if (type === 'vless' || type === 'trojan') tcpTransport(node, params)
  if (type === 'hysteria2') {
    if (params.get('obfs')) node.obfs = params.get('obfs')
    if (params.get('obfs-password')) node['obfs-password'] = params.get('obfs-password')
    if (params.get('mport')) node.ports = params.get('mport')
  }
  tlsTransport(node, params, type !== 'vless')
  return node
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}
export const compareDigest = value => digest(JSON.stringify(stable(value)))

export function parseSource(bytes, urls) {
  const text = asText(bytes).trim()
  if (!text) throw new UserError('订阅返回空内容。')
  let entries
  let providers = []
  let format = 'Mihomo YAML'
  if (/^[a-z0-9-]+:\/\//i.test(text)) {
    entries = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    format = '节点分享链接'
  } else {
    let decoded
    try { decoded = base64(text) } catch { /* YAML can be tested independently. */ }
    if (decoded && /^[a-z0-9-]+:\/\//im.test(decoded)) {
      entries = decoded.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      format = 'Base64 分享链接'
    } else {
      if (/^</.test(text)) throw new UserError('上游返回网页而非订阅数据，请检查链接是否已过期。')
      const config = safeYaml(text)
      entries = Array.isArray(config) ? config : config?.proxies
      providers = Object.keys(config?.['proxy-providers'] ?? {})
      if (!Array.isArray(entries)) {
        throw new UserError(providers.length ? '订阅仅提供外部代理集合，当前需要直接包含节点的机场订阅。' : '无法识别订阅格式，请选择 Mihomo/Clash YAML 或节点分享链接。')
      }
    }
  }
  if (entries.length > MAX_NODES) throw new UserError('单个机场最多支持 16,000 个节点。')
  const nodes = []
  const secrets = subscriptionSecrets(urls)
  const rejected = providers.map((_, index) => ({ item: '代理集合 ' + (index + 1), reason: '集合中的外部代理未导入，请使用直接包含节点的订阅。' }))
  const counts = new Map()
  for (const [index, entry] of entries.entries()) {
    try {
      const node = connectionFrom(typeof entry === 'string' && format !== 'Mihomo YAML' ? uriNode(entry) : entry)
      const fingerprint = compareDigest(node.connection)
      const key = digest(node.name).slice(0, 32)
      const record = { name: node.name, type: node.type, region: identifyRegion(node.name), connection: node.connection, fingerprint, key }
      counts.set(key, (counts.get(key) ?? 0) + 1)
      nodes.push(record)
    } catch (error) {
      const item = typeof entry?.name === 'string' && !hasSecret(entry.name, secrets)
        ? '第 ' + (index + 1) + ' 项 · ' + entry.name.slice(0, 128)
        : '第 ' + (index + 1) + ' 项'
      rejected.push({ item, reason: error instanceof UserError ? error.message : '无法解析该节点分享参数。' })
    }
  }
  const seen = new Map()
  for (const node of nodes) {
    const base = counts.get(node.key) > 1 ? node.key.slice(0, 16) + node.fingerprint.slice(0, 16) : node.key
    const occurrence = (seen.get(base) ?? 0) + 1
    node.id = occurrence > 1 ? base + '-' + occurrence : base
    delete node.key
    seen.set(base, occurrence)
  }
  return { total: entries.length, format, nodes, rejected, urls }
}

export function parseProvider(bytes, provider) {
  const content = asText(bytes)
  const entries = provider.format === 'yaml'
    ? safeYaml(content)?.payload
    : content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
  if (!Array.isArray(entries) || !entries.length) throw new UserError('规则集为空或缺少 payload 列表。请核对文件格式。')
  if (entries.length > 100000) throw new UserError('规则集条目超过 100,000 条。')
  const payload = entries.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length > 2048) throw new UserError('第 ' + (index + 1) + ' 条规则集内容格式不正确。')
    const value = entry.trim()
    if (provider.behavior === 'ipcidr' && parseRange(value)) return value
    if (provider.behavior === 'domain') {
      const prefix = value.match(/^(?:\*|\+)?\./)?.[0] ?? ''
      const suffix = normalizeDomain(value.slice(prefix.length))
      if (suffix) return prefix + suffix
    }
    if (provider.behavior === 'classical') {
      const parsed = classicalEntry(value)
      if (parsed) return parsed
    }
    throw new UserError('第 ' + (index + 1) + ' 条规则与所选规则集类型不兼容。')
  })
  return { behavior: provider.behavior, payload }
}
