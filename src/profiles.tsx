import type { ChangeProfile, ProfileAction } from './project.tsx'
export type NameAction = 'create' | 'clone' | 'rename'
import { asError } from './errors.ts'
import { useId, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Copy, PanelsTopLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useConfirm, useUnsavedChanges } from './confirm.tsx'
import { useProject } from './project.tsx'
import { Alert, Button, Field, FieldGroup, Input, Modal } from './ui.tsx'

const nameActions = {
  create: { label: '新建方案', submit: '新建方案', icon: Plus },
  clone: { label: '复制当前方案', submit: '复制方案', icon: Copy },
  rename: { label: '重命名当前方案', submit: '保存名称', icon: Pencil },
}
const profileNames = new Intl.Collator('zh-CN', { numeric: true })

export function ProfileSelector({ triggerRef, onChange, onEdit, children }: { triggerRef: React.RefObject<HTMLButtonElement | null>; onChange: ChangeProfile; onEdit: (action: NameAction) => void; children: React.ReactNode }) {
  const { state, notify } = useProject()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const afterClose = useRef<(() => void) | null>(null)
  const otherProfiles = state.profiles.filter(profile => profile.id !== state.id)
  otherProfiles.sort((a, b) => profileNames.compare(a.title, b.title))
  const profiles = [{ id: state.id, title: state.title }, ...otherProfiles]

  async function change(action: ProfileAction, id?: string) {
    if (action === 'delete' && !await confirm({
      title: '删除当前配置方案？', detail: '将删除「' + state.title + '」及其历史。此方案的私有链接会失效。', action: '删除配置方案', danger: true,
    })) return
    setBusy(true)
    try {
      const changed = await onChange(action, id)
      if (changed && action === 'delete') notify('已删除「' + state.title + '」')
    } catch (cause) { const error = asError(cause); notify(error.message, 'danger') }
    finally { setBusy(false) }
  }

  // Return focus to the selector before a name dialog or navigation guard takes it.
  function finishSelection(event: Event) {
    const selected = afterClose.current
    if (!selected) return
    afterClose.current = null
    event.preventDefault()
    triggerRef.current?.focus({ preventScroll: true })
    void selected()
  }

  return <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
    <div className="profile-toolbar">
      <label htmlFor="profile-selector" onClick={event => {
        event.preventDefault()
        if (busy) return
        triggerRef.current?.focus({ preventScroll: true })
        setOpen(true)
      }}>配置方案</label>
      {children}
    </div>
    <DropdownMenuTrigger asChild>
      <Button ref={triggerRef} id="profile-selector" className="profile-trigger" icon={PanelsTopLeft} busy={busy}
        aria-label={'切换配置方案，当前为' + state.title} title={state.title}>
        <span className="truncate">{state.title}</span><ChevronsUpDown data-icon="inline-end" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent className="profile-menu" side="top" align="start" sideOffset={6} collisionPadding={8}
      aria-labelledby="profile-selector" onCloseAutoFocus={finishSelection} loop>
      <DropdownMenuRadioGroup className="profile-options" aria-label="切换配置方案" value={state.id} onValueChange={id => {
        if (id !== state.id) afterClose.current = () => change('switch', id)
      }}>
        {profiles.map(profile => <DropdownMenuRadioItem key={profile.id} value={profile.id} textValue={profile.title}>
          <span>{profile.title}</span>
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        {Object.entries(nameActions).map(([action, { label, icon: Icon }]) => <DropdownMenuItem key={action}
          onSelect={() => { afterClose.current = () => onEdit(action as NameAction) }}>
          <Icon aria-hidden="true" />{label}
        </DropdownMenuItem>)}
        {state.profiles.length > 1 && <DropdownMenuItem variant="destructive" onSelect={() => { afterClose.current = () => change('delete') }}>
          <Trash2 aria-hidden="true" />删除当前方案
        </DropdownMenuItem>}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}

export function ProfileNameDialog({ action, onChange, onClose, returnFocusRef }: { action: NameAction; onChange: ChangeProfile; onClose: () => void; returnFocusRef: React.RefObject<HTMLButtonElement | null> }) {
  const { state, notify } = useProject()
  const { label, submit, icon } = nameActions[action]
  const [initialTitle] = useState(() => {
    if (action === 'clone') return (state.title.length <= 60 ? state.title : '配置方案') + '（副本）'
    return action === 'rename' ? state.title : ''
  })
  const [title, setTitle] = useState(initialTitle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const formId = useId()
  // The page underneath still owns the guard for leaving the current profile.
  const guard = useUnsavedChanges(title !== initialTitle, '下次需重新填写方案名称。', { guardNavigation: false })
  const valid = title.trim() && (action !== 'rename' || title.trim() !== state.title)
  const close = () => { if (!busy) void guard.close(onClose) }

  async function commit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError('')
    try {
      if (await onChange(action, title.trim())) {
        notify('配置方案已保存')
        onClose()
      }
    } catch (cause) { const error = asError(cause); setError(error.message) }
    finally { setBusy(false) }
  }

  return <Modal title={label} initialFocusRef={input} onClose={close} onCloseAutoFocus={event => {
    event.preventDefault()
    returnFocusRef.current?.focus({ preventScroll: true })
  }} detail={action === 'clone' ? '复制「' + state.title + '」已保存的配置和节点。新方案可独立发布。' : undefined} footer={<>
    <Button disabled={busy} onClick={close}>取消</Button>
    <Button variant="primary" type="submit" form={formId} icon={action === 'rename' ? Check : icon} disabled={!valid} busy={busy}>{submit}</Button>
  </>}>
    <form id={formId} onSubmit={commit}><FieldGroup>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="方案名称" name="profile_name">
        <Input ref={input} required maxLength={64} value={title} disabled={busy} onFocus={event => event.target.select()}
          onChange={event => setTitle(event.target.value)} />
      </Field>
    </FieldGroup></form>
  </Modal>
}
