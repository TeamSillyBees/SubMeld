import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { strToU8, zipSync, type Zippable } from 'fflate'

const common: Zippable = {}
for (const name of await readdir('agent')) {
  if (name.endsWith('.ts')) common['agent/' + name] = await readFile('agent/' + name)
}
for (const file of ['shared/quality.ts', 'shared/quality-options.ts', 'scripts/install-core.ts']) common[file] = await readFile(file)
for (const file of ['package.json', 'package-lock.json', 'README.md']) common[file] = await readFile('agent/' + file)
await mkdir('dist/probes', { recursive: true })
for (const os of ['windows', 'linux']) {
  const launcher = os === 'windows' ? 'start.cmd' : 'start.sh'
  const script = (await readFile('agent/' + launcher, 'utf8')).replace(/\r\n/g, '\n')
  const files: Zippable = { ...common, [launcher]: [
    strToU8(os === 'windows' ? script.replace(/\n/g, '\r\n') : script), { os: 3, attrs: 0o100755 << 16 },
  ] }
  await writeFile('dist/probes/submeld-probe-' + os + '.zip', zipSync(files, { level: 6 }))
}
console.log('Windows 与 Linux 探针已生成到 dist/probes。')
