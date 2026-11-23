import type { Projection, ProviderData, ProviderMap } from '../shared/model.ts'
import { testDomain } from '../shared/config.ts'
import { isCatalogRuleSet, ruleSetUrl } from '../shared/rule-sets.ts'
import { download } from './remote.ts'

export type LoadRuleSetList = (key: string, timeout: number) => Promise<string>
async function fetchList(key: string, timeout: number) {
  const deadline = Date.now() + timeout
  const path = key.split('/').map(encodeURIComponent).join('/')
  const api = 'https://api.github.com/repos/MetaCubeX/meta-rules-dat/contents/geo/' + path + '.list?ref=meta'
  try {
    const { bytes } = await download(api, { accept: 'application/vnd.github.raw+json', timeout: Math.max(1, Math.floor(timeout / 2)) })
    return bytes.toString('utf8')
  } catch {
    // The public GitHub API can be rate-limited independently of the raw download.
    const { bytes } = await download(ruleSetUrl(key, 'list'), { timeout: Math.max(1, deadline - Date.now()) })
    return bytes.toString('utf8')
  }
}

// Mihomo consumes MRS. Its companion domain list lets the workspace preview
// the same set without sending the queried domain to a third party.
export function createRuleSetMatcher(loadList: LoadRuleSetList = fetchList) {
  const cache = new Map<string, { expires: number; result: Promise<ProviderData | null> }>()
  function contents(key: string, timeout: number) {
    const previous = cache.get(key)
    if (previous && previous.expires > Date.now()) return previous.result
    const result = Promise.resolve().then(() => loadList(key, timeout)).then(text => {
      const payload = text.split(/\r?\n/).map(line => line.trim().toLowerCase()).filter(line => line && !line.startsWith('#'))
      if (payload.length) return { behavior: 'domain' as const, payload }
      return null
    }).catch(() => null).then(data => {
      record.expires = Date.now() + (data ? 86400000 : 30000)
      return data
    })
    const record = { expires: Infinity, result }
    cache.delete(key)
    if (cache.size >= 32) cache.delete(cache.keys().next().value!)
    cache.set(key, record)
    return record.result
  }

  return async function match(projection: Pick<Projection, 'rules'>, domain: string, providers: ProviderMap, mode: string) {
    const data = { ...providers }
    let result = testDomain(projection, domain, data, mode)
    const candidates = (result.uncertain ?? []).filter(rule => {
      const key = rule.catalogKey ?? rule.value
      return rule.type === 'RULE-SET' && isCatalogRuleSet(key) && key.startsWith('geosite/')
    })
    const deadline = Date.now() + 8000
    for (let start = 0; start < candidates.length; start += 4) {
      const timeout = deadline - Date.now()
      if (timeout <= 0 || (result.match && candidates[start].position > result.match.position)) break
      await Promise.all(candidates.slice(start, start + 4).map(async rule => {
        data[rule.serviceId] = await contents(rule.catalogKey ?? rule.value, timeout)
      }))
      result = testDomain(projection, domain, data, mode)
    }
    return result
  }
}
