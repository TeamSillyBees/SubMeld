import { ArrowDown, ArrowUp } from 'lucide-react'
import { skippedMetrics, type QualityCondition } from '../shared/group-filter.ts'
import type { AiReading } from '../shared/quality.ts'
import { higherFirst, platformSurfaces, qualitySorts, qualityValue, verdictFor, verdictLabels, type NodeQuality, type Platform, type QualitySnapshot, type QualitySort } from '../shared/quality-snapshot.ts'
import { Alert, Button } from './ui.tsx'

export const qualitySortLabels: Record<QualitySort, string> = {
  https: 'HTTPS 延迟', tls: 'TLS RTT', loss: '丢包率', jitter: '抖动', speed: '下载带宽', ai: '综合解锁度',
  ChatGPT: 'ChatGPT', Gemini: 'Gemini', Claude: 'Claude', Grok: 'Grok',
}
export const stateLabels: Record<AiReading['state'], string> = {
  reachable: '入口可达', unavailable: '不可用', authentication: '需要登录', region_restricted: '地区受限', region_mismatch: '地区不一致',
  challenge: 'Cloudflare 挑战', degraded_challenge: '需浏览器验证', ip_blocked: 'IP 被封禁', rate_limited: '请求受限', unknown: '待确认', network_error: '连接失败',
}
export function SkippedQualityNotice({ condition, config }: { condition?: QualityCondition; config?: QualitySnapshot['config'] }) {
  if (!condition) return null
  const skipped = skippedMetrics(condition, config)
  const metrics = [skipped.bandwidth && '带宽', skipped.ai && 'AI 平台'].filter(Boolean)
  return metrics.length ? <Alert tone="warning">当前基准报告未检测{metrics.join('和')}，已跳过对应条件。</Alert> : null
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
  if (!row) return <span className="muted" aria-label="未测">-</span>
  if (row.infoNode) return <span className="muted">套餐提示</span>
  if (!row.available) return <span className="danger-text">连接失败</span>
  const value = qualityValue(row, sort)
  if (value == null) return row.speedFailed && sort === 'speed' || sort === 'tls' || sort === 'https' ? <span className="danger-text">测量失败</span> : <span className="muted" aria-label="未测">-</span>
  if (sort === 'ai') return <span title="每个平台最高 3 分，按已确认的入口状态计分">{value} / 12 分</span>
  if (sort in platformSurfaces) {
    return <span>{verdictLabels[verdictFor(row, sort as Platform)!]}</span>
  }
  return <span className="numeric">{sort === 'loss' ? Number((value * 100).toFixed(1)) + '%' : sort === 'speed' ? Number(value.toFixed(2)) + ' Mbps' : Math.round(value) + ' ms'}</span>
}
