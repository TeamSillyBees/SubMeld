import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'
import type { Profile } from '../shared/model.ts'
import {
  maxQualityNodes, progressSchema, qualityConfig, qualityKey, reportSchema,
  type Assignment, type Pairing, type QualityJob, type QualityNode, type QualityReport,
} from '../shared/quality.ts'
import { secureProbeOrigin } from '../shared/quality-options.ts'
import { id, read, UserError } from './schema.ts'

const waitingMs = 15 * 60_000
const leaseMs = 2 * 60_000
const historyLimit = 12
const keySchema = z.array(qualityKey).min(1).max(maxQualityNodes)
const opaque = /^[\w-]{43}$/
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (digest: string | null, input: string) => digest !== null && opaque.test(input) && timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(hash(input), 'hex'))
const date = (ms: number) => new Date(ms).toISOString()
export const qualitySpaces = (profileId: string) => ({
  jobs: `quality-jobs/${profileId}` as const,
  inputs: `quality-inputs/${profileId}` as const,
  reports: `quality-reports/${profileId}` as const,
})
export interface StoredQualityJob extends QualityJob {
  ticketHash: string | null; workerHash: string | null; labels: Pick<QualityNode, 'key' | 'name' | 'sourceName'>[]
}
function summary({ ticketHash, workerHash, labels, ...job }: StoredQualityJob): QualityJob { return job }

export function createQualityService(store: Store, select: (profile: Profile, keys: Set<string>) => QualityNode[], now = Date.now) {
  function finish(profileId: string, job: StoredQualityJob, status: QualityJob['status'], failure: QualityJob['failure'] = null) {
    const spaces = qualitySpaces(profileId)
    job.status = status
    job.finishedAt = date(now())
    job.ticketHash = null
    job.failure = failure
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
  return {
    list,
    clean() { for (const [profileId] of store.list('profiles')) list(profileId) },
    create(profile: Profile, body: Record<string, unknown>, origin: string) {
      const keys = new Set(read(keySchema, body.keys))
      const config = read(qualityConfig, body.config)
      const history = list(profile.id)
      if (history.some(job => job.status === 'waiting' || job.status === 'running')) throw new UserError('当前方案已有检测任务，请先完成或取消。', 409)
      const nodes = select(profile, keys)
      if (keys.size !== nodes.length) throw new UserError('部分节点已更新，请刷新节点列表后重新选择。', 409)
      if (Buffer.byteLength(JSON.stringify(nodes)) > 8 * 1024 ** 2) throw new UserError('节点配置较大，请分批检测。', 413)
      const job: StoredQualityJob = {
        id: randomUUID(), createdAt: date(now()), finishedAt: null, expiresAt: '', status: 'waiting',
        config, total: nodes.length, progress: { stage: 'starting', done: 0, total: nodes.length }, available: null,
        failure: null, ticketHash: null, workerHash: null, labels: nodes.map(({ key, name, sourceName }) => ({ key, name, sourceName })),
      }
      const spaces = qualitySpaces(profile.id)
      return store.transaction(() => {
        for (const old of history.slice(historyLimit - 1)) for (const space of Object.values(spaces)) store.remove(space, old.id)
        store.set(spaces.inputs, job.id, nodes)
        return issue(profile.id, job, origin)
      })
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
      const job = find(profileId, body.jobId)
      const spaces = qualitySpaces(profileId)
      if (action === 'claim') {
        const worker = read(z.string().regex(opaque), body.worker)
        if (!same(job.ticketHash, bearer)) throw new UserError('配对链接已失效。', 403)
        if (job.status !== 'waiting' && !(job.status === 'running' && same(job.workerHash, worker))) throw new UserError('此任务已由另一探针领取。', 409)
        const nodes = store.get(spaces.inputs, job.id)
        if (!nodes) throw new UserError('此任务已领取。', 409)
        job.workerHash = hash(worker)
        job.status = 'running'
        job.expiresAt = date(now() + leaseMs)
        store.set(spaces.jobs, job.id, job)
        return { schemaVersion: 1, jobId: job.id, createdAt: job.createdAt, config: job.config, nodes } satisfies Assignment
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
          if (job.ticketHash) store.remove(spaces.inputs, job.id)
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
