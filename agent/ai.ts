import { Impit } from 'impit'
import { surfaces, type AiReading, type AiResults, type Surface } from '../shared/quality.ts'
import type { Outlet } from './core.ts'

const urls: Record<Surface, string> = {
  chatgptWeb: 'https://chatgpt.com/', chatgptApp: 'https://android.chat.openai.com/',
  gemini: 'https://gemini.google.com/', claudeWeb: 'https://claude.ai/',
  claudeApi: 'https://api.anthropic.com/v1/models', grok: 'https://grok.com/',
}
export interface Observation { status: number; body: string; location: string; challenge: boolean }
export function classify(surface: Surface, response: Observation | null): AiReading {
  const status = response?.status ?? null
  const reading = (state: AiReading['state'], evidence: AiReading['evidence'], needsReview = true): AiReading =>
    ({ state, evidence, needsReview, httpStatus: status, providerRegion: null })
  if (!response) return reading('network_error', 'network')
  const { body, location, challenge } = response
  let redirect: URL | undefined
  if (response.status >= 300 && response.status < 400 && location) {
    try { redirect = new URL(location, urls[surface]) } catch { /* unrecognized redirect */ }
  }
  if (challenge || /<title>\s*just a moment(?:\.{3}|…)/i.test(body) && /challenge-platform|_cf_chl_opt/i.test(body)) return reading('challenge', 'cf_challenge')
  if (status === 429) return reading('rate_limited', 'rate_limit')
  const regionPage = redirect && ['chatgpt.com', 'claude.ai', 'www.anthropic.com', 'grok.com', 'gemini.google.com'].includes(redirect.hostname)
    && /\/(?:unsupported-country|unavailable-region|unsupported-region)(?:\/|$)/i.test(redirect.pathname)
  // Ignore translation dictionaries and other inactive text embedded in product page scripts.
  const visible = body.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  if (status === 451 || regionPage || /\bunsupported_country(?:_region_territory)?\b|(?:not (?:yet )?available|not supported|unavailable) in (?:your|this) (?:country|region|location)|country, region, or territory not supported|blocked your country|error (?:code:? )?1009\b/i.test(visible)) {
    return reading('region_restricted', 'region_denied', false)
  }
  if (status === 403 && /(?:your|this) IP (?:address )?(?:has been|is) (?:banned|blocked)|(?:banned|blocked) your IP|error (?:code:? )?100[678]\b/i.test(visible)) return reading('ip_blocked', 'ip_denied', false)
  if (status === 401 && /authentication_error|invalid.authentication|missing.{0,16}(?:api.key|token)|unauthorized/i.test(body)) return reading('authentication', 'credentials_required')
  if (redirect && ['accounts.google.com', 'auth.openai.com', 'auth.anthropic.com', 'accounts.x.ai', new URL(urls[surface]).hostname].includes(redirect.hostname)
      && /login|sign[-_]?in|oauth|authorize|servicelogin/i.test(redirect.pathname)) return reading('authentication', 'login_redirect')
  // Public product entry pages are observable. A generic success page, API root or app gateway is inconclusive.
  const brand = { chatgptWeb: 'ChatGPT', gemini: 'Gemini', claudeWeb: 'Claude', grok: 'Grok' }
  if (status === 200 && surface in brand) {
    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(body)?.[1] ?? ''
    if (/access denied|forbidden|unavailable|blocked/i.test(title)) return reading('unknown', 'unrecognized')
    if (title.toLowerCase().includes(brand[surface as keyof typeof brand].toLowerCase())) return reading('reachable', 'web_entry', false)
  }
  return reading('unknown', 'unrecognized')
}
export function googleRegion(body: string) {
  return /"(?:INNERTUBE_CONTEXT_GL|GL)"\s*:\s*"([A-Z]{2})"/.exec(body)?.[1]
    ?? /"INNERTUBE_CONTEXT"\s*:\s*\{\s*"client"\s*:\s*\{[^}]{0,1200}?"gl"\s*:\s*"([A-Z]{2})"/.exec(body)?.[1] ?? null
}
export function verifyGemini(reading: AiReading, exitRegion: string | null, providerRegion: string | null): AiReading {
  if (!providerRegion || !exitRegion) return { ...reading, state: 'unknown', evidence: 'region_unconfirmed', providerRegion, needsReview: true }
  if (providerRegion !== exitRegion || providerRegion === 'CN') return {
    ...reading, state: providerRegion !== exitRegion ? 'region_mismatch' : 'unknown',
    evidence: providerRegion !== exitRegion ? 'region_disagrees' : 'region_unconfirmed', providerRegion, needsReview: true,
  }
  return { ...reading, providerRegion }
}
async function observe(client: Impit, url: string, signal: AbortSignal): Promise<Observation | null> {
  const limit = 256 * 1024
  const controller = new AbortController()
  const active = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(8000)])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const res = await client.fetch(url, { signal: active, headers: url === urls.claudeApi ? { 'anthropic-version': '2023-06-01' } : undefined })
    const head = { status: res.status, body: '', location: res.headers.get('location') ?? '', challenge: res.headers.get('cf-mitigated') === 'challenge' }
    reader = res.body?.getReader()
    if (head.challenge || res.status === 429 || res.status === 451 || res.status >= 300 && res.status < 400 || !reader) return head
    const chunks: Buffer[] = []
    let size = 0
    while (size < limit) {
      const { value, done } = await reader.read()
      if (done) break
      const part = Buffer.from(value.subarray(0, limit - size))
      chunks.push(part)
      size += part.length
    }
    return { ...head, body: Buffer.concat(chunks).toString('utf8') }
  } catch { signal.throwIfAborted(); return null }
  finally { controller.abort(); await reader?.cancel().catch(() => {}) }
}
export async function inspectPlatforms(outlet: Outlet, exitRegion: string | null, signal: AbortSignal): Promise<AiResults> {
  const client = new Impit({ browser: 'chrome', proxyUrl: 'http://probe:' + outlet.password + '@127.0.0.1:' + outlet.port,
    timeout: 8000, followRedirects: false })
  const results = {} as AiResults
  // Three requests per exit at once. All pages are anonymous and redirects are only inspected.
  for (let i = 0; i < surfaces.length; i += 3) await Promise.all(surfaces.slice(i, i + 3).map(async surface => {
    const observation = await observe(client, urls[surface], signal)
    let reading = classify(surface, observation)
    if (surface === 'gemini' && (reading.state === 'reachable' || reading.state === 'authentication')) {
      const regionPage = await observe(client, 'https://www.youtube.com/', signal)
      const region = regionPage?.status === 200 && !regionPage.challenge ? googleRegion(regionPage.body) : null
      reading = verifyGemini(reading, exitRegion, region)
    }
    results[surface] = reading
  }))
  return results
}
