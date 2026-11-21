import { build } from 'esbuild'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const staticSonnerStyles = {
  name: 'static-sonner-styles',
  setup(build) {
    build.onLoad({ filter: /[/\\]sonner[/\\]dist[/\\]index\.mjs$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      // The same stylesheet is included in app.css. Keep inline CSS injection out of the bundle.
      return { contents: source.replace(/^__insertCSS\([^\r\n]*$/m, ''), loader: 'js' }
    })
  },
}

await build({
  entryPoints: ['src/main.jsx'],
  outfile: 'dist/assets/app.js',
  tsconfig: 'jsconfig.json',
  bundle: true,
  minify: true,
  jsx: 'automatic',
  plugins: [staticSonnerStyles],
  target: ['chrome111', 'firefox111', 'safari16.4'],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const source = 'src/styles.css'
const output = 'dist/assets/app.css'
const styles = await postcss([tailwind({ optimize: true })]).process(await readFile(source, 'utf8'), {
  from: source, to: output, map: false,
})
await writeFile(output, styles.css)
await copyFile('docs/assets/submeld-logo.svg', 'dist/assets/submeld-logo.svg')
await copyFile('src/assets/favicon.png', 'dist/assets/favicon.png')
await copyFile('index.html', 'dist/index.html')
