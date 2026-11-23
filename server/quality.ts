import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'
import type { Profile } from '../shared/model.ts'
import {
  maxQualityNodes, progressSchema, qualityConfig, qualityKey, reportSchema,
  type Assignment, type DevicePairing, type ProbeDevice, type Pairing, type QualityJob, type QualityNode, type QualityReport,
} from '../shared/quality.ts'
import { aiSkipReason, secureProbeOrigin } from '../shared/quality-options.ts'
import { id, read, UserError } from './schema.ts'

const waitingMs = 15 * 60_000
const queueMs = 24 * 60 * 60_000
const leaseMs = 2 * 60_000
const historyLimit = 12
const keySchema = z.array(qualityKey).min(1).max(maxQualityNodes)
const opaque = /^[\w-]{43}$/
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (digest: string | null, input: string) => digest !== null && opaque.test(input) && timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(hash(input), 'hex'))
const date = (ms: number) => new Date(ms).toISOString()
export const qualitySpaces = (profileId: string) => ({
  devices: `quality-devices/${profileId}` as const,
  device: `quality-device/${profileId}` as const,
  jobs: `quality-jobs/${profileId}` as const,
  inputs: `quality-inputs/${profileId}` as const,
  reports: `quality-reports/${profileId}` as const,
})
export interface StoredDevice extends Omit<ProbeDevice, 'status'> { secretHash: string }
export interface LegacyDevice { name: string; platform: StoredDevice['platform']; lastSeen: string; secretHash: string }
export interface StoredInvite { ticketHash: string; expiresAt: string }
export interface StoredQualityJob extends QualityJob {
  resident?: boolean; ticketHash: string | null; workerHash: string | null; labels: Pick<QualityNode, 'key' | 'name' | 'sourceName'>[]
}
function summary({ resident, ticketHash, workerHash, labels, ...job }: StoredQualityJob): QualityJob { return job }

export function createQualityService(store: Store, select: (profile: Profile, keys: Set<string>) => QualityNode[], now = Date.now) {
  function registry(profileId: string) {
    const spaces = qualitySpaces(profileId)
    const old = store.get(spaces.device, 'registration')
    if (old) store.transaction(() => {
      const id = randomUUID()
      store.set(spaces.devices, id, { id, name: old.name, remark: '', platform: old.platform, lastSeenAt: old.lastSeen, secretHash: old.secretHash })
      for (const [key, job] of store.list(spaces.jobs)) if (job.resident && job.status === 'running' && !job.targetDeviceId) {
        store.set(spaces.jobs, key, { ...job, targetDeviceId: id, targetDeviceName: old.name })
      }
      store.remove(spaces.device, 'registration')
      store.remove(spaces.device, 'next')
    })
    return store.list(spaces.devices).map(([, value]) => value)
  }
  function deviceFor(profileId: string, id: unknown) {
    const selected = read(z.uuid(), id)
    const device = registry(profileId).find(d => d.id === selected)
    if (!device) throw new UserError('所选探针已解除配对。', 404)
    return device
  }
  function devices(profileId: string): ProbeDevice[] {
    const records = registry(profileId)
    const busy = new Set(list(profileId).filter(j => j.status === 'running').map(j => j.targetDeviceId))
    return records.map(({ secretHash, ...d }) => ({ ...d, status: now() - Date.parse(d.lastSeenAt) >= 90_000 ? 'offline' : busy.has(d.id) ? 'busy' : 'online' }))
  }
  function finish(profileId: string, job: StoredQualityJob, status: QualityJob['status'], failure: QualityJob['failure'] = null) {
    const spaces = qualitySpaces(profileId)
    job.status = status
    job.finishedAt = date(now())
    job.ticketHash = null
    job.failure = failure
    if (store.get(spaces.device, 'next') === job.id) store.remove(spaces.device, 'next')
    if (status !== 'completed') job.workerHash = null
    store.remove(spaces.inputs, job.id)
    store.set(spaces.jobs, job.id, job)
  }
  function checkExpiry(profileId: string, job: StoredQualityJob) {
    if ((job.status === 'running' || job.status === 'waiting') && Date.parse(job.expiresAt) <= now()) {
      store.transaction(() => finish(profileId, job, job.status === 'waiting' ? 'expired' : 'failed', job.status === 'running' ? 'disconnected' : null))
    }
    return job
  }
  function list(profileId: string) {
    return store.list(qualitySpaces(profileId).jobs).map(([, job]) => summary(checkExpiry(profileId, job)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  function find(profileId: string, jobId: unknown) {
    const job = store.get(qualitySpaces(profileId).jobs, read(z.uuid(), jobId))
    if (!job) throw new UserError('找不到这次检测任务。', 404)
    return checkExpiry(profileId, job)
  }
  function issue(profileId: string, job: StoredQualityJob, origin: string): Pairing {
    if (!secureProbeOrigin(new URL(origin))) throw new UserError('远程探针需要 HTTPS，请使用 HTTPS 管理地址或配置 SUBMELD_PUBLIC_URL。本机可用 localhost。', 422)
    const ticket = randomBytes(32).toString('base64url')
    job.ticketHash = hash(ticket)
    job.expiresAt = date(now() + waitingMs)
    store.set(qualitySpaces(profileId).jobs, job.id, job)
    return { job: summary(job), pairing: origin + '/#' + profileId + '.' + job.id + '.' + ticket }
  }
  function queue(profile: Profile, body: Record<string, unknown>) {
    const target = deviceFor(profile.id, body.targetDeviceId)
    const keys = new Set(read(keySchema, body.keys))
    const config = read(qualityConfig, body.config)
    const history = list(profile.id)
    if (history.some(job => job.targetDeviceId === target.id && (job.status === 'waiting' || job.status === 'running'))) throw new UserError('这台探针已有检测任务，请先完成或取消。', 409)
    const nodes = select(profile, keys)
    if (keys.size !== nodes.length) throw new UserError('部分节点已更新，请刷新节点列表后重新选择。', 409)
    if (Buffer.byteLength(JSON.stringify(nodes)) > 8 * 1024 ** 2) throw new UserError('节点配置较大，请分批检测。', 413)
    const job: StoredQualityJob = {
      id: randomUUID(), createdAt: date(now()), finishedAt: null, expiresAt: date(now() + queueMs), status: 'waiting',
      targetDeviceId: target.id, targetDeviceName: target.remark || target.name,
      config, total: nodes.length, progress: { stage: 'starting', done: 0, total: nodes.length }, available: null,
      failure: null, ticketHash: null, workerHash: null, labels: nodes.map(({ key, name, sourceName }) => ({ key, name, sourceName })),
    }
    const spaces = qualitySpaces(profile.id)
    return store.transaction(() => {
      for (const old of history.filter(j => j.status !== 'waiting' && j.status !== 'running').slice(historyLimit - 1)) for (const space of [spaces.jobs, spaces.inputs, spaces.reports]) store.remove(space, old.id)
      store.set(spaces.inputs, job.id, nodes)
      store.set(spaces.jobs, job.id, job)
      return summary(job)
    })
  }
  function touch(space: `quality-devices/${string}`, device: StoredDevice | null) {
    if (device && now() - Date.parse(device.lastSeenAt) >= 15_000) store.set(space, device.id, { ...device, lastSeenAt: date(now()) })
  }
  function claim(profileId: string, job: StoredQualityJob, worker: string, resident: boolean): Assignment {
    const spaces = qualitySpaces(profileId)
    const nodes = store.get(spaces.inputs, job.id)
    if (!nodes) throw new UserError('此任务已领取。', 409)
    job.workerHash = hash(worker)
    job.resident = resident
    job.status = 'running'
    job.expiresAt = date(now() + leaseMs)
    if (resident) job.ticketHash = null
    store.set(spaces.jobs, job.id, job)
    return { schemaVersion: 1, jobId: job.id, createdAt: job.createdAt, config: job.config, nodes }
  }
  function revoke(profileId: string, id: unknown) {
    const device = deviceFor(profileId, id)
    const spaces = qualitySpaces(profileId)
    const jobs = list(profileId).filter(job => job.targetDeviceId === device.id && (job.status === 'running' || job.status === 'waiting'))
    return store.transaction(() => {
      for (const j of jobs) finish(profileId, store.get(spaces.jobs, j.id)!, 'cancelled')
      store.remove(spaces.devices, device.id)
      return { ok: true }
    })
  }
  return {
    list, devices, revoke, queue,
    rename(profileId: string, id: unknown, input: unknown) {
      const device = deviceFor(profileId, id)
      const remark = read(z.string().trim().max(80), input)
      store.set(qualitySpaces(profileId).devices, device.id, { ...device, remark })
      return { ok: true }
    },
    reassign(profileId: string, id: unknown, targetDeviceId: unknown) {
      const target = deviceFor(profileId, targetDeviceId)
      const job = find(profileId, id)
      if (job.status !== 'waiting') throw new UserError('只能改派等待中的任务。', 409)
      if (now() - Date.parse(target.lastSeenAt) >= 90_000 || list(profileId).some(j => j.id !== job.id && j.targetDeviceId === target.id && (j.status === 'waiting' || j.status === 'running'))) {
        throw new UserError('请选择在线且空闲的探针。', 409)
      }
      job.targetDeviceId = target.id
      job.targetDeviceName = target.remark || target.name
      job.ticketHash = null
      job.expiresAt = date(now() + queueMs)
      store.set(qualitySpaces(profileId).jobs, job.id, job)
      return summary(job)
    },
    clean() { for (const [profileId] of store.list('profiles')) list(profileId) },
    invite(profileId: string, origin: string): DevicePairing {
      if (!secureProbeOrigin(new URL(origin))) throw new UserError('远程配对需要 HTTPS，本机可使用 localhost。', 422)
      const space = qualitySpaces(profileId).device
      const ticket = randomBytes(32).toString('base64url')
      const expiresAt = date(now() + waitingMs)
      store.set(space, 'invite', { ticketHash: hash(ticket), expiresAt })
      return { pairing: origin + '/#device.' + profileId + '.' + ticket, expiresAt }
    },
    pair(profileId: string, jobId: unknown, origin: string) {
      const job = find(profileId, jobId)
      if (job.targetDeviceId || !job.ticketHash || job.status !== 'waiting') throw new UserError('此任务不支持一次性配对。', 409)
      return issue(profileId, job, origin)
    },
    cancel(profileId: string, jobId: unknown) {
      const job = find(profileId, jobId)
      if (job.status === 'waiting' || job.status === 'running') store.transaction(() => finish(profileId, job, 'cancelled'))
      return summary(job)
    },
    report(profileId: string, jobId: unknown): QualityReport {
      const job = find(profileId, jobId)
      const report = store.get(qualitySpaces(profileId).reports, job.id)
      if (!report) throw new UserError('此任务尚无完成报告。', 404)
      return report
    },
    agent(action: string, bearer: string, body: Record<string, unknown>) {
      const profileId = read(id, body.profileId)
      const spaces = qualitySpaces(profileId)
      if (action === 'enroll') {
        const secret = read(z.string().regex(opaque), body.secret)
        const name = read(z.string().trim().min(1).max(128), body.name)
        const platform = read(z.enum(['windows', 'linux']), body.platform)
        const existing = registry(profileId).find(d => same(d.secretHash, secret))
        if (existing) return { ok: true }
        const invite = store.get(spaces.device, 'invite')
        if (!invite || !same(invite.ticketHash, bearer) || Date.parse(invite.expiresAt) <= now()) throw new UserError('电脑配对链接已失效。', 403)
        const id = randomUUID()
        return store.transaction(() => {
          store.set(spaces.devices, id, { id, secretHash: hash(secret), name, remark: '', platform, lastSeenAt: date(now()) })
          store.remove(spaces.device, 'invite')
          return { ok: true }
        })
      }
      if (action === 'poll' || action === 'leave') {
        const device = registry(profileId).find(d => same(d.secretHash, bearer))
        if (!device) throw new UserError('这台电脑的配对已解除。', 403)
        if (action === 'leave') return revoke(profileId, device.id)
        const worker = read(z.string().regex(opaque), body.worker)
        touch(spaces.devices, device)
        for (const [, item] of store.list(spaces.jobs)) {
          if (item.targetDeviceId !== device.id || (item.status !== 'waiting' && item.status !== 'running')) continue
          const job = checkExpiry(profileId, item)
          if (job.status === 'waiting' || (job.status === 'running' && job.resident && same(job.workerHash, worker) && store.get(spaces.inputs, job.id))) {
            return claim(profileId, job, worker, true)
          }
        }
        return null
      }
      const job = find(profileId, body.jobId)
      if (action === 'claim') {
        const worker = read(z.string().regex(opaque), body.worker)
        if (job.targetDeviceId || !same(job.ticketHash, bearer)) throw new UserError('配对链接已失效。', 403)
        if (job.status !== 'waiting' && !(job.status === 'running' && same(job.workerHash, worker))) throw new UserError('此任务已由另一探针领取。', 409)
        return claim(profileId, job, worker, false)
      }
      if (!same(job.workerHash, bearer)) throw new UserError('探针会话已结束。', 403)
      if (action === 'complete' && job.status === 'completed') return { ok: true }
      if (job.status !== 'running') throw new UserError('任务已结束。', 409)
      if (action === 'progress') {
        const progress = read(progressSchema, body.progress)
        if (progress.total > job.total) throw new UserError('进度超过任务范围。')
        job.progress = progress
        job.expiresAt = date(now() + leaseMs)
        store.transaction(() => {
          store.remove(spaces.inputs, job.id)
          if (job.resident && job.targetDeviceId) touch(spaces.devices, store.get(spaces.devices, job.targetDeviceId))
          job.ticketHash = null
          store.set(spaces.jobs, job.id, job)
        })
      } else if (action === 'complete') {
        const report = read(reportSchema, body.report)
        const rows = new Map(report.results.map(row => [row.key, row]))
        if (report.jobId !== job.id || report.results.length !== job.total || !job.labels.every(({ key }) => rows.has(key))) {
          throw new UserError('结果与本次任务的节点不匹配。', 422)
        }
        for (const row of rows.values()) {
          const successes = row.samples.filter(sample => sample.httpsMs !== null).length
          if (row.available !== (successes > 0) || row.samples.length !== (row.error === 'invalid_node' || row.error === 'info_node' ? 0 : job.config.rounds)
            || Boolean(row.speed) !== (job.config.bandwidth && row.available)
            || (row.aiSkipped && (!job.config.ai || !row.available || row.aiSkipped !== aiSkipReason(row)))
            || Boolean(row.ai) !== (job.config.ai && row.available && !row.aiSkipped)
            || (row.speed && (row.speed.bytes > job.config.mebibytes * 1024 ** 2 || row.speed.elapsedMs > job.config.seconds * 1000 || row.speed.perSecondBps.length > job.config.seconds))) throw new UserError('结果超出本次检测配置。', 422)
        }
        store.transaction(() => {
          job.available = report.results.filter(row => row.available).length
          finish(profileId, job, 'completed')
          store.set(spaces.reports, job.id, {
            ...report, config: job.config, createdAt: job.createdAt, targetDeviceId: job.targetDeviceId ?? null, targetDeviceName: job.targetDeviceName ?? null,
            results: job.labels.map(label => ({ ...rows.get(label.key)!, ...label })),
          })
        })
      } else if (action === 'cancel') store.transaction(() => finish(profileId, job, 'cancelled'))
      else if (action === 'fail') store.transaction(() => finish(profileId, job, 'failed', 'probe_error'))
      else throw new UserError('未知的探针操作。', 404)
      return { ok: true }
    },
  }
}
