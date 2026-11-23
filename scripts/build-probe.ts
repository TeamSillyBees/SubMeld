import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const npm = process.env.npm_execpath
if (!npm) throw new Error('请运行 npm run build:probe 生成安装包。')
const stage = await mkdtemp(join(tmpdir(), 'submeld-npm-'))
const output = resolve('dist/probes')
try {
  const pkg = join(stage, 'package')
  await exec(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'agent/tsconfig.build.json', '--outDir', pkg])
  for (const [from, to] of [['package.json', 'package.json'], ['package-lock.json', 'npm-shrinkwrap.json'], ['README.md', 'README.md']]) {
    await copyFile(join('agent', from), join(pkg, to))
  }
  const { stdout } = await exec(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', stage], { cwd: pkg, windowsHide: true })
  const [{ filename }] = JSON.parse(stdout) as { filename: string }[]
  await mkdir(output, { recursive: true })
  const temporary = join(output, filename + '.' + process.pid + '.tmp')
  try {
    await copyFile(join(stage, filename), temporary)
    await rename(temporary, join(output, 'submeld-quality-probe.tgz'))
  } finally { await rm(temporary, { force: true }) }
  for (const os of ['windows', 'linux']) await rm(join(output, 'submeld-probe-' + os + '.zip'), { force: true })
  console.log('已生成 dist/probes/submeld-quality-probe.tgz。')
} finally { await rm(stage, { recursive: true, force: true }) }
