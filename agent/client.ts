import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assignmentSchema, type Progress } from '../shared/quality.ts'
import { secureProbeOrigin } from '../shared/quality-options.ts'
import { run } from './run.ts'

export function parsePairing(input: string) {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('请粘贴节点管理中生成的完整配对链接。') }
  if (!secureProbeOrigin(url)) throw new Error('远程探针配对需要 HTTPS。本机调试可以使用 localhost。')
  const parts = /^#([\w-]{8,64})\.([\da-f-]{36})\.([\w-]{43})$/i.exec(url.hash)
  if (!parts || url.username || url.password || url.search || url.pathname !== '/') throw new Error('配对链接格式无效，请在节点管理中重新复制。')
  return { origin: url.origin, profileId: parts[1], jobId: parts[2], ticket: parts[3] }
}
class AgentHttpError extends Error { status = 0 }
const stageNames: Record<Progress['stage'], string> = { starting: '准备独立端口', latency: '延迟与出口', bandwidth: '下载测速', ai: 'AI 平台', uploading: '上传结果' }
export async function execute(link: string, binary: string, userSignal: AbortSignal) {
  const { origin, profileId, jobId, ticket } = parsePairing(link)
  const worker = randomBytes(32).toString('base64url')
  const controller = new AbortController()
  const signal = AbortSignal.any([userSignal, controller.signal])
  async function post(action: string, token: string, content: object, active: AbortSignal) {
    for (let i = 0; ; i++) {
      active.throwIfAborted()
      try {
        const res = await fetch(origin + '/api/quality/agent/' + action, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ profileId, jobId, ...content }), signal: AbortSignal.any([active, AbortSignal.timeout(12_000)]) })
        if (!res.ok) {
          await res.body?.cancel()
          const message = res.status === 403 || res.status === 409 ? '任务已被领取、取消或过期。' : '服务端返回 HTTP ' + res.status + '。'
          throw Object.assign(new AgentHttpError(message), { status: res.status })
        }
        const reader = res.body!.getReader()
        const parts: Buffer[] = []
        let size = 0
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 9 * 1024 ** 2) throw new Error('任务配置过大。')
            parts.push(Buffer.from(value))
          }
        } finally { await reader.cancel().catch(() => {}) }
        return JSON.parse(Buffer.concat(parts).toString()) as unknown
      } catch (error) {
        active.throwIfAborted()
        if (error instanceof AgentHttpError && error.status < 500) throw error
        if (i === 3) throw new Error('无法连接任务服务，请检查服务地址和网络。')
        await delay(400 * 2 ** i, undefined, { signal: active })
      }
    }
  }
  const claimed = await post('claim', ticket, { worker }, signal)
  let progress: Progress = { stage: 'starting', done: 0, total: 0 }
  let inFlight: Promise<void> | null = null
  const beat = () => {
    if (!inFlight) inFlight = post('progress', worker, { progress }, signal).then(() => {}, error => { controller.abort(error) })
      .finally(() => { inFlight = null })
    return inFlight
  }
  const timer = setInterval(beat, 4000)
  try {
    const job = assignmentSchema.parse(claimed)
    if (job.jobId !== jobId || new Set(job.nodes.map(n => n.key)).size !== job.nodes.length) throw new Error('任务节点清单无效。')
    progress.total = job.nodes.length
    await beat()
    signal.throwIfAborted()
    console.log('已领取 ' + job.nodes.length + ' 个节点。按 Ctrl+C 可停止。')
    const report = await run(job, binary, signal, value => {
      if (progress.stage !== value.stage || value.done === value.total || value.done % 20 === 0) console.log(stageNames[value.stage] + '  ' + value.done + '/' + value.total)
      progress = value
    })
    clearInterval(timer)
    await inFlight
    const local = { ...report, createdAt: job.createdAt, config: job.config,
      results: report.results.map((row, i) => ({ ...row, name: job.nodes[i].name, sourceName: job.nodes[i].sourceName })) }
    try {
      const dir = resolve('reports')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const file = resolve(dir, jobId + '.json')
      await writeFile(file, JSON.stringify(local, null, 2) + '\n', { mode: 0o600 })
      console.log('本地报告 ' + file)
    } catch { console.error('本地报告写入失败，继续上传结果。') }
    await post('complete', worker, { report }, signal)
    console.log('结果已上传，可在节点管理中查看。')
  } catch (error) {
    clearInterval(timer)
    controller.abort(error)
    await inFlight
    await post(userSignal.aborted ? 'cancel' : 'fail', worker, {}, AbortSignal.timeout(3500)).catch(() => {})
    if (controller.signal.reason instanceof Error) throw controller.signal.reason
    throw error
  } finally { clearInterval(timer) }
}
