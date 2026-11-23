import { type AgentReport, type AiResults, type Assignment, type Progress, type QualityRow } from '../shared/quality.ts'
import { aiSkipReason, isSubscriptionNotice } from '../shared/quality-options.ts'
import { withCore } from './core.ts'
import { inspectPlatforms } from './ai.ts'
import { measureLatency, measureSpeed, summarize, targets } from './measure.ts'

async function pool<T>(items: T[], concurrency: number, signal: AbortSignal, work: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) { signal.throwIfAborted(); await work(items[next++]) }
  })
  const outcomes = await Promise.allSettled(workers)
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
}
export async function run(job: Assignment, binary: string, signal: AbortSignal, progress: (value: Progress) => void,
  endpoints = targets, inspect = inspectPlatforms): Promise<AgentReport> {
  const { config } = job
  const startedAt = new Date().toISOString()
  const notices = new Set(job.nodes.filter(node => isSubscriptionNotice(node.name) || isSubscriptionNotice(String(node.connection.name ?? ''))).map(node => node.key))
  return withCore(binary, job.nodes.filter(node => !notices.has(node.key)), signal, async (routes, invalid, active) => {
    const rows = new Map<string, QualityRow>()
    for (const key of [...notices, ...invalid.map(node => node.key)]) rows.set(key, {
      key, samples: [], ...summarize([]), error: notices.has(key) ? 'info_node' : 'invalid_node', exit: null, speed: null, ai: null,
    })
    let done = rows.size
    progress({ stage: 'latency', done, total: job.nodes.length })
    await pool(routes, config.concurrency, active, async ({ node, outlet }) => {
      rows.set(node.key, await measureLatency(node.key, outlet, config, active, endpoints))
      progress({ stage: 'latency', done: ++done, total: job.nodes.length })
    })
    const alive = routes.filter(({ node }) => rows.get(node.key)!.available)
    if (config.bandwidth) {
      done = 0
      progress({ stage: 'bandwidth', done, total: alive.length })
      await pool(alive, config.speedConcurrency, active, async ({ node, outlet }) => {
        rows.get(node.key)!.speed = await measureSpeed(outlet, config, active, endpoints.download)
        progress({ stage: 'bandwidth', done: ++done, total: alive.length })
      })
    }
    if (config.ai) {
      const exits = new Map<string, typeof alive>()
      const weakByExit = new Map<string, typeof alive>()
      for (const route of alive) {
        const row = rows.get(route.node.key)!
        const reason = aiSkipReason(row)
        if (reason) row.aiSkipped = reason
        // Without an exit IP, each healthy tunnel needs its own provider observations.
        const groupKey = row.exit?.ip ?? route.node.key
        const groups = reason ? weakByExit : exits
        const members = groups.get(groupKey) ?? []
        members.push(route)
        groups.set(groupKey, members)
      }
      done = 0
      progress({ stage: 'ai', done, total: exits.size })
      await pool([...exits], Math.min(6, config.concurrency), active, async ([groupKey, members]) => {
        const first = members.reduce((best, route) => (rows.get(route.node.key)!.httpsMedianMs ?? Infinity) < (rows.get(best.node.key)!.httpsMedianMs ?? Infinity) ? route : best)
        const ai: AiResults = await inspect(first.outlet, rows.get(first.node.key)!.exit?.region ?? null, active)
        const cached = weakByExit.get(groupKey) ?? []
        for (const { node } of [...members, ...cached]) {
          const row = rows.get(node.key)!
          row.ai = ai
          delete row.aiSkipped
        }
        progress({ stage: 'ai', done: ++done, total: exits.size })
      })
    }
    active.throwIfAborted()
    progress({ stage: 'uploading', done: job.nodes.length, total: job.nodes.length })
    return { schemaVersion: 1, jobId: job.jobId, startedAt, finishedAt: new Date().toISOString(), results: job.nodes.map(node => rows.get(node.key)!) }
  })
}
