import { createApplication } from './http.ts'
import { applicationOptions } from './environment.ts'

const host = process.env.SUBMELD_HOST || '127.0.0.1'
const port = Number(process.env.SUBMELD_PORT || 8787)
const app = createApplication(applicationOptions())

app.server.on('error', error => {
  console.error('SubMeld: unable to listen (' + (error as NodeJS.ErrnoException).code + ').')
  process.exitCode = 1
  void app.close()
})
app.server.listen(port, host, () => {
  const address = app.server.address()
  console.log('SubMeld · http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + (typeof address === 'object' && address ? address.port : port))
  app.workspace.tick()
})

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close())
