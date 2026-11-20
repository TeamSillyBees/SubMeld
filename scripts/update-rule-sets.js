import { writeFile } from 'node:fs/promises'

// Read the geo subtree directly. The recursive repository tree is truncated by GitHub.
const api = 'https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees/'
async function tree(ref) {
  const response = await fetch(api + ref, { headers: { 'User-Agent': 'SubMeld' } })
  if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status)
  const result = await response.json()
  if (result.truncated) throw new Error('Incomplete MetaCubeX directory')
  return result
}
const root = await tree('meta')
const geo = root.tree.find(entry => entry.type === 'tree' && entry.path === 'geo')
const entries = (await tree(geo.sha + '?recursive=1')).tree
const catalog = { revision: root.sha }
for (const kind of ['geosite', 'geoip']) {
  const prefix = kind + '/'
  const names = entries.filter(entry => entry.type === 'blob' && entry.path.startsWith(prefix))
    .map(entry => entry.path.slice(prefix.length))
    .filter(name => /^[a-z0-9][a-z0-9_.@!+-]*\.mrs$/i.test(name))
    .map(name => name.slice(0, -4)).sort()
  if (!names.length) throw new Error('Empty ' + kind + ' directory')
  catalog[kind] = names
}
await writeFile(new URL('../shared/meta-rule-sets.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n')
console.log(catalog.geosite.length + ' GeoSite, ' + catalog.geoip.length + ' GeoIP')
