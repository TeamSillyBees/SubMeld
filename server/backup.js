import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { isCatalogRuleSet, publicRuleProvider } from '../shared/rule-sets.js'
import { configHasSubscriptionSecret, connectionFrom, safeYaml } from './parse.js'
import { subscriptionSecrets } from './remote.js'
import { draft, id, library, read, url, UserError } from './schema.js'

const HEADER = 'SubMeld.Backup/1'
const passwordSchema = z.string().min(10).max(256)
const maxSize = 128 * 1024 * 1024
const profileSchema = z.object({
  id, title: z.string().min(1).max(64), draft, revision: z.number().int().positive(),
  publishedRevision: z.number().int().positive().nullable(), active: z.number().int().positive().nullable(),
  renewalNotices: z.array(z.object({ id, date: z.iso.date(), expire: z.number().int().positive().nullable() })).optional(),
})
const counter = z.number().int().nonnegative()
const subscriptionInfoSchema = z.object({
  upload: counter.optional(), download: counter.optional(), total: counter.optional(),
  expire: counter.max(253402300799).optional(), updatedAt: z.iso.datetime(),
})
const topLevel = new Set(['mixed-port', 'port', 'socks-port', 'external-controller', 'hosts', 'mode', 'log-level', 'ipv6', 'allow-lan', 'tcp-concurrent', 'unified-delay', 'find-process-mode', 'dns', 'sniffer', 'profile', 'proxies', 'proxy-groups', 'rule-providers', 'rules'])

export function exportBackup(store, passphrase) {
  const password = read(passwordSchema, passphrase)
  const documents = store.all().filter(([space]) => space !== 'auth').map(([space, key, data]) => [
    space, key, space === 'profiles' ? { ...data, token: null, revoked: true } : data,
  ])
  const plaintext = Buffer.from(JSON.stringify({ documents }))
  if (plaintext.length > maxSize) throw new UserError('数据已超过备份文件大小上限，请通过数据目录执行离线备份。', 413)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv)
  cipher.setAAD(Buffer.from(HEADER))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    type: HEADER, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64'),
  }
}

function decrypt(backup, passphrase) {
  const password = read(passwordSchema, passphrase)
  try {
    if (backup?.type !== HEADER || typeof backup.data !== 'string' || backup.data.length > maxSize * 1.34) throw new Error()
    const salt = Buffer.from(backup.salt, 'base64')
    const iv = Buffer.from(backup.iv, 'base64')
    const tag = Buffer.from(backup.tag, 'base64')
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error()
    const decoder = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv)
    decoder.setAAD(Buffer.from(HEADER))
    decoder.setAuthTag(tag)
    const result = Buffer.concat([decoder.update(Buffer.from(backup.data, 'base64')), decoder.final()])
    return JSON.parse(result.toString('utf8')).documents
  } catch {
    throw new UserError('备份无法解密，请核对备份文件与口令。')
  }
}

function validateVersion(version, secrets) {
  if (!version || !Number.isInteger(version.seq) || version.seq < 1 || typeof version.yaml !== 'string'
    || !Array.isArray(version.view?.nodes) || !Array.isArray(version.view?.rules)
    || !Array.isArray(version.view?.groups) || !version.counts) throw new Error()
  const config = safeYaml(version.yaml)
  if (!config || Object.keys(config).some(key => !topLevel.has(key))
    || !Array.isArray(config.proxies) || !Array.isArray(config['proxy-groups']) || !Array.isArray(config.rules)
    || configHasSubscriptionSecret(config, secrets)) throw new Error()
  for (const node of config.proxies) connectionFrom(node)
  if (config['external-controller'] !== undefined && !/^127\.0\.0\.1:\d{1,5}$/.test(config['external-controller'])) throw new Error()
  version.recipe = read(draft, version.recipe)
  for (const key of ['profile', 'sniffer']) if (!isDeepStrictEqual(config[key], version.recipe.base.advanced?.[key])) throw new Error()
  const aliases = new Map(version.recipe.services.filter(service => service.ruleSetAlias).map(service => [service.ruleSetAlias, service.ruleSet]))
  for (const [key, ruleSet] of Object.entries(config['rule-providers'] ?? {})) {
    if (isCatalogRuleSet(key) && isDeepStrictEqual(ruleSet, publicRuleProvider(key))) continue
    if (isCatalogRuleSet(aliases.get(key)) && isDeepStrictEqual(ruleSet, publicRuleProvider(aliases.get(key), key))) continue
    if (ruleSet.type !== 'inline' || !Array.isArray(ruleSet.payload) || Object.keys(ruleSet).some(key => !['type', 'behavior', 'payload'].includes(key))) throw new Error()
  }
}

export async function restoreBackup(workspace, backup, passphrase, verify) {
  const documents = decrypt(backup, passphrase)
  try {
    if (!Array.isArray(documents)) throw new Error()
    const profiles = new Map()
    const active = new Map()
    const visited = new Set()
    const savedUrls = documents.find(([space, key]) => space === 'system' && key === 'sourceUrls')?.[2] ?? []
    const secrets = subscriptionSecrets(read(z.array(url), savedUrls))
    for (const [space, key, data] of documents) {
      if (space !== 'profiles') continue
      const profile = read(profileSchema, data)
      if (profile.id !== key || profiles.has(key)) throw new Error()
      profiles.set(key, {
        ...profile, revision: profile.revision + 1,
        publishedRevision: profile.publishedRevision === profile.revision ? profile.revision + 1 : null,
        token: null, revoked: true, readThrough: null,
      })
    }
    if (!profiles.size || profiles.size > 30) throw new Error()
    const restored = documents.map(([space, key, data]) => {
      if (typeof space !== 'string' || typeof key !== 'string' || visited.has(space + '\n' + key)) throw new Error()
      visited.add(space + '\n' + key)
      if (space === 'profiles') return [space, key, profiles.get(key)]
      if (space === 'system' && key === 'library') return [space, key, read(library, data)]
      if (space === 'system' && key === 'sourceUrls') return [space, key, savedUrls]
      const [section, profileId, extra] = space.split('/')
      if (!profiles.has(profileId) || extra || !['datasets', 'notes', 'versions', 'updates'].includes(section)) throw new Error()
      if (section === 'versions') {
        validateVersion(data, secrets)
        if (key !== String(data.seq).padStart(12, '0')) throw new Error()
        if (profiles.get(profileId).active === data.seq) active.set(profileId, data)
      }
      if (!data || typeof data !== 'object') throw new Error()
      if (section === 'datasets' && data.subscriptionInfo != null) {
        data.subscriptionInfo = read(subscriptionInfoSchema, data.subscriptionInfo)
      }
      return [space, key, data]
    })
    for (const profile of profiles.values()) {
      if (!profile.active) continue
      const version = active.get(profile.id)
      if (!version) throw new Error()
      if (await verify(version.yaml, version.view)) throw new UserError('备份中的当前版本未通过 Mihomo 校验，恢复已取消。', 422)
    }
    return workspace.replaceDocuments(restored)
  } catch (error) {
    if (error instanceof UserError && error.status === 422) throw error
    throw new UserError('备份内容不完整或格式不兼容，当前配置未更改。')
  }
}
