import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Layers3, Plus, Trash2 } from 'lucide-react'
import { builtins, groupTypes, regionLabel, standardGroups } from '../shared/catalog.js'
import { membersForSources, memberSourceIds, poolCondition } from '../shared/group-filter.js'
import { GroupFilter } from './group-filter.jsx'
import { groupReferences } from '../shared/config.js'
import { useConfirm, useUnsavedChanges } from './confirm.jsx'
import { projection, useProject, useSearchValue } from './project.jsx'
import { Alert, Badge, Button, CheckOption, Disclosure, Empty, Field, FieldGroup, FieldLegend, FieldSet, IconButton, Input, Modal, MoveButtons, NativeSelect, NativeSelectOption, OutletSelect, Pager, Panel, RouteLink, SearchBox, Segmented, Toggle, dragProps, formatNumber, moveAt, newId, searchable, useListPage, usePage } from './ui.jsx'

const newGroup = () => ({
  id: newId(), name: '', type: 'select', enabled: true, members: [], testUrl: '',
  seconds: 300, tolerance: 50, strategy: 'consistent-hashing', lazy: true, disableUdp: false,
})
const firstPool = members => members.findIndex(member => member.kind === 'pool')

function memberName(member, draft, allNodes) {
  if (member.kind === 'node') return allNodes.find(row => row.sourceId === member.sourceId && row.id === member.id)?.name ?? '已移除的节点'
  if (member.kind === 'group') return draft.groups.find(group => group.id === member.id)?.name ?? '已删除的代理组'
  if (member.kind === 'builtin') return builtins[member.id]
  const ids = memberSourceIds(member)
  return [
    ids.length ? draft.sources.filter(source => ids.includes(source.id)).map(source => source.name).join('、') : '全部来源',
    member.regions.length ? member.regions.map(regionLabel).join('、') : '全部地区',
    member.includeRegex && '包含 /' + member.includeRegex + '/',
    member.excludeRegex && '排除 /' + member.excludeRegex + '/',
  ].filter(Boolean).join(' · ')
}

const memberType = { pool: '动态', node: '节点', group: '代理组', builtin: '内置' }

function GroupEditor({ group, onClose, inline, onCopy, onRemove, onDirtyChange }) {
  const { state, view, save } = useProject()
  const [original, setOriginal] = useState(() => group ?? newGroup())
  const [revision, setRevision] = useState(state.revision)
  const [form, setForm] = useState(() => structuredClone(original))
  const [picker, setPicker] = useState('pool')
  const [poolIndex, setPoolIndex] = useState(() => firstPool(original.members))
  const filterHeading = useRef(null)
  const pool = form.members[poolIndex]?.kind === 'pool' ? form.members[poolIndex] : null
  const [nodeSource, setNodeSource] = useState('')
  const [query, setQuery] = useState('')
  const [targetId, setTargetId] = useState('')
  const [problem, setProblem] = useState('')
  const [nameError, setNameError] = useState('')
  const [busy, setBusy] = useState(false)
  const groupName = useRef(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(original)
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    if (inline && !dirty && state.revision !== revision) {
      setOriginal(group)
      setForm(structuredClone(group))
      setPoolIndex(firstPool(group.members))
      setRevision(state.revision)
    }
  }, [inline, dirty, state.revision, revision, group])
  const guard = useUnsavedChanges(dirty, '此代理组的名称、成员和设置会恢复为上次保存的内容。')
  const draft = useMemo(() => ({
    ...state.draft,
    groups: group ? state.draft.groups.map(item => item.id === group.id ? form : item) : [...state.draft.groups, form],
  }), [form, group?.id, state.draft])
  const computed = useMemo(() => projection(draft, state), [draft, state])
  const members = computed.groups.find(item => item.id === form.id)?.members ?? []
  const issues = computed.issues.filter(issue => issue.pane === 'groups' && issue.id === form.id)
  const matched = view.nodes.filter(node => node.kept && (!nodeSource || node.sourceId === nodeSource) && (searchable(node.name, query) || searchable(node.sourceName, query) || searchable(regionLabel(node.region), query)))
  const [offset, setOffset] = usePage(matched.length, 20)
  const [previewOffset, setPreviewOffset] = usePage(members.length, 25)
  const refs = group && form.name.trim() !== group.name ? groupReferences(state.draft, group.id) : []
  const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }))
  function setMembers(next, active = pool) {
    update('members', next)
    setPoolIndex(active ? next.indexOf(active) : -1)
  }
  const move = (from, to) => setMembers(moveAt(form.members, from, to))
  function editFilter(index) {
    setPicker('pool')
    setPoolIndex(index)
    requestAnimationFrame(() => filterHeading.current?.focus())
  }
  function updateFilter(value) {
    const condition = poolCondition(value)
    const next = pool ? form.members.map((entry, i) => i === poolIndex ? condition : entry) : [...form.members, condition]
    setMembers(next, condition)
  }
  const close = () => { if (!busy) return guard.close(onClose) }
  const append = member => {
    if (!form.members.some(entry => JSON.stringify(entry) === JSON.stringify(member))) setMembers([...form.members, member])
  }
  function selectNode(node, selected) {
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
        const saved = next.draft.groups.find(item => item.id === group.id)
        setOriginal(saved)
        setForm(structuredClone(saved))
        setRevision(next.revision)
      } else guard.leave(() => onClose(form.id))
    }
    catch (error) { setProblem(error.message) }
    finally { setBusy(false) }
  }
  const groups = state.draft.groups.filter(item => item.id !== form.id)
  function replaceMember(index, member) {
    setMembers(form.members.map((entry, i) => i === index ? member : entry))
  }
  const content = <div className="stack group-fields" inert={busy}>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <FieldGroup className="form-grid"><Field label="代理组名称" name="group_name" error={nameError}><Input ref={groupName} value={form.name} maxLength={256} onChange={event => {
        update('name', event.target.value)
        setNameError('')
      }} placeholder="例如 Google 出口…" /></Field>
        <Field label="代理组类型" hint={groupTypes[form.type][1]}><NativeSelect value={form.type} onChange={event => update('type', event.target.value)}>
          {Object.entries(groupTypes).map(([key, [label]]) => <NativeSelectOption value={key} key={key}>{label}</NativeSelectOption>)}
        </NativeSelect></Field></FieldGroup>
      <Toggle label="启用代理组" detail="停用组不会出现在成品中。请先处理启用的引用。" checked={form.enabled} onChange={value => update('enabled', value)} />
      {refs.length > 0 && <p className="muted field-note">保存后会同步更新 {formatNumber(refs.length)} 处引用的显示名称。</p>}
      <section className="member-config" aria-label="配置代理组成员">
        <div className="stack tight">
          <Segmented label="成员选择方式" items={ [['pool', '动态筛选'], ['node', '具体节点'], ['group', '代理组与内置出口']] } value={picker} onChange={setPicker} />
          {picker === 'pool' && <GroupFilter member={pool} index={poolIndex} sources={state.draft.sources} nodes={view.nodes}
            headingRef={filterHeading} onNew={() => editFilter(-1)} onChange={updateFilter} />}
          {picker === 'node' && <>
            <div className="filters"><SearchBox value={query} placeholder="搜索保留节点" onChange={value => { setQuery(value); setOffset(0) }} />
              <NativeSelect aria-label="节点机场" value={nodeSource} onChange={event => { setNodeSource(event.target.value); setOffset(0) }}><NativeSelectOption value="">全部机场</NativeSelectOption>
                {state.draft.sources.map(source => <NativeSelectOption key={source.id} value={source.id}>{source.name}</NativeSelectOption>)}</NativeSelect></div>
            {matched.length ? <FieldSet><FieldLegend className="sr-only">选择保留节点</FieldLegend><div className="member-options">{matched.slice(offset, offset + 20).map(node => <CheckOption key={node.key}
              checked={form.members.some(member => member.kind === 'node' && member.id === node.id && member.sourceId === node.sourceId)}
              onCheckedChange={checked => selectNode(node, checked)}><span><span translate="no">{node.name}</span><small>{node.sourceName} / {regionLabel(node.region)}</small></span>
            </CheckOption>)}</div></FieldSet> : <p className="muted">没有符合查询的保留节点。</p>}
            {matched.length > 20 && <Pager offset={offset} pageSize={20} count={matched.length} onChange={setOffset} />}
          </>}
          {picker === 'group' && <div className="actions input-actions"><OutletSelect value={targetId} onChange={setTargetId} groups={groups} label="选择成员代理组或内置出口" />
            <Button icon={Plus} disabled={!targetId} onClick={() => {
              append({ kind: Object.hasOwn(builtins, targetId) ? 'builtin' : 'group', id: targetId })
              setTargetId('')
            }}>加入成员</Button></div>}
        </div>
      </section>
      <section className="stack tight"><div className="between flex-wrap"><h3>成员选择与顺序</h3>
        <div className="chips"><span className="soft-count">{formatNumber(members.filter(item => item.kind === 'node').length)} 个节点</span>
          <span className="soft-count">{formatNumber(members.filter(item => item.kind === 'group').length)} 个子组</span></div></div>
        {(form.members.length > 0 || original.members.length > 0) && <div className="actions member-bulk">
          <Button size="small" variant="ghost" disabled={JSON.stringify(form.members) === JSON.stringify(original.members)} onClick={() => {
            const restored = structuredClone(original.members)
            setMembers(restored, restored[firstPool(restored)])
          }}>撤销成员修改</Button>
          <Button size="small" variant="ghost" disabled={!form.members.some(item => item.kind === 'pool' || item.kind === 'node')}
            onClick={() => setMembers(form.members.filter(item => item.kind !== 'pool' && item.kind !== 'node'))}>移除节点与筛选</Button>
          <Button size="small" variant="ghost" disabled={!form.members.some(item => item.kind === 'group')}
            onClick={() => setMembers(form.members.filter(item => item.kind !== 'group'))}>移除全部子组</Button>
        </div>}
        {form.members.length ? <ol className="order-list member-order">{form.members.map((member, index) => <li key={index} data-sort-row {...dragProps(index, move, 'member')}>
          <div className="member-sequence"><span className="order-index mono">#{index + 1}</span><span className="soft-count">{memberType[member.kind]}</span>
            <div className="row-actions">{member.kind === 'pool' && <Button size="small" variant="ghost" onClick={() => editFilter(index)}>编辑筛选</Button>}<MoveButtons index={index} count={form.members.length} onMove={move} area="member" />
              <IconButton icon={Trash2} label={'移除成员 ' + (index + 1)} onClick={() => setMembers(form.members.filter((_, i) => index !== i))} /></div>
          </div>
          {member.kind === 'group' || member.kind === 'builtin'
            ? <Field label={'成员 ' + (index + 1) + ' 的出口'}><OutletSelect value={member.id} groups={groups}
                onChange={id => { if (id) replaceMember(index, { kind: Object.hasOwn(builtins, id) ? 'builtin' : 'group', id }) }} /></Field>
            : <p className="member-value">{memberName(member, state.draft, view.nodes)}</p>}
        </li>)}</ol> : <p className="muted">请从上方添加成员。</p>}
      </section>
      {(form.members.length > 0 || group || issues.some(issue => issue.code !== 'group-empty')) && <section className="stack tight"><div className="between"><h3>最终成员预览</h3><span className="muted numeric">{formatNumber(members.length)} 个成员</span></div>
        {issues.map((issue, index) => <Alert tone={issue.code === 'group-empty' ? 'warning' : 'danger'} key={index}>{issue.message}</Alert>)}
        {members.length > 0 && <><ol className="compact-list preview-members" start={previewOffset + 1}>{members.slice(previewOffset, previewOffset + 25).map(member => <li key={member.key}>{member.name}</li>)}</ol>
          {members.length > 25 && <Pager offset={previewOffset} pageSize={25} count={members.length} onChange={setPreviewOffset} />}</>}
      </section>}
      <Disclosure title="高级组参数"><FieldGroup>
        {form.type !== 'select' && <>
          <FieldGroup className="form-grid">
            <Field label="连通性测试地址"><Input type="url" spellCheck={false} placeholder="https://cp.cloudflare.com/generate_204…" value={form.testUrl} onChange={event => update('testUrl', event.target.value)} /></Field>
            <Field label="检测间隔（秒）"><Input type="number" min="10" max="86400" value={form.seconds} onChange={event => update('seconds', Number(event.target.value))} /></Field>
            {form.type === 'url-test' && <Field label="切换容差（毫秒）"><Input type="number" min="0" max="60000" value={form.tolerance ?? ''} placeholder="使用客户端默认值" onChange={event => update('tolerance', event.target.value === '' ? null : Number(event.target.value))} /></Field>}
            {form.type === 'load-balance' && <Field label="分配策略"><NativeSelect value={form.strategy} onChange={event => update('strategy', event.target.value)}>
              <NativeSelectOption value="consistent-hashing">一致性哈希</NativeSelectOption><NativeSelectOption value="round-robin">轮询</NativeSelectOption><NativeSelectOption value="sticky-sessions">会话保持</NativeSelectOption>
            </NativeSelect></Field>}
          </FieldGroup>
          <Toggle label="仅使用时检测" checked={form.lazy} onChange={value => update('lazy', value)} />
        </>}
        <Toggle label="为此组关闭 UDP" checked={form.disableUdp} onChange={value => update('disableUdp', value)} />
      </FieldGroup></Disclosure>
    </div>
  const saveAction = <Button variant="primary" size={inline ? 'small' : 'default'} icon={Check} disabled={(inline && !dirty) || issues.some(issue => issue.code === 'group-filter')} busy={busy} onClick={commit}>保存代理组</Button>
  if (inline) return <Panel className="group-detail" title={<>{group.name} <code className="tech-chip">{form.type}</code> <Badge tone="success">{formatNumber(members.length)} 成员</Badge></>}
    actions={<>
      {dirty ? <><Button size="small" onClick={() => { setForm(structuredClone(original)); setPoolIndex(firstPool(original.members)); setProblem(''); setNameError('') }}>撤销更改</Button>{saveAction}</>
        : <><Button size="small" icon={Copy} onClick={onCopy}>复制</Button><IconButton icon={Trash2} className="delete-action" label={'删除代理组 ' + group.name} onClick={onRemove} /></>}
    </>}>{content}</Panel>
  return <Modal wide title="新建代理组" onClose={close} footer={<><Button variant="ghost" onClick={close}>取消</Button>{saveAction}</>}>{content}</Modal>
}

function cloneGroups(input, draft) {
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
      members: membersForSources(item.members, sourceIds).flatMap(member => {
        if (member.kind === 'group') {
          const id = idMap.get(member.id) ?? (groupIds.has(member.id) ? member.id : null)
          return id ? [{ ...member, id }] : []
        }
        return [member]
      }),
    }
  })
}

export function GroupsPage() {
  const { state, view, route, save, notify, navigate, call, applyState } = useProject()
  const confirm = useConfirm()
  const [query, setQuery] = useSearchValue('q')
  const [remove, setRemove] = useState(null)
  const [replacement, setReplacement] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
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
      for (const ref of groupReferences(state.draft, pending.pop()).filter(ref => ref.pane === 'groups' && !obsolete.has(ref.id))) {
        obsolete.add(ref.id)
        pending.push(ref.id)
      }
    }
  }
  const candidateGroups = groups.filter(group => !obsolete.has(group.id))
  async function run(action) {
    setBusy(true)
    try { await action() } catch (error) { notify(error.message, 'danger') } finally { setBusy(false) }
  }
  const updateGroups = next => save({ ...state.draft, groups: next })
  const move = (from, to) => run(() => updateGroups(moveAt(groups, from, to)))
  const importTemplate = entries => run(async () => {
    await updateGroups([...groups, ...cloneGroups(entries, state.draft)])
    setLibraryOpen(false)
    notify('已添加模板中的代理组')
  })
  function commitDelete() {
    return run(async () => {
      const successor = Object.hasOwn(builtins, replacement) ? { kind: 'builtin', id: replacement } : { kind: 'group', id: replacement }
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
      <Button size="small" icon={Layers3} disabled={editingDirty} onClick={() => setLibraryOpen(true)}>组模板</Button>
      <Button icon={Plus} size="small" variant="primary" onClick={() => navigate('groups', 'new')}>新建代理组</Button>
    </>}>
      <div className="config-toolbar"><div className="template-strip"><Layers3 aria-hidden="true" /><span>常用组模板</span>
        <Button size="small" icon={Plus} disabled={editingDirty || busy} onClick={() => importTemplate(standardGroups)}>手动选择 + 自动测速</Button>
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
                <span className="group-facts"><span className="soft-count">{formatNumber(members.length)} 成员</span>{refs > 0 && <span>{refs} 处引用</span>}{!group.enabled && <span>已停用</span>}</span>
              </div>
              <div className="row-actions" inert={editingDirty || busy}><MoveButtons index={index} count={groups.length} onMove={move} area="group" /></div>
            </li>
          })}</ul>{visible.length > 30 && <Pager offset={offset} pageSize={30} count={visible.length} onChange={setOffset} />}</>}
      </Panel>
      {selected && route.id !== 'new' ? <GroupEditor key={selected.id} inline group={selected} onDirtyChange={setEditingDirty}
        onCopy={() => run(() => updateGroups([...groups, ...cloneGroups([selected], state.draft)]))}
        onRemove={() => { setReplacement(''); setRemove(selected) }} />
        : <Panel title="成员配置"><Empty icon={Layers3} title={groups.length ? '正在创建代理组' : '创建代理组以编排成员'} detail={!groups.length && '可以按来源、地区和正则筛选节点，也可以点选节点或引用其他代理组。'} /></Panel>}
    </div>
    {route.id === 'new' && <GroupEditor key="new" onClose={id => navigate('groups', id)} />}
    {remove && <Modal title={'删除代理组 · ' + remove.name} detail="下次发布时，订阅将移除这个代理组。" onClose={() => setRemove(null)}
      footer={<><Button onClick={() => setRemove(null)}>取消</Button><Button variant="danger" busy={busy} disabled={removingRefs.length > 0 && !replacement} onClick={commitDelete}>{removingRefs.length ? '迁移并删除' : '确认删除'}</Button></>}>
      {removingRefs.length ? <div className="stack">
        <Alert tone="warning">此组仍有 {removingRefs.length} 处引用。可打开相关项目单独调整，或选择替代出口后批量迁移。</Alert>
        <ul className="compact-list">{removingRefs.map(ref => <li key={ref.id}><RouteLink className="text-link" page={ref.pane} id={ref.id} onClick={() => setRemove(null)}>{ref.name}（{ref.pane === 'groups' ? '代理组' : '分流规则'}）</RouteLink></li>)}</ul>
        <Field label="替代出口"><OutletSelect label="替代出口" groups={candidateGroups} value={replacement} onChange={setReplacement} /></Field>
      </div> : <p>此代理组没有其他规则或分组引用。</p>}
    </Modal>}
    {libraryOpen && <Modal title="代理组模板" detail="导入后可自由编辑、停用及删除。跨方案套用时，仅保留可用的来源与组引用。" onClose={() => setLibraryOpen(false)}>
      <div className="stack">
        <div className="list-option"><div><strong>常用分组</strong><p>手动选择、自动测速</p></div><Button size="small" onClick={() => importTemplate(standardGroups)} busy={busy}>导入</Button></div>
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
