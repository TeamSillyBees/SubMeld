import { useEffect, useState } from 'react'
import { Copy, Download } from 'lucide-react'
import type { DevicePairing, ProbeDevice } from '../shared/quality.ts'
import { Button as ButtonRoot } from '@/components/ui/button'
import { asError } from './errors.ts'
import { useProject } from './project.tsx'
import { Alert, Button, Disclosure, Field, Input, NativeSelect, NativeSelectOption, copyText, formatTime } from './ui.tsx'

export function ProbeSetup({ device, waiting, refresh }: { device: ProbeDevice | null; waiting: boolean; refresh: () => void }) {
  const { call, pathFor, notify } = useProject()
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [platform, setPlatform] = useState(navigator.userAgent.includes('Windows') ? 'windows' : 'linux')
  const [invite, setInvite] = useState<DevicePairing | null>(null)
  const [manual, setManual] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const prefix = platform === 'linux' ? 'sudo ' : ''
  useEffect(() => { if (device) { setInvite(null); setManual(false) } }, [device?.name, device?.platform])
  async function copy() {
    setBusy(true); setError('')
    try {
      const next = invite && Date.parse(invite.expiresAt) > Date.now() ? invite : await call('quality/invite', {})
      setInvite(next)
      try { await copyText(next.pairing); setManual(false); notify('电脑配对链接已复制') } catch { setManual(true) }
    } catch (cause) { setError(asError(cause).message) } finally { setBusy(false) }
  }
  async function revoke() {
    setBusy(true); setError('')
    try { await call('quality/revoke', {}); setConfirm(false); setInvite(null); refresh(); notify('电脑配对已解除') }
    catch (cause) { setError(asError(cause).message) } finally { setBusy(false) }
  }
  return <Disclosure title={device ? '常驻探针 · ' + device.name + ' · ' + (device.online ? '在线' : '离线') : '安装并配对常驻探针'}
    open={expanded ?? (waiting && !device)} onOpenChange={setExpanded}>
    {error && <Alert tone="danger">{error}</Alert>}
    {device ? <div className="quality-device">
      <p>{device.platform === 'windows' ? 'Windows 服务' : 'Linux systemd 服务'} · 最近联系 {formatTime(device.lastSeen)}</p>
      {confirm ? <><p>解除后，这台电脑将停止领取任务，当前待领取或执行中的常驻任务会取消。</p>
        <div className="actions"><Button size="small" busy={busy} onClick={revoke}>确认解除配对</Button>
          <Button size="small" variant="ghost" onClick={() => setConfirm(false)}>保留配对</Button></div></> :
        <Button size="small" variant="ghost" onClick={() => setConfirm(true)}>解除配对</Button>}
    </div> : <div className="quality-device">
      <div className="quality-downloads"><div><strong>安装到个人电脑</strong>
        <p>需要 Node.js 24+。在安装包所在目录{platform === 'windows' ? '打开管理员 PowerShell' : '打开终端'}，依次运行：</p></div>
        <NativeSelect aria-label="探针安装系统" value={platform} onChange={e => setPlatform(e.target.value)}>
          <NativeSelectOption value="windows">Windows</NativeSelectOption><NativeSelectOption value="linux">Linux</NativeSelectOption></NativeSelect></div>
      <pre className="probe-commands"><code>{prefix + 'npm install --global ./submeld-quality-probe.tgz\n' + prefix + 'submeld-probe install'}</code></pre>
      <div className="actions"><ButtonRoot variant="outline" size="sm" asChild><a download href={pathFor('quality/download')}><Download />下载 npm 安装包</a></ButtonRoot>
        <Button size="small" icon={Copy} busy={busy} onClick={copy}>复制电脑配对链接</Button></div>
      <p>{invite ? '链接有效至 ' + formatTime(invite.expiresAt) + '。' : ''}安装时粘贴配对链接。配对一次后，这台电脑会在开机后自动领取当前方案的任务。</p>
      {manual && invite && <Field label="手动复制电脑配对链接"><Input readOnly value={invite.pairing} onFocus={e => e.target.select()} /></Field>}
    </div>}
  </Disclosure>
}
