export function secureProbeOrigin(url: URL) {
  return url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}
export function isSubscriptionNotice(name: string) {
  return /(?:^|[\s\]|｜:：】])(?:剩余流量|套餐流量|流量重置|距离下次重置|到期时间|套餐到期|订阅到期|下次重置|traffic remaining|expire(?:s| time)?)(?=$|[\s:：|｜\d])/iu.test(name)
}
export function aiSkipReason(row: { lossRate: number | null; httpsMedianMs: number | null }) {
  if ((row.lossRate ?? 0) >= 0.5 || (row.httpsMedianMs ?? 0) >= 4000) return 'weak_connection'
  return null
}
export const maxQualityNodes = 1024
export const probeProtocol = 3
export const probeQueueLimit = 5
export const probePollMs = 25_000
export const minimumProbeVersion = '1.3.0'
export function compatibleProbe(device: { protocolVersion?: number; agentVersion?: string }) {
  const version = device.agentVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!version || (device.protocolVersion !== 2 && device.protocolVersion !== probeProtocol)) return false
  const minimum = minimumProbeVersion.split('.').map(Number)
  for (let i = 0; i < minimum.length; i++) {
    const difference = Number(version[i + 1]) - minimum[i]
    if (difference) return difference > 0
  }
  return true
}
export const qualityDefaults = { rounds: 3, concurrency: 6, bandwidth: false, speedConcurrency: 1, seconds: 5, mebibytes: 4, ai: true }
export const surfaces = ['chatgptWeb', 'chatgptApp', 'gemini', 'claudeWeb', 'claudeApi', 'grok'] as const
export type Surface = typeof surfaces[number]
export const surfaceNames: Record<Surface, string> = {
  chatgptWeb: 'ChatGPT Web', chatgptApp: 'ChatGPT App', gemini: 'Gemini Web', claudeWeb: 'Claude Web', claudeApi: 'Claude API', grok: 'Grok',
}
