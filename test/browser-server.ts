import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { createApplication } from '../server/http.ts'

const port = Number(process.env.SUBMELD_BROWSER_TEST_PORT) || 47891
const names: Record<string, string[]> = { a: ['🇭🇰 香港 IEPL 01 | 0.5x', '日本备用'], b: ['东京 01'], c: ['香港精选', '香港 免费', '新加坡 01'] }
const upstream = createServer((request, response) => {
  const key = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1)
  if (!Object.hasOwn(names, key)) { response.writeHead(404).end(); return }
  if (key === 'a') {
    const expire = Math.floor(Date.now() / 1000) + 5 * 86400
    response.setHeader('Subscription-Userinfo', 'upload=1073741824; download=2147483648; total=10737418240; expire=' + expire)
  }
  if (key === 'b') response.setHeader('Subscription-Userinfo', 'total=0; expire=0')
  response.end(stringify({
    proxies: names[key].map((name, index) => ({
      name, type: 'ss', cipher: 'aes-128-gcm', server: 'test.example.net', port: 11000 + index,
      password: 'fixture-node-password-' + key,
    })),
  }))
})
upstream.listen(port + 1, '127.0.0.1')
await once(upstream, 'listening')
const directory = await mkdtemp(join(tmpdir(), 'submeld-ui-'))
const previewLists: Record<string, string> = { 'geosite/google': '+.google.com', 'geosite/google-gemini': '+.gemini.google.com', 'geosite/github': '+.github.com\n+.github.io' }
const app = createApplication({ directory, allowPrivate: true, binary: process.env.SUBMELD_MIHOMO_BIN, tickMs: 0,
  loadRuleSetList: async key => previewLists[key],
})
app.server.listen(port, '127.0.0.1')
async function close() {
  await app.close()
  await new Promise(resolve => upstream.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
