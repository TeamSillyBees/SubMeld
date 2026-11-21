import { useMemo, useRef, useState } from 'react'
import { Check, Link2, Pencil, Plus } from 'lucide-react'
import { builtins } from '../shared/catalog.js'
import { ruleSetKeys } from '../shared/rule-sets.js'
import { Button, Field, NativeSelect, NativeSelectOption, OutletSelect, Pager, Panel, RouteLink, SearchBox, formatNumber, usePage } from './ui.jsx'

const common = {
  'geosite/netflix': ['Netflix', '奈飞 网飞'],
  'geosite/google': ['Google', '谷歌'],
  'geosite/google-gemini': ['Gemini', '谷歌 AI'],
  'geosite/steam': ['Steam', '游戏'],
  'geosite/telegram': ['Telegram', '电报'],
  'geosite/github': ['GitHub', '代码托管'],
  'geosite/huggingface': ['Hugging Face', 'AI'],
  'geosite/openai': ['OpenAI', 'ChatGPT'],
  'geosite/youtube': ['YouTube', '油管'],
}
const pageSize = 8
const titleFor = key => common[key]?.[0] ?? key

export function RuleSetPicker({ groups, added, busy, onAdd, onEdit, onManual, onCustom, onPaste }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [chosen, setChosen] = useState('')
  const [target, setTarget] = useState('')
  const selection = useRef(null)
  function choose(key) {
    setChosen(key)
    requestAnimationFrame(() => selection.current?.querySelector('select, button')?.focus())
  }
  const searching = Boolean(query.trim() || kind)
  const results = useMemo(() => {
    const term = query.trim().toLowerCase()
    const terms = term.split(/\s+/)
    const matches = ruleSetKeys.filter(key => {
      if (kind && !key.startsWith(kind + '/')) return false
      const words = [key, ...(common[key] ?? [])].join(' ').toLowerCase()
      return terms.every(word => words.includes(word))
    })
    const exact = key => key === term || key.split('/')[1] === term || common[key]?.[0].toLowerCase() === term
    return term ? matches.sort((a, b) => Number(exact(b)) - Number(exact(a))) : matches
  }, [query, kind])
  const [offset, setOffset] = usePage(results.length, pageSize)
  const existing = added.get(chosen)
  const validTarget = Object.hasOwn(builtins, target) || groups.some(group => group.id === target && group.enabled)
  return <Panel title="添加规则集" count={formatNumber(ruleSetKeys.length) + ' 个可选'} actions={<>
    <Button size="small" onClick={onPaste}>粘贴规则集</Button>
    <Button size="small" icon={Link2} onClick={onCustom}>从链接添加</Button>
  </>}>
    <div className="rule-catalog">
      <div className="catalog-search"><SearchBox label="搜索 MetaCubeX 规则集" placeholder="搜索 Netflix、Google、Steam、Telegram 或规则集名称" value={query}
        onChange={value => { setQuery(value); setChosen(''); setOffset(0) }} />
        <NativeSelect aria-label="规则集类型" value={kind} onChange={event => { setKind(event.target.value); setChosen(''); setOffset(0) }}>
          <NativeSelectOption value="">全部类型</NativeSelectOption><NativeSelectOption value="geosite">GeoSite · 域名</NativeSelectOption><NativeSelectOption value="geoip">GeoIP · 网段</NativeSelectOption>
        </NativeSelect></div>
      {searching ? <div className="catalog-results">
        <span className="field-note muted" role="status">{results.length ? '找到 ' + formatNumber(results.length) + ' 个规则集' : '没有匹配的规则集，可缩短搜索词或更改类型。'}</span>
        {results.length > 0 && <ul className="catalog-options">{results.slice(offset, offset + pageSize).map(key => <li key={key}>
          <button type="button" aria-pressed={chosen === key} onClick={() => choose(key)}>
            <code>{key}</code>{added.has(key) ? <span>已添加</span> : chosen === key ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
          </button></li>)}</ul>}
        {results.length > pageSize && <Pager pageSize={pageSize} count={results.length} offset={offset} onChange={setOffset} />}
      </div> : <div className="catalog-common"><span className="muted">常用</span>{Object.keys(common).map(key =>
        <Button size="small" key={key} aria-pressed={chosen === key} title={key} onClick={() => choose(key)}>{titleFor(key)}{added.has(key) && <Check aria-label="已添加" />}</Button>)}</div>}
      <div className="catalog-selection" ref={selection}>
        <div className="catalog-selected-name">{chosen ? <><div className="chips"><span className="tech-chip">RULE-SET</span><code>{chosen}</code></div>
          <p className="field-note muted">MetaCubeX · {chosen.startsWith('geoip/') ? 'IP 网段' : '域名'} · 更新间隔 24 小时</p></>
          : <p className="muted">请从搜索结果或常用列表中选择规则集。</p>}</div>
        {existing ? <Button icon={Pencil} size="small" onClick={() => onEdit(existing.id)}>编辑已添加的规则集</Button> : <>
          <Field label="规则集的出站策略"><OutletSelect groups={groups} value={target} onChange={setTarget} /></Field>
          <Button variant="primary" icon={Plus} busy={busy} disabled={!chosen || !validTarget} onClick={() => onAdd(chosen, titleFor(chosen), target)}>添加规则集</Button>
        </>}
      </div>
      <div className="catalog-alternatives"><Button size="small" variant="ghost" onClick={onManual}>手动添加规则</Button>
        {!groups.some(group => group.enabled) && <RouteLink className="text-link" page="groups" id="new">新建代理组</RouteLink>}</div>
    </div>
  </Panel>
}
