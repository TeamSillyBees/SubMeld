import { randomBytes } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stageRuntime } from './runtime.ts'
import { AgentHttpError } from './client.ts'
import { enroll, identitySchema, leave, parseInvite, type Identity } from './device.ts'
import {
  activate, atomicWrite, configFile, ensureInstallDirectory, exists, installDir,
  prepareHost, removeService, requireAdmin, runtime, serviceName, serviceStatus, stateDir, stopService,
} from './service.ts'

const pending = join(installDir, 'pending.json')
export async function readIdentity(path: string): Promise<Identity> {
  return identitySchema.parse(JSON.parse(await readFile(path, 'utf8')))
}
async function pair(previous: Identity | null, replace: boolean) {
  if (previous && !replace && !await exists(pending)) {
    if (process.env.SUBMELD_PROBE_INTERFACE !== undefined) {
      const updated = identitySchema.parse({ ...previous, interface: process.env.SUBMELD_PROBE_INTERFACE || undefined })
      await atomicWrite(configFile, JSON.stringify(updated), 0o600)
    }
    return
  }
  // Persist the proposed key before enrollment so a lost acknowledgement can be retried.
  let proposed: Identity & { ticket: string }
  if (!replace && await exists(pending)) {
    const raw = JSON.parse(await readFile(pending, 'utf8'))
    proposed = { ...identitySchema.parse(raw), ticket: raw.ticket }
  } else {
    const input = createInterface({ input: process.stdin, output: process.stdout })
    let link: string
    try { link = await input.question('请粘贴工作台生成的电脑配对链接并回车：') } finally { input.close() }
    const { origin, profileId, ticket } = parseInvite(link)
    proposed = { origin, profileId, secret: randomBytes(32).toString('base64url'), ticket,
      ...(process.env.SUBMELD_PROBE_INTERFACE ? { interface: process.env.SUBMELD_PROBE_INTERFACE } : {}) }
    await atomicWrite(pending, JSON.stringify(proposed), 0o600)
  }
  const identity = identitySchema.parse(proposed)
  try { await enroll(identity, proposed.ticket, AbortSignal.timeout(65_000)) }
  catch (error) {
    if (error instanceof AgentHttpError && error.status === 403) throw new Error('配对链接已失效，请复制新的电脑配对链接并运行 submeld-probe install --pair。')
    throw error
  }
  await atomicWrite(configFile, JSON.stringify(identity), 0o600)
  await rm(pending, { force: true })
  if (previous && (previous.origin !== identity.origin || previous.profileId !== identity.profileId)) await leave(previous)
}
async function install(replace: boolean) {
  const before = await serviceStatus()
  await ensureInstallDirectory()
  await prepareHost()
  const stage = await mkdtemp(join(installDir, 'stage-'))
  const old = join(installDir, 'previous')
  try {
    await stageRuntime(stage)
    const previous = await exists(configFile) ? await readIdentity(configFile) : null
    await pair(previous, replace)
    if (before.installed && (before.running || process.platform === 'linux')) await stopService()
    // Recover the previous release if setup was interrupted between the two renames.
    if (!await exists(runtime) && await exists(old)) await rename(old, runtime)
    if (await exists(runtime)) {
      await rm(old, { recursive: true, force: true })
      await rename(runtime, old)
    }
    try {
      await rename(stage, runtime)
      await activate(before.installed)
      const result = await serviceStatus()
      if (!result.running || !result.automatic) throw new Error('系统服务未进入开机自启和运行状态。')
    } catch (error) {
      if (await exists(old)) {
        const current = await serviceStatus()
        if (current.running) await stopService()
        await rm(runtime, { recursive: true, force: true })
        await rename(old, runtime)
        if (before.running) await activate(current.installed)
      }
      throw error
    }
    await rm(old, { recursive: true, force: true })
    console.log(serviceName + ' 已启动并设为开机自启。报告目录：' + join(stateDir, 'reports'))
  } finally { await rm(stage, { recursive: true, force: true }) }
}
async function uninstall() {
  const before = await serviceStatus()
  if (!await exists(installDir) && !before.installed) { console.log('探针服务尚未安装。'); return }
  const parent = await realpath(dirname(installDir))
  const managed = join(parent, process.platform === 'win32' ? 'SubMeld Probe' : 'submeld-probe')
  if (!(await lstat(installDir)).isDirectory() || await realpath(installDir) !== managed ||
    await readFile(join(installDir, '.submeld-probe'), 'utf8') !== 'SubMeld PC Probe\n') throw new Error('无法验证探针安装目录的归属。')
  if (before.installed) await removeService(before.running)
  if (await exists(configFile)) await leave(await readIdentity(configFile))
  if (await exists(pending)) await leave(await readIdentity(pending))
  await rm(managed, { recursive: true, force: true })
  console.log('已移除探针服务和本机配对凭据。已有报告保存在 ' + stateDir)
}
export async function setup(action: 'install' | 'uninstall', replace: boolean) {
  await requireAdmin()
  const lock = createServer(socket => socket.destroy())
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\SubMeldProbeSetup' : '\0submeld-probe-setup'
  await new Promise<void>((done, reject) => lock.once('error', reject).listen(address, done))
    .catch(error => { if (error.code === 'EADDRINUSE') throw new Error('另一个探针安装程序正在运行。'); throw error })
  try {
    if (action === 'install') await install(replace)
    else await uninstall()
  } finally { await new Promise<void>(done => lock.close(() => done())) }
}
