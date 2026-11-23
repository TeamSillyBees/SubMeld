import { platformSurfaces, qualityValue, type NodeQuality, type Platform, type QualitySort } from '../shared/quality-snapshot.ts'

export const qualitySortLabels: Record<QualitySort, string> = {
  https: 'HTTPS 延迟', tls: 'TLS RTT', loss: '丢包率', speed: '下载带宽', ai: '综合解锁度',
  ChatGPT: 'ChatGPT', Gemini: 'Gemini', Claude: 'Claude', Grok: 'Grok',
}
export function NodeQualityValue({ row, sort }: { row?: NodeQuality; sort: QualitySort }) {
  if (!row) return <span className="muted" aria-label="未测">-</span>
  if (!row.available) return <span className="danger-text">连接失败</span>
  const value = qualityValue(row, sort)
  if (value == null) return row.speedFailed && sort === 'speed' || sort === 'tls' || sort === 'https' ? <span className="danger-text">测量失败</span> : <span className="muted" aria-label="未测">-</span>
  if (sort === 'ai') return <span title="四个平台各占 1 分，同平台的 Web、App 或 API 平分"> {value} / 4 分</span>
  if (sort in platformSurfaces) {
    const channels = platformSurfaces[sort as Platform]
    return <span>{Math.round(value * channels.length)} / {channels.length} 入口可达</span>
  }
  return <span className="numeric">{sort === 'loss' ? Number((value * 100).toFixed(1)) + '%' : sort === 'speed' ? Number(value.toFixed(2)) + ' Mbps' : Math.round(value) + ' ms'}</span>
}
