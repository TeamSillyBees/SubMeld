import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { installCore } from '../scripts/install-core.ts'
import { coreName, exists, nodeName, runtime, windowsTool } from './service.ts'

const exec = promisify(execFile)
const packageDir = fileURLToPath(new URL('../', import.meta.url))

// npm can place native optional dependencies inside impit or alongside it.
export async function stageRuntime(stage: string) {
  const require = createRequire(import.meta.url)
  const modules = join(stage, 'node_modules')
  await mkdir(modules)
  for (const folder of ['agent', 'shared', 'scripts']) await cp(join(packageDir, folder), join(stage, folder), { recursive: true })
  await copyFile(join(packageDir, 'package.json'), join(stage, 'package.json'))
  await copyFile(process.execPath, join(stage, nodeName))
  for (const name of ['zod', 'impit']) await cp(dirname(require.resolve(name + '/package.json')), join(modules, name), {
    recursive: true, filter: path => !path.endsWith('node_modules'),
  })
  const impit = createRequire(require.resolve('impit/package.json'))
  const manifest = impit('./package.json') as { optionalDependencies: Record<string, string> }
  for (const name of Object.keys(manifest.optionalDependencies).filter(name => name.startsWith('impit-' + process.platform + '-' + process.arch + '-'))) {
    let path: string
    try { path = impit.resolve(name + '/package.json') } catch { continue }
    await cp(dirname(path), join(modules, name), { recursive: true })
  }
  const core = join(stage, coreName)
  const custom = process.env.SUBMELD_MIHOMO_BIN
  if (custom) {
    await copyFile(resolve(custom), core)
    await exec(core, ['-v'], { timeout: 8000, windowsHide: true })
  } else {
    const existing = join(runtime, coreName)
    if (await exists(existing)) await copyFile(existing, core)
    await installCore(stage)
  }
  if (process.platform === 'linux') await exec('chmod', ['-R', 'u+rwX,go=rX', stage])
  else await exec(windowsTool('icacls.exe'), [stage, '/reset', '/T', '/Q'], { windowsHide: true })
  await exec(join(stage, nodeName), [join(stage, 'agent', 'main.js'), '--help'], { windowsHide: true, timeout: 20_000 })
}
