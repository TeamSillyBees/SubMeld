import catalog from './meta-rule-sets.json' with { type: 'json' }

export const ruleSetKeys = ['geosite', 'geoip'].flatMap(kind => catalog[kind].map(name => kind + '/' + name))
const known = new Set(ruleSetKeys)
export const isCatalogRuleSet = key => known.has(key)

export function ruleSetUrl(key, extension) {
  const [kind, name] = key.split('/')
  return 'https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/' + kind + '/' + encodeURIComponent(name) + '.' + extension
}

export function publicRuleProvider(key, alias) {
  return {
    type: 'http', behavior: key.startsWith('geoip/') ? 'ipcidr' : 'domain', format: 'mrs',
    url: ruleSetUrl(key, 'mrs'), path: (alias ? './ruleset/' + alias : './ruleset/metacubex/' + key) + '.mrs', interval: 86400,
  }
}
