import type { Draft, Group, GroupMember, NodeView, Pool, ProjectedMember } from '../shared/model.ts'
import { asError } from './errors.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpDown, Check, ChevronDown, Copy, Ellipsis, Layers3, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { builtins, groupTypes, regionalAutoGroups, regionLabel, standardGroups } from '../shared/catalog.ts'
import { compilePoolFilter, membersForSources, memberSourceIds, poolCondition } from '../shared/group-filter.ts'
import { GroupFilter } from './group-filter.tsx'
import { groupReferences, nodeKey } from '../shared/config.ts'
import { useConfirm, useUnsavedChanges } from './confirm.tsx'
import { projection, useProject, useSearchValue } from './project.tsx'
import { Alert, Badge, Button, CheckOption, Disclosure, DragHandle, Empty, Field, FieldGroup, FieldLegend, FieldSet, IconButton, Input, Modal, MoveButtons, NativeSelect, NativeSelectOption, OutletSelect, Pager, Panel, RouteLink, SearchBox, Segmented, Toggle, dragProps, formatNumber, moveAt, newId, searchable, useListPage, usePage } from './ui.tsx'

type TemplateGroup = Pick<Group, 'name' | 'type' | 'members'> & Partial<Group>

const newGroup = (): Group => ({
  id: newId(), name: '', type: 'select', enabled: true, members: [], testUrl: '',
  seconds: 300, tolerance: 50, strategy: 'consistent-hashing', lazy: true, disableUdp: false,
})
function outletMember(id: string): GroupMember {
  return Object.hasOwn(builtins, id)
    ? { kind: 'builtin', id: id as Extract<GroupMember, { kind: 'builtin' }>['id'] }
    : { kind: 'group', id }
}
const firstPool = (members: GroupMember[]) => members.findIndex(member => member.kind === 'pool')

function memberName(member: GroupMember, draft: Draft, nodeNames: Map<string, string>) {
  if (member.kind === 'node') return nodeNames.get(nodeKey(member.sourceId, member.id)) ?? '已移除的节点'
  if (member.kind === 'group') return draft.groups.find(group => group.id === member.id)?.name ?? '已删除的代理组'
  if (member.kind === 'builtin') return member.id
  const ids = memberSourceIds(member)
  return [
    ids.length ? draft.sources.filter(source => ids.includes(source.id)).map(source => source.name).join('、') : '全部来源',
    member.regions.length ? member.regions.map(regionLabel).join('、') : '全部地区',
    member.includeRegex && '包含 /' + member.includeRegex + '/',
    member.excludeRegex && '排除 /' + member.excludeRegex + '/',
  ].filter(Boolean).join(' · ')
}

const memberType = { pool: '动态筛选', node: '节点', group: '代理组', builtin: '内置策略' }

function memberSummary(members: ProjectedMember[]) {
  const counts = { node: 0, group: 0, builtin: 0 }
  for (const member of members) counts[member.kind]++
  return Object.entries(counts).filter(([, count]) => count)
    .map(([kind, count]) => formatNumber(count) + ' 个' + memberType[kind as keyof typeof memberType]).join(' · ') || '0 项'
}

function GroupEditor({ group, onClose, inline, onCopy, onRemove, onDirtyChange }: { onCopy?: () => void; onRemove?: () => void; onDirtyChange?: (dirty: boolean) => void } & ({ inline: true; group: Group; onClose?: never } | { inline?: false; group?: Group; onClose: (id?: string) => void })) {
  const { state, view, save } = useProject()
  const [original, setOriginal] = useState(() => group ?? newGroup())
  const [revision, setRevision] = useState(state.revision)
  const [form, setForm] = useState(() => structuredClone(original))
  const [sorting, setSorting] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [picker, setPicker] = useState('pool')
  const [poolIndex, setPoolIndex] = useState(() => firstPool(original.members))
  const filterHeading = useRef<HTMLHeadingElement>(null)
  const pool = form.members[poolIndex]?.kind === 'pool' ? form.members[poolIndex] : null
  const [nodeSource, setNodeSource] = useState('')
  const [query, setQuery] = useState('')
  const [targetId, setTargetId] = useState('')
  const [problem, setProblem] = useState('')
  const [nameError, setNameError] = useState('')
  const [busy, setBusy] = useState(false)
  const groupName = useRef<HTMLInputElement>(null)
  const orderList = useRef<HTMLOListElement>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(original)
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    if (inline && group && !dirty && state.revision !== revision) {
      setOriginal(group)
      setForm(structuredClone(group))
      setPoolIndex(firstPool(group.members))
      setRevision(state.revision)
    }
  }, [inline, dirty, state.revision, revision, group])
  const guard = useUnsavedChanges(dirty, '此代理组会恢复为上次保存的配置。')
  const draft = useMemo(() => ({
    ...state.draft,
    groups: group ? state.draft.groups.map(item => item.id === group.id ? form : item) : [...state.draft.groups, form],
  }), [form, group?.id, state.draft])
  const computed = useMemo(() => projection(draft, state), [draft, state])
  const members = computed.groups.find(item => item.id === form.id)?.members ?? []
  const nodeNames = useMemo(() => new Map(view.nodes.map(node => [node.key, node.name])), [view.nodes])
  const issues = computed.issues.filter(issue => issue.pane === 'groups' && issue.id === form.id)
  const matched = view.nodes.filter(node => node.kept && (!nodeSource || node.sourceId === nodeSource) && (searchable(node.name, query) || searchable(node.sourceName, query) || searchable(regionLabel(node.region), query)))
  const [offset, setOffset] = usePage(matched.length, 20)
  const [previewOffset, setPreviewOffset] = usePage(members.length, 25)
  const refs = group && form.name.trim() !== group.name ? groupReferences(state.draft, group.id) : []
  const update = <K extends keyof Group>(key: K, value: Group[K]) => setForm(previous => ({ ...previous, [key]: value }))
  function setMembers(next: GroupMember[], active = pool) {
    update('members', next)
    setPoolIndex(active ? next.indexOf(active) : -1)
  }
  const move = (from: number, to: number) => setMembers(moveAt(form.members, from, to))
  function moveWithButton(from: number, to: number) {
    move(from, to)
    requestAnimationFrame(() => {
      const row = orderList.current?.children[to]
      const button = row?.querySelectorAll<HTMLButtonElement>('.moves button')[to < from ? 0 : 1]
      if (button?.disabled && row instanceof HTMLElement) row.focus()
      else button?.focus()
    })
  }
  function removeKinds(...kinds: GroupMember['kind'][]) {
    setMembers(form.members.filter(item => !kinds.includes(item.kind)))
    setBulkOpen(false)
  }
  function editFilter(index: number) {
    setPicker('pool')
    setPoolIndex(index)
    requestAnimationFrame(() => filterHeading.current?.focus())
  }
  function updateFilter(value: Pool) {
    const condition = poolCondition(value)
    const next = pool ? form.members.map((entry, i) => i === poolIndex ? condition : entry) : [...form.members, condition]
    setMembers(next, condition)
  }
  const close = () => { if (!busy && onClose) return guard.close(() => onClose()) }
  const append = (member: GroupMember) => {
    if (!form.members.some(entry => JSON.stringify(entry) === JSON.stringify(member))) setMembers([...form.members, member])
  }
  function selectNode(node: NodeView, selected: boolean) {
    if (selected) append({ kind: 'node', sourceId: node.sourceId, id: node.id })
    else setMembers(form.members.filter(member => !(member.kind === 'node' && member.sourceId === node.sourceId && member.id === node.id)))
  }
  async function commit() {
    setProblem('')
    if (!form.name.trim()) { setNameError('请填写组名。'); groupName.current?.focus(); return }
    const invalid = issues.find(issue => ['group-structure', 'group-filter'].includes(issue.code))
    if (invalid) { setProblem(invalid.message); return }
    setBusy(true)
    try {
      const next = await save(draft, revision)
      if (inline) {
        const saved = next.draft.groups.find(item => item.id === group.id) ?? form
        setOriginal(saved)
        setForm(structuredClone(saved))
        setRevision(next.revision)
      } else guard.leave(() => onClose(form.id))
    }
    catch (cause) { const error = asError(cause); setProblem(error.message) }
    finally { setBusy(false) }
  }
  const groups = state.draft.groups.filter(item => item.id !== form.id)
  function replaceMember(index: number, member: GroupMember) {
    setMembers(form.members.map((entry, i) => i === index ? member : entry))
  }
  const content = <div className="stack group-fields" inert={busy}>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <FieldGroup className="form-grid"><Field label="代理组名称" name="group_name" error={nameError}><Input ref={groupName} value={form.name} maxLength={256} onChange={event => {
        update('name', event.target.value)
        setNameError('')
      }} placeholder="例如 开发工具…" /></Field>
        <Field label="代理组类型" hint={groupTypes[form.type][1]}><NativeSelect value={form.type} onChange={event => update('type', event.target.value as Group['type'])}>
          {Object.entries(groupTypes).map(([key, [label]]) => <NativeSelectOption value={key} key={key}>{label}（{key}）</NativeSelectOption>)}
        </NativeSelect></Field></FieldGroup>
      <Toggle label="启用代理组" detail="停用组不会出现在成品中。请先处理启用的引用。" checked={form.enabled} onChange={value => update('enabled', value)} />
      {refs.length > 0 && <p className="muted field-note">保存后会同步更新 {formatNumber(refs.length)} 处引用的显示名称。</p>}
      <section className="member-config" aria-label="添加组内代理">
        <div className="stack tight">
          <Segmented label="添加方式" items={ [['pool', '动态筛选'], ['node', '指定节点'], ['group', '代理组与内置策略']] } value={picker} onChange={setPicker} />
          {picker === 'pool' && <GroupFilter member={pool} index={poolIndex} sources={state.draft.sources} nodes={view.nodes}
            headingRef={filterHeading} onNew={() => editFilter(-1)} onChange={updateFilter} />}
          {picker === 'node' && <>
            <div className="filters"><SearchBox value={query} placeholder="搜索保留节点" onChange={value => { setQuery(value); setOffset(0) }} />
              <NativeSelect aria-label="节点来源" value={nodeSource} onChange={event => { setNodeSource(event.target.value); setOffset(0) }}><NativeSelectOption value="">全部订阅源</NativeSelectOption>
                {state.draft.sources.map(source => <NativeSelectOption key={source.id} value={source.id}>{source.name}</NativeSelectOption>)}</NativeSelect></div>
            {matched.length ? <FieldSet><FieldLegend className="sr-only">选择保留节点</FieldLegend><div className="member-options">{matched.slice(offset, offset + 20).map(node => <CheckOption key={node.key}
              checked={form.members.some(member => member.kind === 'node' && member.id === node.id && member.sourceId === node.sourceId)}
              onCheckedChange={checked => selectNode(node, checked)}><span><span translate="no">{node.name}</span><small>{node.sourceName} / {regionLabel(node.region)}</small></span>
            </CheckOption>)}</div></FieldSet> : <p className="muted">没有符合查询的保留节点。</p>}
            {matched.length > 20 && <Pager offset={offset} pageSize={20} count={matched.length} onChange={setOffset} />}
          </>}
          {picker === 'group' && <div className="actions input-actions"><OutletSelect value={targetId} onChange={setTargetId} groups={groups} label="选择代理组或内置策略" />
            <Button icon={Plus} disabled={!targetId} onClick={() => {
              append(outletMember(targetId))
              setTargetId('')
            }}>添加</Button></div>}
        </div>
      </section>
      <section className="member-section stack tight" aria-label="组内代理">
        <div className="between flex-wrap"><h3>组内代理</h3>
          <div className="actions member-bulk">
            {JSON.stringify(form.members) !== JSON.stringify(original.members) && <IconButton size="icon-sm" icon={RotateCcw} label="撤销列表修改" onClick={() => {
              const restored = structuredClone(original.members)
              setMembers(restored, restored.find(member => member.kind === 'pool') ?? null)
            }} />}
            {form.members.length > 1 && <Button size="small" variant={sorting ? 'secondary' : 'ghost'} icon={ArrowUpDown}
              aria-pressed={sorting} onClick={() => setSorting(!sorting)}>排序</Button>}
            {form.members.some(item => item.kind !== 'builtin') && <Popover open={bulkOpen} onOpenChange={setBulkOpen}>
              <PopoverTrigger asChild><IconButton size="icon-sm" icon={Ellipsis} label="批量移除" /></PopoverTrigger>
              <PopoverContent align="end" className="member-bulk-menu" aria-label="批量移除">
                <Button size="small" variant="ghost" disabled={!form.members.some(item => item.kind === 'pool' || item.kind === 'node')}
                  onClick={() => removeKinds('node', 'pool')}>移除节点与筛选</Button>
                <Button size="small" variant="ghost" disabled={!form.members.some(item => item.kind === 'group')}
                  onClick={() => removeKinds('group')}>移除引用的代理组</Button>
              </PopoverContent>
            </Popover>}
          </div>
        </div>
        {form.members.length ? <ol ref={orderList} className="member-order" aria-label="代理顺序">{form.members.map((member, index) => {
          const name = memberName(member, draft, nodeNames)
          return <li key={index} tabIndex={-1} data-sort-row {...dragProps(index, move, 'member')}>
            <DragHandle index={index} area="member" />
            <div className="member-info">
              {member.kind === 'group' || member.kind === 'builtin'
                ? <OutletSelect className="member-target" size="sm" value={member.id} groups={groups} label={'替换第 ' + (index + 1) + ' 项代理'} title={name}
                    onChange={id => { if (id) replaceMember(index, outletMember(id)) }} />
                : member.kind === 'pool'
                  ? <Button size="small" variant="ghost" className="member-edit" aria-label={'编辑筛选 · ' + name} title={name} onClick={() => editFilter(index)}>
                      <span>{name}</span><Pencil data-icon="inline-end" aria-hidden="true" />
                    </Button>
                  : <span className="member-name" title={name} translate="no">{name}</span>}
              <small className="member-kind">{memberType[member.kind]}</small>
            </div>
            <div className="member-actions">{sorting && form.members.length > 1
              ? <MoveButtons index={index} count={form.members.length} onMove={moveWithButton} drag={false} />
              : <IconButton size="icon-sm" icon={X} label={'移除第 ' + (index + 1) + ' 项 · ' + name} onClick={() => setMembers(form.members.filter((_, i) => index !== i))} />}
            </div>
          </li>
        })}</ol> : <p className="muted">可添加节点、代理组或内置策略。</p>}
        {(form.members.length > 0 || group) && <Disclosure compact title={<span className="member-preview-heading">预览代理列表 <span className="member-counts">{memberSummary(members)}</span></span>}>
          {members.length ? <ol className="compact-list preview-members" start={previewOffset + 1}>{members.slice(previewOffset, previewOffset + 25).map((member, i) => <li key={member.key} value={previewOffset + i + 1}>{member.name}</li>)}</ol>
            : <p className="muted">暂无可用代理。</p>}
          {members.length > 25 && <Pager offset={previewOffset} pageSize={25} count={members.length} onChange={setPreviewOffset} />}
        </Disclosure>}
        {issues.filter(issue => issue.code !== 'group-empty' || form.members.length || group).map((issue, index) =>
          <Alert tone={issue.code === 'group-empty' ? 'warning' : 'danger'} key={index}>{issue.message}</Alert>)}
      </section>
      <Disclosure title="高级组参数"><FieldGroup>
        {form.type !== 'select' && <>
          <FieldGroup className="form-grid">
            <Field label="健康检查地址"><Input type="url" spellCheck={false} placeholder="https://cp.cloudflare.com/generate_204…" value={form.testUrl} onChange={event => update('testUrl', event.target.value)} /></Field>
            <Field label="健康检查间隔（秒）"><Input type="number" min="10" max="86400" value={form.seconds} onChange={event => update('seconds', Number(event.target.value))} /></Field>
            {form.type === 'url-test' && <Field label="切换容差（毫秒）"><Input type="number" min="0" max="60000" value={form.tolerance ?? ''} placeholder="使用客户端默认值" onChange={event => update('tolerance', event.target.value === '' ? null : Number(event.target.value))} /></Field>}
            {form.type === 'load-balance' && <Field label="分配策略"><NativeSelect value={form.strategy} onChange={event => update('strategy', event.target.value as Group['strategy'])}>
              <NativeSelectOption value="consistent-hashing">一致性哈希</NativeSelectOption><NativeSelectOption value="round-robin">轮询</NativeSelectOption><NativeSelectOption value="sticky-sessions">会话保持</NativeSelectOption>
            </NativeSelect></Field>}
          </FieldGroup>
          <Toggle label="仅在使用此组时进行健康检查" checked={form.lazy} onChange={value => update('lazy', value)} />
        </>}
        <Toggle label="禁用此组的 UDP 转发" checked={form.disableUdp} onChange={value => update('disableUdp', value)} />
      </FieldGroup></Disclosure>
    </div>
  const saveAction = <Button variant="primary" size={inline ? 'small' : 'default'} icon={Check} disabled={(inline && !dirty) || issues.some(issue => issue.code === 'group-filter')} busy={busy} onClick={commit}>保存代理组</Button>
  if (inline) return <Panel className="group-detail" title={<>{group.name} <code className="tech-chip">{form.type}</code> <Badge tone="success">{formatNumber(members.length)} 项代理</Badge></>}
    actions={<>
      {dirty ? <><Button size="small" onClick={() => { setForm(structuredClone(original)); setPoolIndex(firstPool(original.members)); setProblem(''); setNameError('') }}>撤销更改</Button>{saveAction}</>
        : <><Button size="small" icon={Copy} onClick={onCopy}>复制</Button><IconButton icon={Trash2} className="delete-action" label={'删除代理组 ' + group.name} onClick={onRemove} /></>}
    </>}>{content}</Panel>
  return <Modal wide title="新建代理组" onClose={close} footer={<><Button variant="ghost" onClick={close}>取消</Button>{saveAction}</>}>{content}</Modal>
}

function cloneGroups(input: TemplateGroup[], draft: Draft): Group[] {
  const idMap = new Map(input.filter(group => group.id).map(group => [group.id, newId()]))
  const names = new Set(draft.groups.map(group => group.name))
  const sourceIds = new Set(draft.sources.map(source => source.id))
  const groupIds = new Set(draft.groups.map(group => group.id))
  return input.map(item => {
    let name = item.name
    let index = 2
    while (names.has(name)) name = item.name + ' ' + index++
    names.add(name)
    return {
      ...newGroup(), ...item, id: idMap.get(item.id) ?? newId(), name,
      members: membersForSources(item.members, sourceIds).flatMap<GroupMember>(member => {
        if (member.kind === 'group') {
          const id = idMap.get(member.id) ?? (groupIds.has(member.id) ? member.id : null)
          return id ? [{ ...member, id }] : []
        }
        return [member]
      }),
    }
  })
}

function RegionalGroupPicker({ nodes, busy, onImport }: { nodes: NodeView[]; busy: boolean; onImport: (groups: TemplateGroup[]) => void }) {
  const options = useMemo(() => regionalAutoGroups.map(group => {
    const filter = compilePoolFilter(group.members[0])
    return { group, count: nodes.filter(filter.matches).length }
  }), [nodes])
  const [selected, setSelected] = useState(() => options.filter(option => option.count > 0).map(option => option.group))
  const chosen = options.filter(({ group }) => selected.includes(group))
  return <FieldSet className="regional-group-picker" disabled={busy}>
    <FieldLegend variant="label">地区自动选择</FieldLegend>
    <p className="field-note muted">每个地区创建一个 <code>url-test</code> 组，匹配所有订阅源中该地区的保留节点。</p>
    <FieldGroup className="option-scroll">{options.map(({ group, count }) =>
      <CheckOption key={group.name} checked={selected.includes(group)} onCheckedChange={checked =>
        setSelected(current => checked ? [...current, group] : current.filter(item => item !== group))}>
        <span className="between w-full"><span>{group.name}</span><span className="field-note muted numeric">{formatNumber(count)} 个节点</span></span>
      </CheckOption>)}</FieldGroup>
    {chosen.some(option => option.count === 0) && <p className="field-note warning-text" role="status">所选地区中有空组。发布前请补充匹配节点或停用空组。</p>}
    <div className="actions"><Button size="small" icon={Plus} busy={busy} disabled={!chosen.length}
      onClick={() => onImport(chosen.map(option => option.group))}>{chosen.length ? '导入 ' + chosen.length + ' 个代理组' : '导入所选地区'}</Button></div>
  </FieldSet>
}

export function GroupsPage() {
  const { state, view, route, save, notify, navigate, call, applyState } = useProject()
  const confirm = useConfirm()
  const [query, setQuery] = useSearchValue('q')
  const [remove, setRemove] = useState<Group | null>(null)
  const [replacement, setReplacement] = useState('')
  const [templateMenu, setTemplateMenu] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const groups = state.draft.groups
  const visible = groups.filter(group => searchable(group.name, query) || searchable(groupTypes[group.type][0], query))
  const [offset, setOffset] = useListPage(visible.length, 30)
  const selected = groups.find(group => group.id === route.id) ?? groups[0]
  const [editingDirty, setEditingDirty] = useState(false)
  const removingRefs = remove ? groupReferences(state.draft, remove.id) : []
  const obsolete = new Set(remove ? [remove.id] : [])
  if (remove) {
    const pending = [remove.id]
    while (pending.length) {
      for (const ref of groupReferences(state.draft, pending.pop()!).filter(ref => ref.pane === 'groups' && !obsolete.has(ref.id))) {
        obsolete.add(ref.id)
        pending.push(ref.id)
      }
    }
  }
  const candidateGroups = groups.filter(group => !obsolete.has(group.id))
  async function run(action: () => unknown) {
    setBusy(true)
    try { await action() } catch (cause) { const error = asError(cause); notify(error.message, 'danger') } finally { setBusy(false) }
  }
  const updateGroups = (next: Group[]) => save({ ...state.draft, groups: next })
  const move = (from: number, to: number) => run(() => updateGroups(moveAt(groups, from, to)))
  const importTemplate = (entries: TemplateGroup[]) => run(async () => {
    await updateGroups([...groups, ...cloneGroups(entries, state.draft)])
    setTemplateMenu(null)
    notify('已添加 ' + entries.length + ' 个代理组')
  })
  function commitDelete() {
    if (!remove) return
    return run(async () => {
      const successor = outletMember(replacement)
      await save({
        ...state.draft,
        groups: groups.filter(group => group.id !== remove.id).map(group => ({
          ...group, members: group.members.map(member => member.kind === 'group' && member.id === remove.id ? successor : member),
        })),
        services: state.draft.services.map(service => service.target === remove.id ? { ...service, target: replacement } : service),
      })
      setRemove(null)
      if (route.id === remove.id) void navigate('groups')
    })
  }
  return <div className="stack config-page">
    <h1 className="sr-only" tabIndex={-1}>代理组</h1>
    <Panel title="代理组编排" count={formatNumber(groups.length)} actions={<>
      <Button size="small" icon={Layers3} disabled={editingDirty || busy} onClick={() => setTemplateMenu('library')}>组模板</Button>
      <Button icon={Plus} size="small" variant="primary" onClick={() => navigate('groups', 'new')}>新建代理组</Button>
    </>}>
      <div className="config-toolbar"><div className="template-strip"><Layers3 aria-hidden="true" /><span>常用组模板</span>
        <Button size="small" icon={Plus} disabled={editingDirty || busy} onClick={() => importTemplate(standardGroups)}>手动选择 + 自动选择</Button>
        <Popover open={templateMenu === 'regions'} onOpenChange={open => setTemplateMenu(open ? 'regions' : null)}>
          <PopoverTrigger asChild><Button size="small" disabled={editingDirty || busy}>地区自动选择<ChevronDown data-icon="inline-end" aria-hidden="true" /></Button></PopoverTrigger>
          <PopoverContent align="start" className="option-popover" aria-label="地区自动选择">
            <RegionalGroupPicker nodes={view.nodes} busy={busy} onImport={importTemplate} />
          </PopoverContent>
        </Popover>
        {state.library.groups.slice(0, 3).map(template => <Button key={template.id} size="small" icon={Plus} disabled={editingDirty || busy} onClick={() => importTemplate(template.groups)}>{template.name}</Button>)}</div></div>
    </Panel>
    <div className="group-workspace">
      <Panel className="group-master" title="代理组" count={formatNumber(groups.length)}>
        {groups.length > 0 && <div className="group-search"><SearchBox value={query} onChange={value => { setQuery(value); setOffset(0) }} placeholder="搜索组名或类型" /></div>}
        {!visible.length ? <Empty icon={Layers3} title={groups.length ? '没有匹配的代理组' : '还没有代理组'}
          actions={groups.length > 0 && <Button onClick={() => { setQuery(''); setOffset(0) }}>清除筛选</Button>} />
          : <><ul className="group-menu">{visible.slice(offset, offset + 30).map(group => {
            const index = groups.indexOf(group)
            const members = view.groups.find(item => item.id === group.id)?.members ?? []
            const refs = groupReferences(state.draft, group.id).length
            return <li key={group.id} data-selected={selected?.id === group.id} data-sort-row {...(!editingDirty && dragProps(index, move, 'group'))}>
              <div className="group-menu-main">
                <span className="group-identity"><RouteLink page="groups" id={group.id} aria-current={selected?.id === group.id ? 'true' : undefined}>{group.name}</RouteLink><code className="tech-chip">{group.type}</code></span>
                <span className="group-facts"><span className="soft-count">{formatNumber(members.length)} 项代理</span>{refs > 0 && <span>{refs} 处引用</span>}{!group.enabled && <span>已停用</span>}</span>
              </div>
              <div className="row-actions" inert={editingDirty || busy}><MoveButtons index={index} count={groups.length} onMove={move} area="group" /></div>
            </li>
          })}</ul>{visible.length > 30 && <Pager offset={offset} pageSize={30} count={visible.length} onChange={setOffset} />}</>}
      </Panel>
      {selected && route.id !== 'new' ? <GroupEditor key={selected.id} inline group={selected} onDirtyChange={setEditingDirty}
        onCopy={() => run(() => updateGroups([...groups, ...cloneGroups([selected], state.draft)]))}
        onRemove={() => { setReplacement(''); setRemove(selected) }} />
        : <Panel title="组内代理"><Empty icon={Layers3} title={groups.length ? '正在创建代理组' : '创建第一个代理组'} detail={!groups.length && '可以按来源、地区和正则筛选节点，也可以点选节点或引用其他代理组。'} /></Panel>}
    </div>
    {route.id === 'new' && <GroupEditor key="new" onClose={id => navigate('groups', id)} />}
    {remove && <Modal title={'删除代理组 · ' + remove.name} detail="下次发布时，订阅将移除这个代理组。" onClose={() => setRemove(null)}
      footer={<><Button onClick={() => setRemove(null)}>取消</Button><Button variant="danger" busy={busy} disabled={removingRefs.length > 0 && !replacement} onClick={commitDelete}>{removingRefs.length ? '迁移并删除' : '确认删除'}</Button></>}>
      {removingRefs.length ? <div className="stack">
        <Alert tone="warning">此组仍有 {removingRefs.length} 处引用。可打开相关项目单独调整，或选择替代策略后批量迁移。</Alert>
        <ul className="compact-list">{removingRefs.map(ref => <li key={ref.id}><RouteLink className="text-link" page={ref.pane} id={ref.id} onClick={() => setRemove(null)}>{ref.name}（{ref.pane === 'groups' ? '代理组' : '路由规则'}）</RouteLink></li>)}</ul>
        <Field label="替代策略"><OutletSelect label="替代策略" groups={candidateGroups} value={replacement} onChange={setReplacement} /></Field>
      </div> : <p>此代理组没有其他规则或分组引用。</p>}
    </Modal>}
    {templateMenu === 'library' && <Modal title="代理组模板" detail="导入后可自由编辑、停用及删除。跨方案套用时，仅保留可用的来源与组引用。" onClose={() => setTemplateMenu(null)}>
      <div className="stack">
        <div className="list-option"><div><strong>常用代理组</strong><p>手动选择、自动选择</p></div><Button size="small" onClick={() => importTemplate(standardGroups)} busy={busy}>导入</Button></div>
        <RegionalGroupPicker nodes={view.nodes} busy={busy} onImport={importTemplate} />
        {state.library.groups.map(template => <div className="list-option" key={template.id}><div><strong>{template.name}</strong><p>{template.groups.length} 个代理组</p></div>
          <div className="actions"><Button size="small" onClick={() => importTemplate(template.groups)} disabled={busy}>导入</Button>
            <IconButton icon={Trash2} label={'删除模板 ' + template.name} onClick={async () => {
              if (!await confirm({ title: '删除组模板？', detail: '已导入的代理组仍可使用。此模板将从模板列表移除。', action: '删除模板', danger: true })) return
              await run(async () => {
                applyState(await call('library', { ...state.library, groups: state.library.groups.filter(item => item.id !== template.id) }))
                notify('模板已删除')
              })
            }} /></div></div>)}
        <div className="actions input-actions"><Input aria-label="组模板名称" placeholder="将当前代理组保存为模板" value={name} onChange={event => setName(event.target.value)} />
          <Button icon={Plus} disabled={!name.trim() || !groups.length} busy={busy} onClick={() => run(async () => {
            applyState(await call('library', { ...state.library, groups: [...state.library.groups, { id: newId(), name: name.trim(), groups }] }))
            setName('')
            notify('组模板已保存')
          })}>保存模板</Button></div>
      </div>
    </Modal>}
  </div>
}
