import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { downloadVerified } from '../scripts/install-core.ts'

const exec = promisify(execFile)
const windows = process.platform === 'win32'
export const serviceName = windows ? 'SubMeldProbe' : 'submeld-probe.service'
export const installDir = windows ? join(process.env.ProgramFiles!, 'SubMeld Probe') : '/opt/submeld-probe'
export const stateDir = windows ? join(process.env.ProgramData!, 'SubMeldProbe') : '/var/lib/submeld-probe'
export const runtime = join(installDir, 'runtime')
export const configFile = join(installDir, 'device.json')
export const nodeName = windows ? 'node.exe' : 'node'
export const coreName = windows ? 'mihomo.exe' : 'mihomo'
const wrapper = join(installDir, 'SubMeldProbe.exe')
const unit = '/etc/systemd/system/submeld-probe.service'
const winSW = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe'
const winSWHash = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f'

async function command(file: string, args: string[]) {
  const { stdout } = await exec(file, args, { windowsHide: true, timeout: 45_000 })
  return stdout.trim()
}
export const windowsTool = (name: string) => join(process.env.SystemRoot!, 'System32', name)
const powershell = () => windowsTool('WindowsPowerShell/v1.0/powershell.exe')
const ps = (script: string) => command(powershell(), ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script])
export async function requireAdmin() {
  if (windows) {
    const admin = await ps('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)')
    if (admin !== 'True') throw new Error('安装和卸载 Windows 服务需要管理员权限。请在管理员 PowerShell 中运行此命令。')
  } else if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('系统级探针服务需要 Linux systemd 和 root 权限，请使用 sudo。')
}
export async function exists(path: string) {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export async function atomicWrite(path: string, value: string, mode: number) {
  const tmp = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(tmp, value, { flag: 'wx', mode })
    await rename(tmp, path)
  } finally { await rm(tmp, { force: true }) }
}
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export function windowsConfig(home: string, state: string) {
  const bin = join(home, 'runtime')
  return [
    '<service>', '  <id>SubMeldProbe</id>', '  <name>SubMeld PC Probe</name>',
    '  <description>SubMeld 节点质量检测探针</description>',
    '  <executable>' + xml(join(bin, 'node.exe')) + '</executable>',
    '  <arguments>"' + xml(join(bin, 'agent', 'main.js')) + '" run</arguments>',
    '  <workingdirectory>' + xml(state) + '</workingdirectory>',
    '  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>',
    '  <startmode>Automatic</startmode>', '  <delayedAutoStart>true</delayedAutoStart>',
    '  <onfailure action="restart" delay="15 sec"/>', '  <stoptimeout>20 sec</stoptimeout>', '  <stopparentprocessfirst>true</stopparentprocessfirst>',
    '  <logpath>' + xml(join(state, 'logs')) + '</logpath>',
    '  <log mode="roll-by-size"><sizeThreshold>2048</sizeThreshold><keepFiles>3</keepFiles></log>',
    '  <env name="STATE_DIRECTORY" value="' + xml(state) + '"/>',
    '  <env name="TEMP" value="' + xml(join(state, 'temp')) + '"/>',
    '  <env name="TMP" value="' + xml(join(state, 'temp')) + '"/>', '</service>', '',
  ].join('\n')
}
export const linuxUnit = `[Unit]
Description=SubMeld PC Probe
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
DynamicUser=yes
StateDirectory=submeld-probe
StateDirectoryMode=0700
WorkingDirectory=/var/lib/submeld-probe
LoadCredential=device.json:/opt/submeld-probe/device.json
ExecStart=/opt/submeld-probe/runtime/node /opt/submeld-probe/runtime/agent/main.js run
Restart=on-failure
RestartSec=15s
TimeoutStopSec=25s
KillMode=mixed
PrivateTmp=yes
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=multi-user.target
`
export async function serviceStatus() {
  if (windows) {
    const data = await ps("$s = Get-CimInstance Win32_Service -Filter \"Name='SubMeldProbe'\"; if ($s) { $s | Select-Object State,StartMode,PathName | ConvertTo-Json -Compress }")
    if (!data) return { installed: false, running: false, automatic: false }
    const s = JSON.parse(data) as { State: string; StartMode: string; PathName: string }
    if (s.PathName.replace(/^"|"$/g, '').toLowerCase() !== wrapper.toLowerCase()) throw new Error('同名 Windows 服务已指向其他程序。')
    return { installed: true, running: s.State === 'Running', automatic: s.StartMode === 'Auto' }
  }
  const info = await command('systemctl', ['show', serviceName, '--property=LoadState,ActiveState,FragmentPath,UnitFileState'])
  const fields = Object.fromEntries(info.split('\n').map(line => line.split('=')))
  if (fields.LoadState === 'not-found') return { installed: false, running: false, automatic: false }
  if (fields.FragmentPath !== unit) throw new Error('同名 systemd 服务已指向其他单元文件。')
  return { installed: true, running: fields.ActiveState === 'active', automatic: fields.UnitFileState === 'enabled' }
}
const marker = join(installDir, '.submeld-probe')
async function protectDirectory(directory: string, access: 'read' | 'modify') {
  const literal = "'" + directory.replaceAll("'", "''") + "'"
  const rights = access === 'modify' ? '0x1301bf' : '0x1200a9'
  const dacl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;' + rights + ';;;LS)'
  await ps([
    '$acl = Get-Acl -LiteralPath ' + literal,
    '$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value',
    '$admin = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "if ($owner -notin @('S-1-5-18','S-1-5-32-544',$admin)) { throw 'Unexpected probe directory owner' }",
    '$permissions = New-Object Security.AccessControl.DirectorySecurity',
    "$permissions.SetSecurityDescriptorSddlForm('" + dacl + "', [Security.AccessControl.AccessControlSections]::Access)",
    '[IO.Directory]::SetAccessControl(' + literal + ', $permissions)',
  ].join('; '))
}
export async function ensureInstallDirectory() {
  if (await exists(installDir)) {
    if (!(await lstat(installDir)).isDirectory() || !await exists(marker)) throw new Error('安装目录已存在且不属于探针：' + installDir)
  } else {
    await mkdir(installDir, { mode: 0o755 })
    await writeFile(marker, 'SubMeld PC Probe\n', { flag: 'wx', mode: 0o644 })
  }
  if (!windows) await chmod(installDir, 0o755)
  if (windows) {
    await protectDirectory(installDir, 'read')
    await mkdir(stateDir, { recursive: true })
    if (!(await lstat(stateDir)).isDirectory()) throw new Error('探针数据路径不是目录。')
    await protectDirectory(stateDir, 'modify')
    for (const name of ['temp', 'logs']) {
      const child = join(stateDir, name)
      await mkdir(child, { recursive: true })
      if (!(await lstat(child)).isDirectory()) throw new Error('探针数据子目录无效。')
    }
  }
}
export async function cleanWorkerTemp(state: string) {
  if (!windows) return
  const directory = join(state, 'temp')
  if (!(await lstat(directory)).isDirectory()) throw new Error('探针临时目录无效。')
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^submeld-probe-[a-zA-Z0-9]{6}$/.test(entry.name)) await rm(join(directory, entry.name), { recursive: true, force: true })
  }
}
export async function prepareHost() {
  if (!windows) return
  if (await exists(wrapper)) {
    if (createHash('sha256').update(await readFile(wrapper)).digest('hex') !== winSWHash) throw new Error('Windows 服务宿主校验失败。')
  } else {
    const tmp = wrapper + '.' + randomUUID() + '.tmp'
    try {
      await downloadVerified(winSW, tmp, winSWHash)
      await rename(tmp, wrapper)
    } finally { await rm(tmp, { force: true }) }
  }
  await atomicWrite(join(installDir, 'SubMeldProbe.xml'), windowsConfig(installDir, stateDir), 0o644)
}
export async function activate(installed: boolean) {
  if (windows) {
    if (!installed) await command(wrapper, ['install'])
    else await command(windowsTool('sc.exe'), ['config', serviceName, 'start=', 'delayed-auto'])
    await command(wrapper, ['start'])
  } else {
    await atomicWrite(unit, linuxUnit, 0o644)
    await command('systemctl', ['daemon-reload'])
    await command('systemctl', ['enable', '--now', serviceName])
  }
}
export async function stopService() {
  if (windows) await command(wrapper, ['stop'])
  else await command('systemctl', ['stop', serviceName])
}
export async function removeService(running: boolean) {
  if (windows) {
    if (running) await stopService()
    await command(wrapper, ['uninstall'])
  } else {
    await command('systemctl', ['disable', '--now', serviceName])
    await rm(unit, { force: true })
    await command('systemctl', ['daemon-reload'])
  }
}
