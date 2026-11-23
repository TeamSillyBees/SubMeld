export function secureProbeOrigin(url: URL) {
  return url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}
export const maxQualityNodes = 1024
export const qualityDefaults = { rounds: 3, concurrency: 6, bandwidth: false, speedConcurrency: 1, seconds: 5, mebibytes: 4, ai: true }
export const surfaces = ['chatgptWeb', 'chatgptApp', 'gemini', 'claudeWeb', 'claudeApi', 'grok'] as const
export type Surface = typeof surfaces[number]
export const surfaceNames: Record<Surface, string> = {
  chatgptWeb: 'ChatGPT Web', chatgptApp: 'ChatGPT App', gemini: 'Gemini', claudeWeb: 'Claude Web', claudeApi: 'Claude API', grok: 'Grok',
}
