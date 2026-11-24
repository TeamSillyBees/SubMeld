import { useEffect, useState } from 'react'
import { Copy, Download } from 'lucide-react'
import type { DevicePairing, ProbeDevice } from '../shared/quality.ts'
import { Button as ButtonRoot } from '@/components/ui/button'
import { asError } from './errors.ts'
import { useProject } from './project.tsx'
import { Alert, Button, Disclosure, Field, Input, NativeSelect, NativeSelectOption, copyText, formatTime } from './ui.tsx'

export const deviceStates = { online: '在线', busy: '忙碌', offline: '离线' }
export function ProbeSetupBody({ devices, refresh, onBusyChange }: { devices: ProbeDevice[]; refresh: () => void; onBusyChange?: (busy: boolean) => void }) {
  const { call, pathFor, notify } = useProject()
  const [platform, setPlatform] = useState(navigator.userAgent.includes('Windows') ? 'windows' : 'linux')
  const [invite, setInvite] = useState<DevicePairing | null>(null)
  const [manual, setManual] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [editing, setEditing] = useState('')
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const prefix = platform === 'linux' ? 'sudo ' : ''
  useEffect(() => { setInvite(null); setManual(false) }, [devices.length])
  useEffect(() => {
    onBusyChange?.(busy)
    return () => onBusyChange?.(false)
  }, [busy, onBusyChange])
  async function copy() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const next = invite && Date.parse(invite.expiresAt) > Date.now() ? invite : await call('quality/invite', {})
      setInvite(next)
      try { await copyText(next.pairing); setManual(false); notify('电脑配对链接已复制') } catch { setManual(true) }
    } catch (cause) { setError(asError(cause).message) } finally { setBusy(false) }
  }
  async function revoke(id: string) {
    if (busy) return
    setBusy(true); setError('')
    try { await call('quality/revoke', { id }); setConfirm(''); setInvite(null); refresh(); notify('电脑配对已解除') }
    catch (cause) { setError(asError(cause).message) } finally { setBusy(false) }
  }
  async function rename(id: string) {
    if (busy) return
    setBusy(true); setError('')
    try { await call('quality/rename', { id, remark }); setEditing(''); refresh(); notify('探针备注已保存') }
    catch (cause) { setError(asError(cause).message) } finally { setBusy(false) }
  }
  return <>
    {error && <Alert tone="danger">{error}</Alert>}
    {devices.map(d => <div key={d.id} className="quality-device device-entry">
      <div><strong>{d.remark || d.name}</strong><p>{deviceStates[d.status]} · {d.platform === 'windows' ? 'Windows' : 'Linux'} · 最近心跳 {formatTime(d.lastSeenAt)}</p></div>
      {editing === d.id ? <div className="actions"><Input aria-label="探针备注名" maxLength={80} disabled={busy} value={remark} onChange={e => setRemark(e.target.value)} />
        <Button size="small" busy={busy} onClick={() => rename(d.id)}>保存备注</Button><Button size="small" variant="ghost" disabled={busy} onClick={() => setEditing('')}>取消</Button></div>
        : confirm === d.id ? <><p>解除后将取消这台探针正在执行和等待中的任务。</p><div className="actions">
          <Button size="small" busy={busy} onClick={() => revoke(d.id)}>确认解除配对</Button><Button size="small" variant="ghost" disabled={busy} onClick={() => setConfirm('')}>保留配对</Button></div></>
        : <div className="actions"><Button size="small" variant="ghost" disabled={busy} onClick={() => { setEditing(d.id); setRemark(d.remark); setConfirm('') }}>编辑备注</Button>
          <Button size="small" variant="ghost" disabled={busy} onClick={() => setConfirm(d.id)}>解除配对</Button></div>}
    </div>)}
    <div className="quality-device">
      <div className="quality-downloads"><div><strong>安装到个人电脑</strong>
        <p>需要 Node.js 24+。在安装包所在目录{platform === 'windows' ? '打开管理员 PowerShell' : '打开终端'}，依次运行：</p></div>
        <NativeSelect aria-label="探针安装系统" value={platform} onChange={e => setPlatform(e.target.value)}>
          <NativeSelectOption value="windows">Windows</NativeSelectOption><NativeSelectOption value="linux">Linux</NativeSelectOption></NativeSelect></div>
      <pre className="probe-commands"><code>{prefix + 'npm install --global ./submeld-quality-probe.tgz\n' + prefix + 'submeld-probe install'}</code></pre>
      <div className="actions"><ButtonRoot variant="outline" size="sm" asChild><a download href={pathFor('quality/download')}><Download />下载 npm 安装包</a></ButtonRoot>
        <Button size="small" icon={Copy} busy={busy} onClick={copy}>复制电脑配对链接</Button></div>
      <p>{invite ? '链接有效至 ' + formatTime(invite.expiresAt) + '。' : ''}安装时粘贴配对链接。配对后即可在下发任务时选择这台电脑。</p>
      {manual && invite && <Field label="手动复制电脑配对链接"><Input readOnly value={invite.pairing} onFocus={e => e.target.select()} /></Field>}
    </div>
  </>
}
export function ProbeSetup({ devices, refresh, onBusyChange }: { devices: ProbeDevice[]; refresh: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  return <Disclosure title={devices.length ? '管理探针与配对 · ' + devices.length + ' 台' : '安装并配对常驻探针'}
    open={expanded ?? !devices.length} onOpenChange={setExpanded}>
    <ProbeSetupBody devices={devices} refresh={refresh} onBusyChange={onBusyChange} />
  </Disclosure>
}
