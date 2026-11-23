import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { installCore } from '../scripts/install-core.ts'
import { execute, parsePairing } from './client.ts'

async function main() {
  if (process.argv.includes('--help')) { console.log('SubMeld PC 探针 · Node.js 24+\n运行后粘贴工作台生成的一次性配对链接。可设置 SUBMELD_MIHOMO_BIN 使用已有核心。'); return }
  const input = createInterface({ input: process.stdin, output: process.stdout })
  let link: string
  try { link = await input.question('请粘贴 SubMeld 配对链接并回车：') } finally { input.close() }
  const { origin } = parsePairing(link)
  console.log('任务服务 ' + origin)
  const binary = process.env.SUBMELD_MIHOMO_BIN ? resolve(process.env.SUBMELD_MIHOMO_BIN) : resolve('bin', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo')
  if (!process.env.SUBMELD_MIHOMO_BIN) await installCore()
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('检测已停止。'))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
  try { await execute(link, binary, controller.signal) }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('SIGHUP', stop) }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '探针运行失败。'); process.exitCode = 1 })
