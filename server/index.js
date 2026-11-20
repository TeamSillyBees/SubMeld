import { createApplication } from './http.js'

const host = process.env.SUBMELD_HOST || '127.0.0.1'
const port = Number(process.env.SUBMELD_PORT || 8787)
const app = createApplication({
  directory: process.env.SUBMELD_DATA_DIR,
  binary: process.env.SUBMELD_MIHOMO_BIN,
  publicUrl: process.env.SUBMELD_PUBLIC_URL,
  secure: process.env.SUBMELD_SECURE_COOKIES === '1' ? true : undefined,
  password: process.env.SUBMELD_ADMIN_PASSWORD,
  allowPrivate: process.env.SUBMELD_ALLOW_PRIVATE_UPSTREAMS === '1',
})

app.server.on('error', error => {
  console.error('SubMeld: unable to listen (' + error.code + ').')
  process.exitCode = 1
  void app.close()
})
app.server.listen(port, host, () => {
  console.log('SubMeld · http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + app.server.address().port)
  app.workspace.tick()
})

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close())
