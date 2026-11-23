import type { Base, Draft, Filter, Group } from './model.ts'

export const regions: [string, string, string, string][] = [
  ['HK', '香港', '🇭🇰', '香港|hong[ _-]?kong|hk|hkg'],
  ['TW', '台湾', '🇹🇼', '台湾|台灣|台北|taiwan|taipei|tw|twn'],
  ['MO', '澳门', '🇲🇴', '澳门|澳門|macau|macao|mo'],
  ['JP', '日本', '🇯🇵', '日本|东京|東京|大阪|埼玉|japan|tokyo|osaka|jp|jpn|nrt'],
  ['SG', '新加坡', '🇸🇬', '新加坡|狮城|singapore|sg|sgp'],
  ['KR', '韩国', '🇰🇷', '韩国|韓國|首尔|首爾|korea|seoul|kr|kor'],
  ['US', '美国', '🇺🇸', '美国|美國|洛杉矶|西雅图|纽约|united[ _-]?states|los[ _-]?angeles|seattle|usa|us|lax'],
  ['GB', '英国', '🇬🇧', '英国|英國|伦敦|倫敦|united[ _-]?kingdom|london|gbr|uk|gb'],
  ['DE', '德国', '🇩🇪', '德国|德國|法兰克福|germany|frankfurt|deu|de'],
  ['FR', '法国', '🇫🇷', '法国|法國|巴黎|france|paris|fra|fr'],
  ['CA', '加拿大', '🇨🇦', '加拿大|多伦多|toronto|canada|can|ca'],
  ['AU', '澳大利亚', '🇦🇺', '澳大利亚|澳洲|悉尼|australia|sydney|au|aus'],
  ['NL', '荷兰', '🇳🇱', '荷兰|荷蘭|阿姆斯特丹|netherlands|amsterdam|nl'],
  ['IN', '印度', '🇮🇳', '印度(?!尼西亚)|孟买|india|mumbai|ind'],
  ['ID', '印度尼西亚', '🇮🇩', '印度尼西亚|印尼|indonesia|jakarta|idn'],
  ['MY', '马来西亚', '🇲🇾', '马来西亚|馬來西亞|malaysia|my|mys'],
  ['TH', '泰国', '🇹🇭', '泰国|泰國|bangkok|thailand|th|tha'],
  ['VN', '越南', '🇻🇳', '越南|vietnam|vn|vnm'],
  ['PH', '菲律宾', '🇵🇭', '菲律宾|菲律賓|philippines|ph|phl'],
  ['RU', '俄罗斯', '🇷🇺', '俄罗斯|俄羅斯|莫斯科|moscow|russia|ru|rus'],
  ['TR', '土耳其', '🇹🇷', '土耳其|turkey|istanbul|tr|tur'],
  ['BR', '巴西', '🇧🇷', '巴西|brazil|br|bra'],
  ['CH', '瑞士', '🇨🇭', '瑞士|switzerland|zurich|ch|che'],
  ['SE', '瑞典', '🇸🇪', '瑞典|sweden|stockholm|se|swe'],
  ['AE', '阿联酋', '🇦🇪', '阿联酋|迪拜|dubai|uae|ae'],
  ['CN', '中国大陆', '🇨🇳', '中国大陆|中國大陸|上海|北京|深圳|广州|china|shanghai|beijing|cn|chn'],
  ['unknown', '未知地区', '', ''],
]

const aliases = regions.slice(0, -1).map(([code, , flag, words]) => ({
  code, flag, regex: new RegExp(words.split('|').map(word => /^[a-z]/.test(word)
    ? '(?<![a-z])(?:' + word + ')(?![a-z])'
    : word).join('|'), 'i'),
}))

export function identifyRegion(name: string) {
  const flag = aliases.find(region => name.includes(region.flag))
  if (flag) return flag.code
  const matches = aliases.filter(region => region.regex.test(name))
  return matches.length === 1 ? matches[0].code : 'unknown'
}

export function regionLabel(code: string) {
  return regions.find(([id]) => id === code)?.[1] ?? '未知地区'
}

export const commonKeywords = ['免费', '试用', '剩余流量', '流量重置', '到期', '官网', '套餐', 'Free', 'Trial']
export const builtins: Record<string, string> = { DIRECT: '直连', REJECT: '拒绝', 'REJECT-DROP': '静默丢弃' }
export const reservedNames = new Set([...Object.keys(builtins), 'GLOBAL', 'COMPATIBLE', 'PASS'])
export const groupTypes = {
  select: ['手动选择', '手动指定要使用的组内代理。'],
  'url-test': ['自动选择', '根据健康检查的延迟和切换容差选择代理。'],
  fallback: ['自动回退', '按列表顺序使用第一个可用代理。'],
  'load-balance': ['负载均衡', '按分配策略将连接分配给组内代理。'],
}
export const ruleTypes: Record<string, [string, string, string]> = {
  DOMAIN: ['完整域名', '仅匹配填写的域名，如 api.github.com。', 'api.github.com'],
  'DOMAIN-SUFFIX': ['域名后缀', '匹配域名本身和子域名，如 github.com。', 'github.com'],
  'DOMAIN-KEYWORD': ['域名关键字', '域名中包含指定文本，如 github。', 'github'],
  'IP-CIDR': ['IPv4 网段', '匹配目标 IPv4 地址段。', '192.168.0.0/16'],
  'IP-CIDR6': ['IPv6 网段', '匹配目标 IPv6 地址段。', '2001:db8::/32'],
  'DST-PORT': ['目标端口', '匹配连接的目标端口，可填写 1 到 65535。', '443'],
  'PROCESS-NAME': ['进程名', '依赖客户端的进程识别。', 'example.exe'],
  'PROCESS-PATH': ['进程路径', '匹配客户端本机程序的完整路径。', 'C:/Apps/example.exe'],
  GEOIP: ['IP 归属地', '按 GeoIP 数据库匹配目标 IP 的归属地。', 'CN'],
  GEOSITE: ['域名集合', '匹配指定 GeoSite 分类中的域名。', 'cn'],
  'RULE-SET': ['规则集', '匹配所引用规则集中的条目。', ''],
  MATCH: ['匹配所有请求', '通常放在规则列表末尾，处理先前规则未匹配的请求。', ''],
}

export const servicePresets = [
  { id: 'google', version: 1, name: 'Google', category: '搜索', domains: ['google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com'] },
  { id: 'gemini', version: 1, name: 'Gemini', category: 'AI', domains: ['gemini.google.com', 'generativelanguage.googleapis.com', 'ai.google.dev', 'aistudio.google.com'] },
  { id: 'openai', version: 1, name: 'OpenAI', category: 'AI', domains: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com'] },
  { id: 'github', version: 1, name: 'GitHub', category: '开发', domains: ['github.com', 'githubusercontent.com', 'githubassets.com', 'github.io'] },
  { id: 'youtube', version: 1, name: 'YouTube', category: '流媒体', domains: ['youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com'] },
  { id: 'netflix', version: 1, name: 'Netflix', category: '流媒体', domains: ['netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net'] },
]

export const standardGroups: Pick<Group, 'name' | 'type' | 'members'>[] = [
  { name: '手动选择', type: 'select', members: [{ kind: 'pool', sourceId: '', regions: [] }, { kind: 'builtin', id: 'DIRECT' }] },
  { name: '自动选择', type: 'url-test', members: [{ kind: 'pool', sourceId: '', regions: [] }] },
]

export const regionalAutoGroups: (Pick<Group, 'name' | 'type'> & { members: Extract<Group['members'][number], { kind: 'pool' }>[] })[] = ['HK', 'JP', 'SG', 'US'].map(region => ({
  name: regionLabel(region) + '自动选择',
  type: 'url-test',
  members: [{ kind: 'pool', sourceIds: [], regions: [region] }],
}))

export const defaultFilter: Filter = { keep: [], exclude: [], keywords: [], manual: [], unknown: 'auto' }
export const defaultBase: Base = {
  mode: 'rule', logLevel: 'info', port: 7890, ipv6: false, allowLan: false,
  concurrent: false, unifiedDelay: false, findProcess: 'strict',
  dns: {
    enabled: false, mode: 'fake-ip', nameservers: ['https://dns.alidns.com/dns-query'],
    bootstrap: ['223.5.5.5', '119.29.29.29'], proxyNameservers: [], fakeIPFilter: ['*.lan', '*.local'],
    respectRules: false, useHosts: true, fallback: [],
  },
}
export const dnsPresets: Record<string, Base['dns']> = {
  default: { ...defaultBase.dns },
  encrypted: { ...defaultBase.dns, enabled: true, mode: 'fake-ip' },
  real: { ...defaultBase.dns, enabled: true, mode: 'redir-host', nameservers: ['223.5.5.5', '119.29.29.29'] },
}

export function blankDraft(): Draft {
  return { sources: [], groups: [], services: [], rules: [], base: structuredClone(defaultBase) }
}
