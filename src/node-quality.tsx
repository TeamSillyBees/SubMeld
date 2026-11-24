import { ArrowDown, ArrowUp } from 'lucide-react'
import { surfaceNames, surfaces } from '../shared/quality-options.ts'
import type { AiReading, AiResults, AvailabilityStats } from '../shared/quality.ts'
import { getAiDisplayStatus, higherFirst, platformSurfaces, qualitySorts, qualityValue, reachablePlatformCount, verdictFor, verdictLabels, type NodeQuality, type Platform, type QualitySort } from '../shared/quality-snapshot.ts'
import { Badge, Button } from './ui.tsx'

export const qualitySortLabels: Record<QualitySort, string> = {
  https: 'HTTPS 延迟', tls: 'TLS RTT', loss: '丢包率', jitter: '抖动', speed: '下载带宽', availability: '可用率', ai: '综合解锁度',
  ChatGPT: 'ChatGPT', Gemini: 'Gemini Web',
}
export const stateLabels: Record<AiReading['state'], string> = {
  reachable: '入口可达', unavailable: '不可用', authentication: '需要登录', region_restricted: '地区受限', region_mismatch: '地区不一致',
  challenge: 'Cloudflare 挑战', degraded_challenge: '需浏览器验证', ip_blocked: 'IP 被封禁', rate_limited: '请求受限', unknown: '待确认', network_error: '连接失败',
}

export function AvailabilityReading({ availability, fallbackRate, infoNode }: {
  availability?: AvailabilityStats | null
  fallbackRate?: number | null
  infoNode?: boolean
}) {
  if (infoNode) return <span className="muted">套餐提示</span>
  if (!availability || availability.total === 0) {
    if (fallbackRate != null) {
      const pct = Number((fallbackRate * 100).toFixed(1))
      return <span className="availability-reading numeric" aria-label={`可用率 ${pct}%`}><strong>{pct}%</strong></span>
    }
    return <span className="muted" aria-label="暂无可用率">—</span>
  }
  const pct = Number((availability.rate * 100).toFixed(1))
  return <span className="availability-reading numeric" aria-label={`可用率 ${pct}%，${availability.success} / ${availability.total} 次`}>
    <strong>{pct}%</strong>{' '}
    <small className="muted">{availability.success}/{availability.total}</small>
  </span>
}

export function AiUnlockCell({ ai, exitRegion, skipped, infoNode, tested }: {
  ai?: AiResults | null
  exitRegion?: string | null
  skipped?: 'missing_exit' | 'weak_connection'
  infoNode?: boolean
  tested?: boolean
}) {
  if (infoNode) return <span className="muted">—</span>
  if (skipped) {
    return <span className="muted" title={skipped === 'missing_exit' ? '未获取出口 IP，已跳过 AI 检测' : '连接丢包过高或延迟过长，已跳过 AI 检测'}>
      {skipped === 'missing_exit' ? '未取到出口' : '弱网跳过'}
    </span>
  }
  if (!ai) return <span className="muted" aria-label="AI 未检测">{tested === false ? '未检测' : '未测'}</span>
  return <ul className="ai-unlock-list" aria-label="AI 解锁状态" data-ai-unlock>
    {surfaces.map(s => {
      const status = getAiDisplayStatus(ai[s], exitRegion)
      return <li key={s} data-surface={s}>
        <span className="ai-surface-name">{surfaceNames[s]}</span>
        {status
          ? <Badge tone={status.tone}>{status.label}</Badge>
          : <span className="muted" aria-label={surfaceNames[s] + ' 未测'}>—</span>}
      </li>
    })}
  </ul>
}

export function QualitySortBar({ sort, reverse, change }: { sort: QualitySort | null; reverse: boolean; change: (sort: string) => void }) {
  return <div className="pool-presets quality-sort" role="group" aria-label="节点质量排序">
    <Button size="small" aria-pressed={!sort} onClick={() => change('')}>订阅顺序</Button>
    {qualitySorts.map(key => {
      const active = key === sort
      const descending = higherFirst(key) !== (active && reverse)
      return <Button key={key} size="small" aria-pressed={active} icon={active ? descending ? ArrowDown : ArrowUp : undefined}
        aria-label={qualitySortLabels[key] + (active ? descending ? '，当前降序' : '，当前升序' : '')}
        onClick={() => change(active && !reverse ? '-' + key : key)}>{qualitySortLabels[key]}</Button>
    })}
  </div>
}
export function NodeQualityValue({ row, sort }: { row?: NodeQuality; sort: QualitySort }) {
  if (!row) return <span className="muted" aria-label="未测">—</span>
  if (row.infoNode) return <span className="muted">套餐提示</span>
  if (sort === 'availability') return <AvailabilityReading availability={row.availability} fallbackRate={row.availabilityRate} infoNode={row.infoNode} />
  const value = qualityValue(row, sort)
  if (!row.available) return <span className="error-text">连接失败</span>
  if (value == null) return (row.speedFailed && sort === 'speed') ? <span className="error-text">测量失败</span> : <span className="muted" aria-label="未测">—</span>
  if (sort === 'ai') return <span title="先按全入口或部分入口可达的平台数排序，再比较总分">{reachablePlatformCount(row)} 个平台可达 · {value} 分</span>
  if (sort in platformSurfaces) {
    return <span>{verdictLabels[verdictFor(row, sort as Platform)!]}</span>
  }
  return <span className="numeric">{sort === 'loss' ? Number((value * 100).toFixed(1)) + '%' : sort === 'speed' ? Number(value.toFixed(2)) + ' Mbps' : Math.round(value) + ' ms'}</span>
}
