import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
const binaryName = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'

const exec = promisify(execFile)
const version = 'v1.19.34'
// Checksums from the MetaCubeX release asset list.
const versions: Record<string, [string, string, string]> = {
  'win32-x64': ['windows-amd64-compatible', 'zip', 'cd6738d4648cc1a5f48049a1343b697ab510889d648f045c5c780fc1ab443a79'],
  'win32-arm64': ['windows-arm64', 'zip', '076cb04a21377675bcf009b8d1dd83006ce2464aa537e37bce1faf6d3504f554'],
  'linux-x64': ['linux-amd64-compatible', 'gz', '2763f5b414527f7baf6dc57e3f82f3ab561eedf34bfd7c2f2cde1f7e592efe06'],
  'linux-arm64': ['linux-arm64', 'gz', 'daaf78a6240a282cdfd75bcbf98fe321f6bd52765cc29e79f344191198f0b50f'],
  'darwin-x64': ['darwin-amd64-compatible', 'gz', '703bceaa494732fa456f47e6ac2f06bf0bc5593d4c927d5f61e10f1a31039c37'],
  'darwin-arm64': ['darwin-arm64', 'gz', '1a7a20eca63fbbaec90137717465bfde488d0db2a3a79b8fadebf9b2545b6e4c'],
}

export async function downloadVerified(url: string, archive: string, checksum: string) {
  let bytes: Buffer
  try {
    const curl = process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32', 'curl.exe') : 'curl'
    await exec(curl, ['--fail', '--location', '--silent', '--show-error', '--max-time', '120', '--output', archive, url], { timeout: 125000, windowsHide: true })
    bytes = await readFile(archive)
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' }).catch(() => null)
    if (!response?.ok) throw new Error('无法下载 ' + url + '，请检查到 GitHub 的网络连接。')
    bytes = Buffer.from(await response.arrayBuffer())
    await writeFile(archive, bytes)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('下载文件的 SHA-256 校验失败。')
  return bytes
}

export async function installCore(directory = resolve('bin')) {
  const release = versions[process.platform + '-' + process.arch]
  if (!release) throw new Error('此平台请手动安装 Mihomo，并设置 SUBMELD_MIHOMO_BIN。')
  const [platform, format, checksum] = release
  const target = resolve(directory, binaryName)
  const installed = await exec(target, ['-v'], { timeout: 8000, windowsHide: true }).catch(() => null)
  if (installed?.stdout.includes(version)) {
    console.log('Mihomo ' + version + ' 已就绪。')
    return
  }
  const filename = 'mihomo-' + platform + '-' + version + '.' + format
  const url = 'https://github.com/MetaCubeX/mihomo/releases/download/' + version + '/' + filename
  console.log('正在下载 Mihomo ' + version + '…')
  const temporary = await mkdtemp(join(tmpdir(), 'submeld-core-'))
  const staged = resolve(directory, randomUUID() + '-' + basename(target))
  try {
    const archive = join(temporary, filename)
    const bytes = await downloadVerified(url, archive, checksum)
    await mkdir(directory, { recursive: true })
    if (format === 'zip') {
      await exec(join(process.env.SystemRoot!, 'System32', 'tar.exe'), ['-xf', archive, '-C', temporary], { timeout: 30000, windowsHide: true })
      const file = (await readdir(temporary)).find(entry => entry.startsWith('mihomo') && entry.endsWith('.exe'))
      if (!file) throw new Error('官方压缩包中没有找到 Mihomo 可执行文件。')
      await copyFile(join(temporary, file), staged)
    } else await writeFile(staged, gunzipSync(bytes), { mode: 0o755 })
    const { stdout } = await exec(staged, ['-v'], { timeout: 8000, windowsHide: true })
    if (!stdout.includes(version)) throw new Error('Mihomo 核心版本不符。')
    await rename(staged, target)
    console.log('Mihomo ' + version + ' 已安装到 ' + target)
  } finally {
    await rm(staged, { force: true })
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) installCore().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
