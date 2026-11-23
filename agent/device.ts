import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { assignmentSchema } from '../shared/quality.ts'
import { secureProbeOrigin } from '../shared/quality-options.ts'
import { AgentHttpError, execute, post } from './client.ts'

const profile = /^[\w-]{8,64}$/
const token = /^[\w-]{43}$/
export const identitySchema = z.object({
  origin: z.url().refine(value => { const u = new URL(value); return u.origin === value && secureProbeOrigin(u) }),
  profileId: z.string().regex(profile), secret: z.string().regex(token),
  interface: z.string().min(1).max(256).optional(),
})
export type Identity = z.infer<typeof identitySchema>

export function parseInvite(value: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请粘贴完整的电脑配对链接。') }
  const [kind, profileId, ticket, ...extra] = url.hash.slice(1).split('.')
  if (!secureProbeOrigin(url) || url.pathname !== '/' || url.username || url.password || url.search ||
    kind !== 'device' || !profile.test(profileId ?? '') || !token.test(ticket ?? '') || extra.length) {
    throw new Error('电脑配对链接无效。远程地址需要 HTTPS，本机可使用 localhost。')
  }
  return { origin: url.origin, profileId, ticket }
}
export async function enroll(identity: Identity, ticket: string, signal: AbortSignal) {
  await post(identity.origin, 'enroll', ticket, { profileId: identity.profileId, secret: identity.secret,
    name: hostname().slice(0, 128), platform: process.platform === 'win32' ? 'windows' : 'linux' }, signal)
}
export async function leave(identity: Identity) {
  try {
    await post(identity.origin, 'leave', identity.secret, { profileId: identity.profileId }, AbortSignal.timeout(4500))
  } catch (error) {
    if (!(error instanceof AgentHttpError && error.status === 403)) console.error('未能联系原工作台解除配对，请在工作台中解除这台电脑。')
  }
}
export async function serve(identity: Identity, binary: string, directory: string, signal: AbortSignal) {
  let backoff = 15_000
  let disconnected = false
  let worker = randomBytes(32).toString('base64url')
  console.log('探针正在等待 ' + identity.origin + ' 的检测任务。')
  if (identity.interface) process.env.SUBMELD_PROBE_INTERFACE = identity.interface
  while (!signal.aborted) {
    let pause = 15_000
    try {
      const value = await post(identity.origin, 'poll', identity.secret, { profileId: identity.profileId, worker }, signal)
      if (disconnected) console.log('已重新连接工作台。')
      disconnected = false
      backoff = 15_000
      if (value !== null) {
        const claimedWorker = worker
        worker = randomBytes(32).toString('base64url')
        const job = assignmentSchema.parse(value)
        try { await execute(job, identity.origin, identity.profileId, claimedWorker, binary, directory, signal) }
        catch (error) { if (!signal.aborted) console.error(error instanceof Error ? error.message : '任务失败。') }
        pause = 0
      }
    } catch (error) {
      if (signal.aborted) break
      if (!disconnected) console.error(error instanceof Error ? error.message : '暂时无法连接工作台。')
      disconnected = true
      pause = backoff
      backoff = Math.min(backoff * 2, 300_000)
    }
    if (pause) await delay(pause, undefined, { signal }).catch(() => {})
  }
}
