import { Impit, type RequestInit as ImpitRequestInit } from 'impit'
import { surfaces, type AiReading, type AiResults, type Surface } from '../shared/quality.ts'
import { countryCode, countryFromLocation, unlistedRegions } from './regions.ts'
import type { Outlet } from './core.ts'

const urls: Record<Surface, string> = {
  chatgptWeb: 'https://api.openai.com/compliance/cookie_requirements', chatgptApp: 'https://android.chat.openai.com/',
  gemini: 'https://gemini.google.com/?hl=en', antigravity: 'https://antigravity.google/',
}
const antigravityGatewayUrl = 'https://daily-cloudcode-pa.googleapis.com/'
const googleBatchExecuteUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute'
const googleBatchExecuteBody = 'f.req=' + encodeURIComponent(JSON.stringify([[['K4WWud', '[[0],["en-US"]]', null, 'generic']]]))
const googleConsentCookie = 'SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnPpwY'
const googleHeaders = { 'Accept-Language': 'en-US,en;q=0.9', Cookie: googleConsentCookie }
const traceHosts: Partial<Record<Surface, string>> = {
  chatgptWeb: 'chatgpt.com', chatgptApp: 'chatgpt.com',
}
export interface Observation { status: number; body: string; location: string; challenge: boolean }
const restrictedRegions: Record<Surface, ReadonlySet<string>> = {
  chatgptWeb: unlistedRegions.ChatGPT, chatgptApp: unlistedRegions.ChatGPT, gemini: unlistedRegions.Gemini, antigravity: unlistedRegions.Antigravity,
}
function redirectTarget(response: Observation, base: string) {
  if (![301, 302, 303, 307, 308].includes(response.status) || !response.location) return null
  try {
    const url = new URL(response.location, base)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null
  } catch { return null }
}
export function classify(surface: Surface, response: Observation | null, exitRegion: string | null = null, traceRegion: string | null = null): AiReading {
  const status = response?.status ?? null
  const isGoogleSurface = surface === 'gemini' || surface === 'antigravity'
  let providerRegion = surface === 'gemini' ? (googleRegion(response?.body ?? '') ?? countryCode(traceRegion)) : countryCode(traceRegion)
  const reading = (state: AiReading['state'], evidence: AiReading['evidence'], needsReview = true): AiReading =>
    ({ state, evidence, needsReview, httpStatus: status, providerRegion })
  if (!response) return reading('network_error', 'network', false)
  const { body, challenge } = response
  const redirect = redirectTarget(response, urls[surface])
  let payload: Record<string, unknown> | null = null
  if (surface.startsWith('chatgpt')) {
    try { payload = JSON.parse(body) } catch { /* Gateways can also return HTML. */ }
    providerRegion = countryCode(payload?.country ?? payload?.region ?? payload?.country_code ?? payload?.countryCode) ?? providerRegion
  }
  if (status === 429) return reading('rate_limited', 'rate_limit', false)
  if (isGoogleSurface && (
    redirect && ['www.google.com', 'gemini.google.com', 'google.com', 'antigravity.google'].includes(redirect.hostname) && /^\/sorry(?:\/|$)/.test(redirect.pathname)
    || /unusual traffic from your computer|g-recaptcha|\/sorry\/(?:index|image)|not a robot/i.test(body)
  )) return reading('degraded_challenge', 'bot_challenge', false)
  const regionPage = redirect && ['chatgpt.com', 'gemini.google.com', 'antigravity.google', 'ai.google.dev', 'aistudio.google.com'].includes(redirect.hostname)
    && /\/(?:unsupported(?:-country|-region)?|unavailable-region|unavailable|app-unavailable-in-region|available-regions)(?:\/|$)/i.test(redirect.pathname)
  // Ignore translation dictionaries and other inactive text embedded in product page scripts.
  const visible = body.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  if (status === 451 || regionPage || /\bunsupported_country(?:_region_territory)?\b|(?:not (?:(?:yet|currently) )?available|not supported|unavailable) in (?:your|this) (?:country|region|location)|country, region, or territory not supported|blocked your country|error (?:code:? )?1009\b/i.test(visible)) {
    return reading('region_restricted', 'region_denied', false)
  }
  if (status === 403 && /(?:your|this) IP (?:address )?(?:has been|is) (?:banned|blocked)|(?:banned|blocked) your IP|error (?:code:? )?100[678]\b/i.test(visible)) return reading('ip_blocked', 'ip_denied', false)
  if (providerRegion && restrictedRegions[surface].has(providerRegion)) {
    return reading('region_restricted', 'region_policy', false)
  }
  if (isGoogleSurface && redirect?.hostname === 'consent.google.com') return reading('unknown', 'consent_redirect')
  if (challenge
    || /<title>\s*just a moment(?:\.{3}|…)/i.test(body) && /challenge-platform|_cf_chl_opt/i.test(body)
    || /challenge-platform|_cf_chl_opt|cf-turnstile/i.test(body) && /just a moment|请稍候|checking (?:your browser|if the site connection is secure)|enable javascript and cookies/i.test(body)) {
    return providerRegion ? reading('degraded_challenge', 'cf_challenge', false) : reading('challenge', 'cf_challenge')
  }
  if (surface === 'chatgptApp' && !redirect) {
    const details = payload?.cf_details
    const denial = JSON.stringify([details, payload?.error, payload?.blocked_why_headline])
    if (/\([12]\)|disallowed[\s_-]+isp|\b(?:vpn|proxy)\b/i.test(denial) || payload?.vpn_detected === true || /vpn (?:required|detected)|using a vpn/i.test(visible)) {
      return reading('unavailable', 'disallowed_isp', false)
    }
    if (payload?.blocked_why_headline || /something went wrong|unable to load site/i.test(visible)) return reading('unavailable', 'http_denied', false)
    if (!payload?.error && typeof details === 'string') {
      if (status === 200 || status === 403 && /^request is not allowed\.\s*please try again later\.?$/i.test(details.trim())) return reading('reachable', 'app_gateway', false)
      if (status === 403) return reading('unknown', 'unrecognized')
    }
    if (status === 403 && payload === null && /<(?:!doctype|html|title|head|body)\b/i.test(body)) {
      return reading('unknown', 'unrecognized')
    }
    if (response.status >= 500) return reading('unavailable', 'http_denied', true)
    return status === 403 ? reading('unavailable', 'http_denied', false) : reading('unknown', 'unrecognized')
  }
  if (surface === 'chatgptWeb' && status === 200) {
    if (typeof payload?.cookie_consent_required === 'boolean' || typeof payload?.cookie_requirements === 'object' && payload.cookie_requirements !== null) return reading('reachable', 'compliance_json', false)
    return reading('unknown', 'unrecognized')
  }
  if (isGoogleSurface && status === 403) return reading('unavailable', 'http_denied', false)
  if (status === 401 && /authentication_error|invalid.authentication|missing.{0,16}(?:api.key|token)|unauthorized/i.test(body)) return reading('authentication', 'credentials_required')
  if (redirect && ['accounts.google.com', 'auth.openai.com', new URL(urls[surface]).hostname].includes(redirect.hostname)
      && /login|sign[-_]?in|oauth|authorize|servicelogin/i.test(redirect.pathname)) return reading('authentication', 'login_redirect')
  // Public product entry pages are observable. A generic success page, API root or app gateway is inconclusive.
  if (status === 200 && isGoogleSurface) {
    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(body)?.[1] ?? ''
    if (/access denied|forbidden|unavailable|blocked/i.test(title)) return reading('unknown', 'unrecognized')
    if (title.toLowerCase().includes(surface)) {
      return verifyGemini(reading('reachable', 'web_entry', false), exitRegion, providerRegion, restrictedRegions[surface])
    }
  }
  return reading('unknown', 'unrecognized')
}
export function googleRegion(body: string) {
  const data = body.replace(/\\"/g, '"')
  const location = /"([^"]+)"\s*,\s*"SWML_DESCRIPTION_[A-Z_]+"/.exec(data)?.[1]
    ?.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  return countryCode(/,\s*2,\s*1,\s*200,\s*"([A-Z]{3})"/.exec(data)?.[1])
    ?? countryCode(/"K4WWud"\s*[:,]\s*(?:"\s*\[+|\[\s*|"|\s)*"([A-Z]{2,3})"/i.exec(data)?.[1])
    ?? countryFromLocation(location)
}
export function verifyGemini(
  reading: AiReading,
  exitRegion: string | null,
  providerRegion: string | null,
  restricted: ReadonlySet<string> = unlistedRegions.Gemini,
): AiReading {
  if (!providerRegion) return { ...reading, state: 'unknown', evidence: 'region_unconfirmed', providerRegion, needsReview: true }
  if (restricted.has(providerRegion)) return { ...reading, state: 'region_restricted', evidence: 'region_policy', providerRegion, needsReview: false }
  if (exitRegion && providerRegion !== exitRegion) return { ...reading, evidence: 'region_disagrees', providerRegion, needsReview: false }
  return { ...reading, providerRegion }
}
async function observe(client: Impit, url: string, signal: AbortSignal, timeoutMs: number, init?: ImpitRequestInit): Promise<Observation> {
  const target = new URL(url)
  const gatewayOnly = target.origin === 'https://daily-cloudcode-pa.googleapis.com'
  const gemini = target.origin === 'https://gemini.google.com' && target.pathname !== '/_/BardChatUi/data/batchexecute'
  const antigravity = target.origin === 'https://antigravity.google'
  const limit = url.endsWith('/cdn-cgi/trace') ? 4096 : target.pathname === '/_/BardChatUi/data/batchexecute' ? 64 * 1024 : gemini ? 1536 * 1024 : 256 * 1024
  const controller = new AbortController()
  const deadline = AbortSignal.timeout(timeoutMs)
  const active = AbortSignal.any([signal, controller.signal, deadline])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const res = await client.fetch(url, { ...init, signal: active, timeout: timeoutMs })
    const head = { status: res.status, body: '', location: res.headers.get('location') ?? '', challenge: res.headers.get('cf-mitigated') === 'challenge' }
    reader = res.body?.getReader()
    if (gatewayOnly || head.challenge || res.status === 429 || res.status === 451 || res.status >= 300 && res.status < 400 || !reader) return head
    const chunks: Buffer[] = []
    let size = 0
    let hasTitle = false, hasRegion = false
    let tail = ''
    while (size < limit) {
      const { value, done } = await reader.read()
      if (done) break
      const part = Buffer.from(value.subarray(0, limit - size))
      chunks.push(part)
      size += part.length
      if (gemini) {
        // Both markers are ASCII. Scan the whole new chunk before retaining its overlap.
        const window = tail + part.toString('latin1')
        hasTitle ||= /<title[^>]*>[^<]*Gemini[^<]*<\/title>/i.test(window)
        hasRegion ||= !!googleRegion(window)
        if (hasTitle && hasRegion) break
        tail = window.slice(-16 * 1024)
      } else if (antigravity) {
        const window = tail + part.toString('latin1')
        hasTitle ||= /<title[^>]*>[^<]*Antigravity[^<]*<\/title>/i.test(window)
        if (hasTitle && size >= 16 * 1024) break
        tail = window.slice(-16 * 1024)
      }
    }
    return { ...head, body: Buffer.concat(chunks).toString('utf8') }
  } catch (error) { deadline.throwIfAborted(); throw error }
  finally { controller.abort(); await reader?.cancel().catch(() => {}) }
}
export function applyExitRegionFallback(results: AiResults, exitRegion: string | null, traceRegions: (string | null)[]): AiResults {
  if (!exitRegion || traceRegions.some(region => region && region !== exitRegion)) return results
  const hosts = new Set<string>()
  for (const surface of surfaces) {
    const r = results[surface]
    if (!r.providerRegion || r.evidence === 'exit_region_fallback') continue
    if (r.providerRegion !== exitRegion) return results
    hosts.add(traceHosts[surface] ?? (surface === 'antigravity' ? 'gemini.google.com' : new URL(urls[surface]).hostname))
  }
  if (!hosts.size) return results
  const resolved = { ...results }
  for (const surface of surfaces) {
    const r = results[surface]
    const host = traceHosts[surface]
    if (!host || r.providerRegion || r.httpStatus !== 403 || (r.state !== 'challenge' && r.state !== 'unknown')) continue
    if (![...hosts].some(h => h !== host)) continue
    const restricted = restrictedRegions[surface].has(exitRegion)
    if (restricted || r.state === 'challenge') resolved[surface] = {
      ...r, state: restricted ? 'region_restricted' : 'degraded_challenge', evidence: 'exit_region_fallback', needsReview: false,
    }
  }
  return resolved
}
export async function inspectPlatforms(outlet: Outlet, exitRegion: string | null, signal: AbortSignal): Promise<AiResults> {
  const client = new Impit({ browser: 'chrome', proxyUrl: 'http://probe:' + outlet.password + '@127.0.0.1:' + outlet.port,
    timeout: 8000, followRedirects: false })
  const results = {} as AiResults
  const regions = new Map<string, Promise<string | null>>()
  // Retry a transport failure once. HTTP denials and challenges are final observations.
  async function request(url: string, trace = false, init?: ImpitRequestInit) {
    for (let attempt = 0; ; attempt++) {
      try { return await observe(client, url, signal, trace ? (attempt === 0 ? 5000 : 3000) : 8000, init) }
      catch (e) {
        signal.throwIfAborted()
        const transient = e instanceof Error && (/^(?:ReadError|CloseError|NetworkError)$/.test(e.name) ||
          /timeout|timed out|ECONNRESET|connection reset|socket hang up|unexpected eof/i.test(e.name + ' ' + e.message))
        if (attempt || !transient) return null
      }
    }
  }
  async function inspectOpenAi(surface: 'chatgptWeb' | 'chatgptApp') {
    const host = traceHosts[surface]
    if (host && !regions.has(host)) {
      regions.set(host, request('https://' + host + '/cdn-cgi/trace', true).then(trace =>
        trace?.status === 200 ? countryCode(/^loc=([A-Z]{2})\s*$/m.exec(trace.body)?.[1]) : null))
    }
    const region = host ? await regions.get(host) : null
    results[surface] = classify(surface, await request(urls[surface]), exitRegion, region)
  }
  async function fetchGemini() {
    let observation = await request(urls.gemini, false, { headers: googleHeaders })
    if (observation && !observation.challenge) {
      const next = redirectTarget(observation, urls.gemini)
      if (next?.origin === 'https://gemini.google.com' && /^\/app\/?$/.test(next.pathname)) {
        observation = await request(next.href, false, { headers: googleHeaders })
      }
    }
    return observation
  }
  await Promise.all([inspectOpenAi('chatgptWeb'), inspectOpenAi('chatgptApp')])
  const [geminiObs, antigravityObs] = await Promise.all([
    fetchGemini(),
    request(urls.antigravity),
  ])
  const initialGoogleRegion = geminiObs ? googleRegion(geminiObs.body) : null
  const geminiRedirect = geminiObs ? redirectTarget(geminiObs, urls.gemini) : null
  const geminiBlocked = geminiObs ? (
    geminiObs.challenge
    || geminiObs.status === 429
    || geminiObs.status === 451
    || Boolean(geminiRedirect && ['www.google.com', 'gemini.google.com', 'google.com'].includes(geminiRedirect.hostname) && /^\/sorry(?:\/|$)/.test(geminiRedirect.pathname))
    || /unusual traffic from your computer|g-recaptcha|\/sorry\/(?:index|image)|not a robot/i.test(geminiObs.body)
  ) : false
  const needBatchRegion = Boolean(
    geminiObs
    && !initialGoogleRegion
    && !geminiBlocked
    && (geminiObs.status === 200 || geminiRedirect?.hostname === 'consent.google.com' || antigravityObs?.status === 200),
  )
  const [batchObs, gatewayObs] = await Promise.all([
    needBatchRegion
      ? request(googleBatchExecuteUrl, false, {
          method: 'POST',
          headers: { ...googleHeaders, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: googleBatchExecuteBody,
        })
      : Promise.resolve(null),
    request(antigravityGatewayUrl),
  ])
  const googleProviderRegion = initialGoogleRegion ?? (batchObs ? googleRegion(batchObs.body) : null)
  results.gemini = classify('gemini', geminiObs, exitRegion, googleProviderRegion)
  results.antigravity = classify('antigravity', antigravityObs && gatewayObs ? antigravityObs : null, exitRegion, antigravityObs && gatewayObs ? googleProviderRegion : null)
  return applyExitRegionFallback(results, exitRegion, await Promise.all(regions.values()))
}
