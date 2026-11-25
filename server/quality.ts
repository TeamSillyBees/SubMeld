import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'
import type { Profile } from '../shared/model.ts'
import {
  defaultQualityScheduleConfig, latestNodeQualitySchema, maxQualityNodes, probeCapabilities, progressSchema,
  qualityConfig, qualityDefaults, qualityKey, qualityScheduleConfigSchema, reportSchema, scheduleRunSchema,
  type Assignment, type DevicePairing, type LatestNodeQuality, type ProbeDevice, type Pairing, type QualityConfig,
  type QualityJob, type QualityNode, type QualityReport, type QualityScheduleConfig, type ScheduleRunResult, type ScheduleSkipReason,
} from '../shared/quality.ts'
import { aiSkipReason, compatibleProbe, isSubscriptionNotice, minimumProbeVersion, probePollMs, probeQueueLimit, secureProbeOrigin } from '../shared/quality-options.ts'
import type { LatestQualityMap } from '../shared/quality-snapshot.ts'
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
const latestKey = (deviceId: string, nodeKey: string) => `${deviceId}/${nodeKey}`
export const qualitySpaces = (profileId: string) => ({
  devices: `quality-devices/${profileId}` as const,
  device: `quality-device/${profileId}` as const,
  jobs: `quality-jobs/${profileId}` as const,
  inputs: `quality-inputs/${profileId}` as const,
  reports: `quality-reports/${profileId}` as const,
  latest: `quality-latest/${profileId}` as const,
  schedules: `quality-schedules/${profileId}` as const,
})
export interface StoredDevice extends Omit<ProbeDevice, 'status' | 'waiting'> { secretHash: string; offline?: boolean }
export interface StoredInvite { ticketHash: string; expiresAt: string }
export interface StoredQualityJob extends QualityJob {
  resident?: boolean; ticketHash: string | null; workerHash: string | null; labels: Pick<QualityNode, 'key' | 'name' | 'sourceName'>[]
}
function summary({ resident, ticketHash, workerHash, labels, ...job }: StoredQualityJob): QualityJob { return job }

export function createQualityService(
  store: Store,
  select: (profile: Profile, keys: Set<string>) => QualityNode[],
  now = () => Date.now(),
  selectScope?: (profile: Profile, scope: 'kept' | 'all') => QualityNode[],
) {
  const waiters = new Map<string, (check: boolean) => void>()
  let closing = false
  const wake = (profileId: string, deviceId?: string | null) => waiters.get(profileId + '/' + deviceId)?.(true)
  const offline = (d: StoredDevice, at = now()) => d.offline || at - Date.parse(d.lastSeenAt) >= 35_000
  function registry(profileId: string) {
    return store.list(qualitySpaces(profileId).devices).map(([, value]) => value)
  }
  function deviceFor(profileId: string, id: unknown) {
    const selected = read(z.uuid(), id)
    const device = registry(profileId).find(d => d.id === selected)
    if (!device) throw new UserError('所选探针已解除配对。', 404)
    return device
  }
  function devices(profileId: string): ProbeDevice[] {
    const records = registry(profileId)
    const jobs = list(profileId)
    return records.map(device => {
      const { secretHash, offline: left, ...d } = device
      const own = jobs.filter(j => j.targetDeviceId === d.id)
      return { ...d, status: offline(device) ? 'offline' : own.some(j => j.status === 'running') ? 'busy' : 'online',
        waiting: own.filter(j => j.status === 'waiting').length }
    })
  }
  function finish(profileId: string, job: StoredQualityJob, status: QualityJob['status'], failure: QualityJob['failure'] = null) {
    const spaces = qualitySpaces(profileId)
    job.status = status
    job.finishedAt = date(now())
    job.ticketHash = null
    job.failure = failure
    if (status !== 'completed') job.workerHash = null
    store.remove(spaces.inputs, job.id)
    store.set(spaces.jobs, job.id, job)
    wake(profileId, job.targetDeviceId)
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
  function enqueueBatch(
    profileId: string,
    target: StoredDevice,
    batches: QualityNode[][],
    config: QualityConfig,
    meta: { trigger: 'manual' | 'schedule'; scheduleKind?: 'basic' | 'ai' },
    history: QualityJob[],
    enqueuedAts: string[],
    onCommit?: (created: StoredQualityJob[]) => void,
    at = now(),
  ): QualityJob[] {
    const spaces = qualitySpaces(profileId)
    const createdAt = date(at)
    const expiresAt = date(at + queueMs)
    const targetDeviceName = target.remark || target.name
    const jobs: StoredQualityJob[] = batches.map((nodes, i) => ({
      id: randomUUID(), createdAt, finishedAt: null, expiresAt, status: 'waiting',
      targetDeviceId: target.id, targetDeviceName, enqueuedAt: enqueuedAts[i],
      config, total: nodes.length, progress: { stage: 'starting', done: 0, total: nodes.length }, available: null,
      trigger: meta.trigger, ...(meta.scheduleKind ? { scheduleKind: meta.scheduleKind } : {}),
      failure: null, ticketHash: null, workerHash: null, labels: nodes.map(({ key, name, sourceName }) => ({ key, name, sourceName })),
    }))
    const queued = store.transaction(() => {
      const newest = history.filter(j => j.status === 'completed').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '') || b.id.localeCompare(a.id))
      const protectedIds = new Set<string>()
      const seenDevices = new Set<string | null | undefined>()
      for (const job of newest) if (!seenDevices.has(job.targetDeviceId)) {
        protectedIds.add(job.id)
        seenDevices.add(job.targetDeviceId)
      }
      for (const old of history.filter(j => j.status !== 'waiting' && j.status !== 'running').slice(historyLimit - 1)) {
        if (!protectedIds.has(old.id)) for (const space of [spaces.jobs, spaces.inputs, spaces.reports]) store.remove(space, old.id)
      }
      jobs.forEach((job, i) => {
        store.set(spaces.inputs, job.id, batches[i])
        store.set(spaces.jobs, job.id, job)
      })
      onCommit?.(jobs)
      return jobs.map(summary)
    })
    wake(profileId, target.id)
    return queued
  }
  function queue(profile: Profile, body: Record<string, unknown>) {
    const target = deviceFor(profile.id, body.targetDeviceId)
    const keys = new Set(read(keySchema, body.keys))
    const parsed = read(qualityConfig, body.config)
    const config = parsed.basic ? parsed : { ...parsed, bandwidth: false }
    const history = list(profile.id)
    const enqueuedAt = queueSlot(target, history)
    const nodes = select(profile, keys)
    if (keys.size !== nodes.length) throw new UserError('部分节点已更新，请刷新节点列表后重新选择。', 409)
    if (Buffer.byteLength(JSON.stringify(nodes)) > 8 * 1024 ** 2) throw new UserError('节点配置较大，请分批检测。', 413)
    return enqueueBatch(profile.id, target, [nodes], config, { trigger: 'manual' }, history, [enqueuedAt])[0]
  }
  function queueSlot(target: StoredDevice, jobs: QualityJob[], exclude?: string) {
    if (offline(target)) throw new UserError('探针已离线，请选择在线探针。', 409)
    if (!compatibleProbe(target)) throw new UserError('请先更新探针至 ' + minimumProbeVersion + ' 或兼容版本。', 409)
    const waiting = jobs.filter(j => j.status === 'waiting' && j.targetDeviceId === target.id && j.id !== exclude)
    if (waiting.length >= probeQueueLimit) throw new UserError('这台探针的等待队列已满。', 409)
    return date(Math.max(now(), ...waiting.map(j => Date.parse(j.enqueuedAt ?? j.createdAt) + 1)))
  }
  function touch(space: `quality-devices/${string}`, device: StoredDevice | null) {
    if (device && (device.offline || now() - Date.parse(device.lastSeenAt) >= 8000)) store.set(space, device.id, { ...device, offline: false, lastSeenAt: date(now()) })
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
      const schedule = store.get(spaces.schedules, 'config')
      if (schedule?.targetDeviceId === device.id) {
        store.set(spaces.schedules, 'config', { ...schedule, targetDeviceId: null })
      }
      wake(profileId, device.id)
      return { ok: true }
    })
  }
  function nextAssignment(profileId: string, device: StoredDevice, worker: string) {
    const spaces = qualitySpaces(profileId)
    const jobs = list(profileId).filter(job => job.targetDeviceId === device.id)
    const running = jobs.find(job => job.status === 'running')
    if (running) {
      const job = find(profileId, running.id)
      return job.resident && same(job.workerHash, worker) && store.get(spaces.inputs, job.id) ? claim(profileId, job, worker, true) : null
    }
    if (!compatibleProbe(device)) return null
    const first = jobs.filter(j => j.status === 'waiting').sort((a, b) =>
      (a.enqueuedAt ?? a.createdAt).localeCompare(b.enqueuedAt ?? b.createdAt) || a.id.localeCompare(b.id))[0]
    return first ? claim(profileId, find(profileId, first.id), worker, true) : null
  }
  function waitForJob(profileId: string, device: StoredDevice, worker: string, signal?: AbortSignal) {
    const key = profileId + '/' + device.id
    waiters.get(key)?.(false)
    return new Promise<boolean>(resolve => {
      const done = (check: boolean) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        waiters.delete(key)
        resolve(check)
      }
      const abort = () => done(false)
      const timer = setTimeout(abort, probePollMs)
      waiters.set(key, done)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted || closing) abort()
    }).then(check => {
      if (!check || signal?.aborted || closing) return null
      const current = store.get(qualitySpaces(profileId).devices, device.id)
      if (!current) throw new UserError('这台电脑的配对已解除。', 403)
      return current.offline ? null : nextAssignment(profileId, current, worker)
    })
  }
  function getLatestQuality(profileId: string, deviceId: unknown): Record<string, LatestNodeQuality> {
    const targetId = read(z.uuid(), deviceId)
    const rows: Record<string, LatestNodeQuality> = {}
    for (const [, record] of store.list(qualitySpaces(profileId).latest)) {
      if (record.deviceId === targetId) rows[record.nodeKey] = record
    }
    return rows
  }
  function latest(profileId: string): LatestQualityMap
  function latest(profileId: string, deviceId: string): Record<string, LatestNodeQuality>
  function latest(profileId: string, deviceId?: string): LatestQualityMap | Record<string, LatestNodeQuality>
  function latest(profileId: string, deviceId?: unknown): LatestQualityMap | Record<string, LatestNodeQuality> {
    if (deviceId != null && deviceId !== '') return getLatestQuality(profileId, deviceId)
    const grouped: LatestQualityMap = {}
    for (const [, record] of store.list(qualitySpaces(profileId).latest)) {
      (grouped[record.deviceId] ??= {})[record.nodeKey] = record
    }
    return grouped
  }
  function setLatestQuality(profileId: string, record: LatestNodeQuality) {
    const parsed = read(latestNodeQualitySchema, record)
    store.set(qualitySpaces(profileId).latest, latestKey(parsed.deviceId, parsed.nodeKey), parsed)
    return parsed
  }
  function deleteLatestQuality(profileId: string, filter?: { deviceId?: string; nodeKey?: string }) {
    const space = qualitySpaces(profileId).latest
    if (!filter || (!filter.deviceId && !filter.nodeKey)) {
      store.clear(space)
      return
    }
    if (filter.deviceId && filter.nodeKey) {
      store.remove(space, latestKey(read(z.uuid(), filter.deviceId), read(qualityKey, filter.nodeKey)))
      return
    }
    const targetDevice = filter.deviceId ? read(z.uuid(), filter.deviceId) : null
    const targetNode = filter.nodeKey ? read(qualityKey, filter.nodeKey) : null
    for (const [key, record] of store.list(space)) {
      if ((targetDevice && record.deviceId === targetDevice) || (targetNode && record.nodeKey === targetNode)) {
        store.remove(space, key)
      }
    }
  }
  function getSchedule(profileId: string): QualityScheduleConfig {
    return store.get(qualitySpaces(profileId).schedules, 'config') ?? structuredClone(defaultQualityScheduleConfig)
  }
  function saveSchedule(profileId: string, input: unknown): QualityScheduleConfig {
    const parsed = read(qualityScheduleConfigSchema, input)
    if (parsed.targetDeviceId !== null) deviceFor(profileId, parsed.targetDeviceId)
    const prev = store.get(qualitySpaces(profileId).schedules, 'config')
    const next: QualityScheduleConfig = {
      targetDeviceId: parsed.targetDeviceId,
      scope: parsed.scope,
      autoRefreshGroups: parsed.autoRefreshGroups,
      basic: { ...parsed.basic, lastRunAt: prev?.basic.lastRunAt ?? null, lastJobId: prev?.basic.lastJobId ?? null },
      ai: { ...parsed.ai, lastRunAt: prev?.ai.lastRunAt ?? null, lastJobId: prev?.ai.lastJobId ?? null },
    }
    store.set(qualitySpaces(profileId).schedules, 'config', next)
    return next
  }
  function executeSchedule(profile: Profile, mode: 'basic' | 'ai' | 'due', tickNow = now()): ScheduleRunResult {
    const kinds = mode === 'due' ? (['basic', 'ai'] as const) : ([mode] as const)
    let schedule = getSchedule(profile.id)
    const jobs: QualityJob[] = []
    const skipped: { kind: 'basic' | 'ai'; reason: ScheduleSkipReason }[] = []
    for (const kind of kinds) {
      if (mode === 'due') {
        if (!schedule[kind].enabled) {
          skipped.push({ kind, reason: 'disabled' })
          continue
        }
        const lastMs = schedule[kind].lastRunAt ? Date.parse(schedule[kind].lastRunAt) : NaN
        if (!Number.isNaN(lastMs) && tickNow - lastMs < schedule[kind].intervalMinutes * 60_000) {
          skipped.push({ kind, reason: 'not_due' })
          continue
        }
      }
      if (!schedule.targetDeviceId) {
        if (mode !== 'due') throw new UserError('请先选择执行定时任务的探针。', 422)
        skipped.push({ kind, reason: 'no_device' })
        continue
      }
      const target = store.get(qualitySpaces(profile.id).devices, schedule.targetDeviceId)
      if (!target) {
        if (mode !== 'due') throw new UserError('所选探针已解除配对。', 404)
        skipped.push({ kind, reason: 'device_missing' })
        continue
      }
      if (offline(target, tickNow)) {
        if (mode !== 'due') throw new UserError('探针已离线，请选择在线探针。', 409)
        skipped.push({ kind, reason: 'device_offline' })
        continue
      }
      if (!compatibleProbe(target)) {
        if (mode !== 'due') throw new UserError('请先更新探针至 ' + minimumProbeVersion + ' 或兼容版本。', 409)
        skipped.push({ kind, reason: 'device_incompatible' })
        continue
      }
      const history = list(profile.id)
      const activeSameKind = history.some(j =>
        (j.status === 'waiting' || j.status === 'running')
        && j.targetDeviceId === target.id
        && (j.scheduleKind === kind || (kind === 'basic' ? j.config.basic : j.config.ai)),
      )
      if (activeSameKind) {
        if (mode !== 'due') throw new UserError('该探针已有相同类型的检测任务在排队或执行中。', 409)
        skipped.push({ kind, reason: 'already_active' })
        continue
      }
      const allNodes = selectScope ? selectScope(profile, schedule.scope) : []
      if (!allNodes.length) {
        if (mode !== 'due') throw new UserError('当前检测范围内没有可测节点。', 422)
        skipped.push({ kind, reason: 'no_nodes' })
        continue
      }
      const batches: QualityNode[][] = []
      for (let i = 0; i < allNodes.length; i += maxQualityNodes) {
        batches.push(allNodes.slice(i, i + maxQualityNodes))
      }
      const waiting = history.filter(j => j.status === 'waiting' && j.targetDeviceId === target.id)
      if (waiting.length + batches.length > probeQueueLimit) {
        if (mode !== 'due') throw new UserError('这台探针的等待队列已满。', 409)
        skipped.push({ kind, reason: 'queue_full' })
        continue
      }
      const baseEnqueued = Math.max(tickNow, ...waiting.map(j => Date.parse(j.enqueuedAt ?? j.createdAt) + 1))
      const enqueuedAts = batches.map((_, i) => date(baseEnqueued + i))
      const config: QualityConfig = kind === 'basic'
        ? {
            basic: true,
            rounds: schedule.basic.rounds,
            concurrency: schedule.basic.concurrency,
            bandwidth: schedule.basic.bandwidth,
            speedConcurrency: qualityDefaults.speedConcurrency,
            seconds: qualityDefaults.seconds,
            mebibytes: qualityDefaults.mebibytes,
            ai: false,
          }
        : {
            basic: false,
            rounds: qualityDefaults.rounds,
            concurrency: schedule.ai.concurrency,
            bandwidth: false,
            speedConcurrency: qualityDefaults.speedConcurrency,
            seconds: qualityDefaults.seconds,
            mebibytes: qualityDefaults.mebibytes,
            ai: true,
          }
      const created = enqueueBatch(
        profile.id,
        target,
        batches,
        config,
        { trigger: 'schedule', scheduleKind: kind },
        history,
        enqueuedAts,
        createdJobs => {
          schedule = {
            ...schedule,
            [kind]: {
              ...schedule[kind],
              lastRunAt: date(tickNow),
              lastJobId: createdJobs[0].id,
            },
          }
          store.set(qualitySpaces(profile.id).schedules, 'config', schedule)
        },
        tickNow,
      )
      jobs.push(...created)
    }
    return { jobs, skipped, schedule }
  }
  function runSchedule(profile: Profile, body: unknown): ScheduleRunResult {
    const { kind } = read(scheduleRunSchema, body)
    return executeSchedule(profile, kind, now())
  }
  function tick(nowMs = now()) {
    for (const [, profile] of store.list('profiles')) {
      if (!store.get(qualitySpaces(profile.id).schedules, 'config')) continue
      try {
        executeSchedule(profile, 'due', nowMs)
      } catch {
        console.error('SubMeld: quality schedule tick failed for profile', profile.id)
      }
    }
  }
  return {
    list, devices, revoke, queue, getLatestQuality, latest, setLatestQuality, deleteLatestQuality,
    getSchedule, saveSchedule, runSchedule, tick,
    resetWaiters() { for (const done of [...waiters.values()]) done(true) },
    close() { closing = true; for (const done of waiters.values()) done(false) },
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
      if (job.targetDeviceId === target.id) return summary(job)
      job.enqueuedAt = queueSlot(target, list(profileId), job.id)
      job.targetDeviceId = target.id
      job.targetDeviceName = target.remark || target.name
      job.ticketHash = null
      job.expiresAt = date(now() + queueMs)
      store.set(qualitySpaces(profileId).jobs, job.id, job)
      wake(profileId, target.id)
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
    agent(action: string, bearer: string, body: Record<string, unknown>, signal?: AbortSignal) {
      const profileId = read(id, body.profileId)
      const spaces = qualitySpaces(profileId)
      if (action === 'enroll') {
        const secret = read(z.string().regex(opaque), body.secret)
        const name = read(z.string().trim().min(1).max(128), body.name)
        const platform = read(z.enum(['windows', 'linux']), body.platform)
        const profile = read(probeCapabilities.optional(), body.capabilities)
        const existing = registry(profileId).find(d => same(d.secretHash, secret))
        if (existing) return { ok: true }
        const invite = store.get(spaces.device, 'invite')
        if (!invite || !same(invite.ticketHash, bearer) || Date.parse(invite.expiresAt) <= now()) throw new UserError('电脑配对链接已失效。', 403)
        const id = randomUUID()
        return store.transaction(() => {
          store.set(spaces.devices, id, { id, secretHash: hash(secret), name, remark: '', platform, ...profile, lastSeenAt: date(now()) })
          store.remove(spaces.device, 'invite')
          return { ok: true }
        })
      }
      if (action === 'poll' || action === 'leave' || action === 'offline') {
        const device = registry(profileId).find(d => same(d.secretHash, bearer))
        if (!device) throw new UserError('这台电脑的配对已解除。', 403)
        if (action === 'leave') return revoke(profileId, device.id)
        if (action === 'offline') {
          store.set(spaces.devices, device.id, { ...device, offline: true, lastSeenAt: date(now()) })
          wake(profileId, device.id)
          return { ok: true }
        }
        const worker = read(z.string().regex(opaque), body.worker)
        const profile = read(probeCapabilities.optional(), body.capabilities)
        const current = { ...device, protocolVersion: undefined, agentVersion: undefined, ...profile, offline: false, lastSeenAt: date(now()) }
        store.set(spaces.devices, device.id, current)
        const assignment = nextAssignment(profileId, current, worker)
        return assignment ?? (body.wait === true ? waitForJob(profileId, current, worker, signal) : null)
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
        const rawReport = typeof body.report === 'object' && body.report !== null && Array.isArray((body.report as { results?: unknown }).results)
          ? {
              ...(body.report as Record<string, unknown>),
              results: ((body.report as { results: unknown[] }).results).map(item => {
                if (typeof item !== 'object' || item === null) return item
                const rowObj = item as Record<string, unknown>
                if (typeof rowObj.ai !== 'object' || rowObj.ai === null || Array.isArray(rowObj.ai)) return item
                const aiObj = rowObj.ai as Record<string, unknown>
                if (!('antigravity' in aiObj) && 'chatgptWeb' in aiObj && 'chatgptApp' in aiObj && 'gemini' in aiObj) {
                  return {
                    ...rowObj,
                    ai: {
                      ...aiObj,
                      antigravity: { state: 'unknown', evidence: 'unrecognized', httpStatus: null, needsReview: true, providerRegion: null },
                    },
                  }
                }
                return item
              }),
            }
          : body.report
        const report = read(reportSchema, rawReport)
        const rows = new Map(report.results.map(row => [row.key, row]))
        if (report.jobId !== job.id || report.results.length !== job.total || !job.labels.every(({ key }) => rows.has(key))) {
          throw new UserError('结果与本次任务的节点不匹配。', 422)
        }
        for (const row of rows.values()) {
          if (job.config.basic) {
            const successes = row.samples.filter(sample => sample.httpsMs !== null).length
            const skipReason = aiSkipReason(row)
            if (row.available !== (successes > 0) || row.samples.length !== (row.error === 'invalid_node' || row.error === 'info_node' ? 0 : job.config.rounds)
              || Boolean(row.speed) !== (job.config.bandwidth && row.available)
              || (row.aiSkipped && (!job.config.ai || !row.available || row.aiSkipped !== skipReason))
              || Boolean(row.ai) !== (job.config.ai && row.available && !row.aiSkipped)
              || (row.speed && (row.speed.bytes > job.config.mebibytes * 1024 ** 2 || row.speed.elapsedMs > job.config.seconds * 1000 || row.speed.perSecondBps.length > job.config.seconds))) throw new UserError('结果超出本次检测配置。', 422)
          } else {
            if (row.samples.length !== 0
              || row.tlsMedianMs !== null || row.httpsMedianMs !== null || row.jitterMs !== null || row.lossRate !== null
              || row.speed !== null
              || (row.error !== null && row.error !== 'invalid_node' && row.error !== 'info_node')) {
              throw new UserError('结果超出本次检测配置。', 422)
            }
            if (row.error === 'invalid_node' || row.error === 'info_node') {
              if (row.available || row.exit !== null || row.ai !== null || row.aiSkipped) {
                throw new UserError('结果超出本次检测配置。', 422)
              }
            } else if (row.aiSkipped) {
              if (!job.config.ai || row.aiSkipped !== 'missing_exit' || row.exit !== null || row.ai !== null || row.available) {
                throw new UserError('结果超出本次检测配置。', 422)
              }
            } else {
              const expectedAvailable = row.exit !== null || Object.values(row.ai ?? {}).some(r => r.state !== 'network_error')
              if (Boolean(row.ai) !== job.config.ai || row.available !== expectedAvailable) {
                throw new UserError('结果超出本次检测配置。', 422)
              }
            }
          }
        }
        store.transaction(() => {
          job.available = report.results.filter(row => row.available).length
          finish(profileId, job, 'completed')
          const completedResults = job.labels.map(label => ({ ...rows.get(label.key)!, ...label }))
          store.set(spaces.reports, job.id, {
            ...report, config: job.config, createdAt: job.createdAt, targetDeviceId: job.targetDeviceId ?? null, targetDeviceName: job.targetDeviceName ?? null,
            ...(job.trigger ? { trigger: job.trigger } : {}),
            ...(job.scheduleKind ? { scheduleKind: job.scheduleKind } : {}),
            results: completedResults,
          })
          if (job.targetDeviceId) {
            const deviceId = job.targetDeviceId
            const updatedAt = job.finishedAt!
            for (const row of completedResults) {
              const prev = store.get(spaces.latest, latestKey(deviceId, row.key))
              let next: LatestNodeQuality
              if (job.config.basic) {
                const infoNode = row.error === 'info_node' || isSubscriptionNotice(row.name)
                const speedFailed = row.speed ? (row.speed.stop === 'error' || !row.speed.bytes) : false
                const window = row.error !== 'info_node' && row.error !== 'invalid_node'
                  ? [...(prev?.availability?.window ?? []), row.available].slice(-20)
                  : null
                const success = window ? window.filter(Boolean).length : 0
                next = {
                  nodeKey: row.key,
                  deviceId,
                  basic: {
                    available: row.available,
                    httpsMs: row.httpsMedianMs,
                    tlsMs: row.tlsMedianMs,
                    jitterMs: row.jitterMs,
                    lossRate: row.lossRate,
                    exit: row.exit ? { ip: row.exit.ip, region: row.exit.region } : null,
                    infoNode,
                    error: row.error,
                    updatedAt,
                  },
                  speed: job.config.bandwidth
                    ? (row.speed ? { speedMbps: !speedFailed ? row.speed.averageBps * 8 / 1_000_000 : null, speedFailed, updatedAt } : null)
                    : (prev?.speed ?? null),
                  ai: job.config.ai
                    ? (row.ai || row.aiSkipped ? { results: row.ai, ...(row.aiSkipped ? { aiSkipped: row.aiSkipped } : {}), updatedAt } : null)
                    : (prev?.ai ?? null),
                  availability: window
                    ? { window, total: window.length, success, rate: window.length > 0 ? success / window.length : 0, updatedAt }
                    : (prev?.availability ?? null),
                }
              } else {
                next = {
                  nodeKey: row.key,
                  deviceId,
                  basic: prev?.basic ?? null,
                  speed: prev?.speed ?? null,
                  availability: prev?.availability ?? null,
                  ai: (row.error === 'info_node' || row.error === 'invalid_node')
                    ? null
                    : row.aiSkipped
                      ? { results: null, aiSkipped: row.aiSkipped, updatedAt }
                      : { results: row.ai, ...(row.exit ? { exit: { ip: row.exit.ip, region: row.exit.region } } : {}), updatedAt },
                }
              }
              setLatestQuality(profileId, next)
            }
          }
        })
      } else if (action === 'cancel') store.transaction(() => finish(profileId, job, 'cancelled'))
      else if (action === 'fail') store.transaction(() => finish(profileId, job, 'failed', 'probe_error'))
      else throw new UserError('未知的探针操作。', 404)
      return { ok: true }
    },
  }
}
