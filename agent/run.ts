import type { AgentReport, Assignment, Progress, QualityRow } from '../shared/quality.ts'
import { aiSkipReason, isSubscriptionNotice } from '../shared/quality-options.ts'
import { withCore } from './core.ts'
import { inspectPlatforms } from './ai.ts'
import { measureExit, measureLatency, measureSpeed, summarize, targets } from './measure.ts'

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
  if (!config.basic && !config.ai) throw new Error('基础检测和 AI 检测至少启用一项。')
  const startedAt = new Date().toISOString()
  const notices = new Set(job.nodes.filter(node => isSubscriptionNotice(node.name) || isSubscriptionNotice(String(node.connection.name ?? ''))).map(node => node.key))
  return withCore(binary, job.nodes.filter(node => !notices.has(node.key)), signal, async (routes, invalid, active) => {
    const rows = new Map<string, QualityRow>()
    for (const key of [...notices, ...invalid.map(node => node.key)]) rows.set(key, {
      key, samples: [], ...summarize([]), error: notices.has(key) ? 'info_node' : 'invalid_node', exit: null, speed: null, ai: null,
    })
    let done = rows.size
    let alive = routes
    if (config.basic) {
      progress({ stage: 'latency', done, total: job.nodes.length })
      await pool(routes, config.concurrency, active, async ({ node, outlet }) => {
        rows.set(node.key, await measureLatency(node.key, outlet, config, active, endpoints))
        progress({ stage: 'latency', done: ++done, total: job.nodes.length })
      })
      alive = routes.filter(({ node }) => rows.get(node.key)!.available)
      if (config.bandwidth) {
        done = 0
        progress({ stage: 'bandwidth', done, total: alive.length })
        await pool(alive, config.speedConcurrency, active, async ({ node, outlet }) => {
          rows.get(node.key)!.speed = await measureSpeed(outlet, config, active, endpoints.download)
          progress({ stage: 'bandwidth', done: ++done, total: alive.length })
        })
      }
    } else {
      progress({ stage: 'starting', done, total: job.nodes.length })
      await pool(routes, config.concurrency, active, async ({ node, outlet }) => {
        const exit = await measureExit(outlet, active, endpoints)
        rows.set(node.key, { key: node.key, samples: [], ...summarize([]), error: null, exit, speed: null, ai: null })
        progress({ stage: 'starting', done: ++done, total: job.nodes.length })
      })
    }
    if (config.ai) {
      // The same general-purpose exit IP can lead to different provider routes.
      const byExit = new Map<string, typeof alive>()
      let total = 0
      for (const route of alive) {
        const row = rows.get(route.node.key)!
        const reason = aiSkipReason(row)
        if (reason) { row.aiSkipped = reason; continue }
        const key = row.exit?.ip ?? route.node.key
        const group = byExit.get(key)
        if (group) group.push(route)
        else byExit.set(key, [route])
        total++
      }
      done = 0
      progress({ stage: 'ai', done, total })
      await pool([...byExit.values()], Math.min(6, config.concurrency), active, async group => {
        for (const { node, outlet } of group) {
          active.throwIfAborted()
          const row = rows.get(node.key)!
          row.ai = await inspect(outlet, row.exit?.region ?? null, active)
          if (!config.basic) {
            row.available = Boolean(row.exit) || Object.values(row.ai).some(r => r.state !== 'network_error')
          }
          progress({ stage: 'ai', done: ++done, total })
        }
      })
    }
    active.throwIfAborted()
    progress({ stage: 'uploading', done: job.nodes.length, total: job.nodes.length })
    return { schemaVersion: 1, jobId: job.jobId, startedAt, finishedAt: new Date().toISOString(), results: job.nodes.map(node => rows.get(node.key)!) }
  })
}
