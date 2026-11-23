#!/usr/bin/env node
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './device.ts'
import { readIdentity, setup } from './install.ts'
import { cleanWorkerTemp, coreName, serviceName, serviceStatus } from './service.ts'

const help = `SubMeld PC 探针 · Windows 服务 / Linux systemd
  submeld-probe install          安装或更新常驻服务，首次安装时配对
  submeld-probe install --pair   使用新的电脑配对链接
  submeld-probe status           查看运行状态和开机自启状态
  submeld-probe uninstall        解除配对并移除服务，保留报告
安装和卸载需要管理员 PowerShell 或 Linux sudo。`
async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (!action || action === '--help' || action === '-h') { console.log(help); return }
  if (!['win32', 'linux'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 24) throw new Error('探针需要 Windows 或 Linux，以及 Node.js 24 或更高版本。')
  if (args.length && !(action === 'install' && args.length === 1 && args[0] === '--pair')) throw new Error(help)
  if (action === 'install' || action === 'uninstall') return setup(action, args.includes('--pair'))
  if (action === 'status') {
    const status = await serviceStatus()
    console.log(serviceName + ' · ' + (!status.installed ? '未安装' :
      (status.running ? '运行中' : '已停止') + ' · ' + (status.automatic ? '开机自启' : '未启用开机自启')))
    return
  }
  if (action !== 'run') throw new Error(help)
  const credentials = process.env.CREDENTIALS_DIRECTORY
  const directory = process.env.STATE_DIRECTORY
  if (!directory || !isAbsolute(directory)) throw new Error('请通过 submeld-probe install 启用系统服务。')
  const config = credentials ? join(credentials, 'device.json') : fileURLToPath(new URL('../../device.json', import.meta.url))
  const binary = fileURLToPath(new URL('../' + coreName, import.meta.url))
  const identity = await readIdentity(config)
  await cleanWorkerTemp(directory)
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('服务正在停止。'))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try { await serve(identity, binary, directory, controller.signal) }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop) }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '探针运行失败。'); process.exitCode = 1 })
