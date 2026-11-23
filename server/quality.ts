import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'
import type { Profile } from '../shared/model.ts'
import {
  maxQualityNodes, progressSchema, qualityConfig, qualityKey, reportSchema,
  type Assignment, type DevicePairing, type ProbeDevice, type Pairing, type QualityJob, type QualityNode, type QualityReport,
} from '../shared/quality.ts'
import { secureProbeOrigin } from '../shared/quality-options.ts'
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
  device: `quality-device/${profileId}` as const,
  jobs: `quality-jobs/${profileId}` as const,
  inputs: `quality-inputs/${profileId}` as const,
  reports: `quality-reports/${profileId}` as const,
})
export interface StoredDevice extends Omit<ProbeDevice, 'online'> { secretHash: string }
export interface StoredInvite { ticketHash: string; expiresAt: string }
export interface StoredQualityJob extends QualityJob {
  resident?: boolean; ticketHash: string | null; workerHash: string | null; labels: Pick<QualityNode, 'key' | 'name' | 'sourceName'>[]
}
function summary({ resident, ticketHash, workerHash, labels, ...job }: StoredQualityJob): QualityJob { return job }

export function createQualityService(store: Store, select: (profile: Profile, keys: Set<string>) => QualityNode[], now = Date.now) {
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
  function schedule<T>(profile: Profile, body: Record<string, unknown>, dispatch: (job: StoredQualityJob) => T): T {
    const keys = new Set(read(keySchema, body.keys))
    const config = read(qualityConfig, body.config)
    const history = list(profile.id)
    if (history.some(job => job.status === 'waiting' || job.status === 'running')) throw new UserError('当前方案已有检测任务，请先完成或取消。', 409)
    const nodes = select(profile, keys)
    if (keys.size !== nodes.length) throw new UserError('部分节点已更新，请刷新节点列表后重新选择。', 409)
    if (Buffer.byteLength(JSON.stringify(nodes)) > 8 * 1024 ** 2) throw new UserError('节点配置较大，请分批检测。', 413)
    const job: StoredQualityJob = {
      id: randomUUID(), createdAt: date(now()), finishedAt: null, expiresAt: date(now() + queueMs), status: 'waiting',
      config, total: nodes.length, progress: { stage: 'starting', done: 0, total: nodes.length }, available: null,
      failure: null, ticketHash: null, workerHash: null, labels: nodes.map(({ key, name, sourceName }) => ({ key, name, sourceName })),
    }
    const spaces = qualitySpaces(profile.id)
    return store.transaction(() => {
      for (const old of history.slice(historyLimit - 1)) for (const space of [spaces.jobs, spaces.inputs, spaces.reports]) store.remove(space, old.id)
      store.set(spaces.inputs, job.id, nodes)
      store.set(spaces.device, 'next', job.id)
      return dispatch(job)
    })
  }
  function touch(space: `quality-device/${string}`, device: StoredDevice | null) {
    if (device && now() - Date.parse(device.lastSeen) >= 30_000) store.set(space, 'registration', { ...device, lastSeen: date(now()) })
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
  function revoke(profileId: string) {
    const spaces = qualitySpaces(profileId)
    const active = list(profileId).find(job => job.status === 'waiting' || job.status === 'running')
    const job = active && find(profileId, active.id)
    return store.transaction(() => {
      if (job && (job.resident || (job.status === 'waiting' && !job.ticketHash))) finish(profileId, job, 'cancelled')
      store.remove(spaces.device, 'registration')
      store.remove(spaces.device, 'invite')
      return { ok: true }
    })
  }
  return {
    list, revoke,
    clean() { for (const [profileId] of store.list('profiles')) list(profileId) },
    create: (profile: Profile, body: Record<string, unknown>, origin: string) => schedule(profile, body, job => issue(profile.id, job, origin)),
    queue: (profile: Profile, body: Record<string, unknown>) => schedule(profile, body, job => {
      store.set(qualitySpaces(profile.id).jobs, job.id, job)
      return summary(job)
    }),
    device(profileId: string): ProbeDevice | null {
      const record = store.get(qualitySpaces(profileId).device, 'registration')
      if (!record) return null
      const { secretHash, ...device } = record
      return { ...device, online: now() - Date.parse(device.lastSeen) < 90_000 }
    },
    invite(profileId: string, origin: string): DevicePairing {
      if (!secureProbeOrigin(new URL(origin))) throw new UserError('远程配对需要 HTTPS，本机可使用 localhost。', 422)
      const space = qualitySpaces(profileId).device
      if (store.get(space, 'registration')) throw new UserError('请先解除当前电脑的配对。', 409)
      const ticket = randomBytes(32).toString('base64url')
      const expiresAt = date(now() + waitingMs)
      store.set(space, 'invite', { ticketHash: hash(ticket), expiresAt })
      return { pairing: origin + '/#device.' + profileId + '.' + ticket, expiresAt }
    },
    pair(profileId: string, jobId: unknown, origin: string) {
      const job = find(profileId, jobId)
      if (job.status !== 'waiting') throw new UserError('此任务已结束或已被领取。', 409)
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
        const existing = store.get(spaces.device, 'registration')
        if (existing && same(existing.secretHash, secret)) return { ok: true }
        const invite = store.get(spaces.device, 'invite')
        if (existing || !invite || !same(invite.ticketHash, bearer) || Date.parse(invite.expiresAt) <= now()) throw new UserError('电脑配对链接已失效。', 403)
        const waiting = list(profileId).find(job => job.status === 'waiting')
        return store.transaction(() => {
          store.set(spaces.device, 'registration', { secretHash: hash(secret), name, platform, lastSeen: date(now()) })
          store.remove(spaces.device, 'invite')
          if (waiting) store.set(spaces.device, 'next', waiting.id)
          return { ok: true }
        })
      }
      if (action === 'poll' || action === 'leave') {
        const device = store.get(spaces.device, 'registration')
        if (!device || !same(device.secretHash, bearer)) throw new UserError('这台电脑的配对已解除。', 403)
        if (action === 'leave') return revoke(profileId)
        const worker = read(z.string().regex(opaque), body.worker)
        touch(spaces.device, device)
        const next = store.get(spaces.device, 'next')
        if (!next) return null
        const job = find(profileId, next)
        if (job.status === 'waiting' || (job.status === 'running' && job.resident && same(job.workerHash, worker))) return claim(profileId, job, worker, true)
        return null
      }
      const job = find(profileId, body.jobId)
      if (action === 'claim') {
        const worker = read(z.string().regex(opaque), body.worker)
        if (!same(job.ticketHash, bearer)) throw new UserError('配对链接已失效。', 403)
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
          if (job.ticketHash || store.get(spaces.device, 'next') === job.id) {
            store.remove(spaces.inputs, job.id)
            store.remove(spaces.device, 'next')
          }
          if (job.resident) touch(spaces.device, store.get(spaces.device, 'registration'))
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
          if (row.available !== (successes > 0) || row.samples.length !== (row.error === 'invalid_node' ? 0 : job.config.rounds)
            || Boolean(row.speed) !== (job.config.bandwidth && row.available)
            || Boolean(row.ai) !== (job.config.ai && row.available)
            || (row.speed && (row.speed.bytes > job.config.mebibytes * 1024 ** 2 || row.speed.elapsedMs > job.config.seconds * 1000 || row.speed.perSecondBps.length > job.config.seconds))) throw new UserError('结果超出本次检测配置。', 422)
        }
        store.transaction(() => {
          job.available = report.results.filter(row => row.available).length
          finish(profileId, job, 'completed')
          store.set(spaces.reports, job.id, {
            ...report, config: job.config, createdAt: job.createdAt,
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
