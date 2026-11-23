import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/postcss'
import { defineConfig, type Plugin } from 'vite'

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url))

function workspaceApi(): Plugin {
  return {
    name: 'submeld-workspace',
    async configureServer(vite) {
      const { createApplication } = await import('./server/http.ts')
      const { applicationOptions } = await import('./server/environment.ts')
      const app = createApplication(applicationOptions())
      vite.middlewares.use((request, response, next) => {
        const path = request.url?.split('?', 1)[0] ?? ''
        if (path.startsWith('/api/') || path.startsWith('/sub/')) {
          void app.handleRequest(request, response)
        } else next()
      })
      app.workspace.tick()
      vite.httpServer?.once('close', () => { void app.close() })
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    workspaceApi(),
    {
      name: 'static-sonner-styles',
      enforce: 'pre',
      transform(code, id) {
        if (/[/\\]sonner[/\\]dist[/\\]index\.mjs$/.test(id)) {
          // The stylesheet is imported in styles.css to support the production CSP.
          return code.replace(/^__insertCSS\([^\r\n]*$/m, '')
        }
      },
    },
  ],
  resolve: { alias: { '@': local('./src') } },
  css: { postcss: { plugins: [tailwind()] } },
  publicDir: false,
  html: command === 'build' ? { cspNonce: 'SUBMELD_STYLE_NONCE' } : {},
  server: {
    host: '127.0.0.1',
    fs: { allow: ['index.html', 'src', 'shared', 'docs/assets', 'node_modules'].map(path => local('./' + path)) },
  },
  build: {
    target: ['chrome111', 'firefox111', 'safari16.4'],
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'assets/app.js',
        assetFileNames: asset => asset.names.some(name => name.endsWith('.css')) ? 'assets/app.css' : 'assets/[name][extname]',
      },
    },
  },
}))
