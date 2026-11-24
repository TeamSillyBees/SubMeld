#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const e2eDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(e2eDir, '../..')

const ALL_TIERS = ['1', '2', '3', '4']

const REQUIRED_INFRA_FILES = [
  'test/e2e/tsconfig.json',
  'test/e2e/playwright.config.ts',
  'test/e2e/run.mjs',
  'test/e2e/helpers/app-harness.ts',
  'test/e2e/helpers/mock-sub-server.ts',
  'test/e2e/helpers/mock-probe.ts',
  'test/e2e/helpers/ui-helpers.ts',
  'test/e2e/helpers/fixtures.ts',
]

const FORBIDDEN_INTERNAL_IMPORT_RE = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"][^'"]*\/(?:server|agent|shared|src)\//g

function printUsage(stream = process.stdout) {
  stream.write(
    [
      'Usage: node test/e2e/run.mjs [options] [-- <playwright args>]',
      '',
      'Options:',
      '  --tier=<all|1|2|3|4|1,3>   Select tier(s) to run/list/check (default: all)',
      '  --list                     List discovered *.spec.ts files per tier and exit 0',
      '  --check                    Validate Node, infra files, import boundaries, and tsc',
      '  --offline                  With --check, allow missing node_modules/tsc and dist/',
      '  --require-specs            With --check, fail if any selected tier has 0 specs',
      '  --headed                   Run Playwright browsers in headed mode',
      '  --grep=<pattern>           Forward --grep to Playwright',
      '  --workers=<n>              Set Playwright worker count (default: 1)',
      '  -h, --help                 Show this help message',
      '',
    ].join('\n'),
  )
}

function parseTiers(raw) {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'all') return [...ALL_TIERS]
  const parts = normalized.split(',').map(p => p.trim()).filter(Boolean)
  if (!parts.length) return null
  const seen = new Set()
  for (const part of parts) {
    if (!ALL_TIERS.includes(part)) return null
    seen.add(part)
  }
  return ALL_TIERS.filter(t => seen.has(t))
}

function parseCliArgs(argv) {
  const opts = {
    tiers: [...ALL_TIERS],
    explicitAll: true,
    list: false,
    check: false,
    offline: false,
    requireSpecs: false,
    headed: false,
    grep: null,
    workers: null,
    help: false,
    extra: [],
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      opts.extra.push(...argv.slice(i + 1))
      break
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    if (arg === '--list') {
      opts.list = true
      continue
    }
    if (arg === '--check') {
      opts.check = true
      continue
    }
    if (arg === '--offline') {
      opts.offline = true
      continue
    }
    if (arg === '--require-specs') {
      opts.requireSpecs = true
      continue
    }
    if (arg === '--headed') {
      opts.headed = true
      continue
    }
    if (arg === '--tier') {
      const next = argv[++i]
      if (!next) return { error: 'Missing value for --tier' }
      const parsed = parseTiers(next)
      if (!parsed) return { error: `Invalid --tier value: ${next}` }
      opts.tiers = parsed
      opts.explicitAll = next.trim().toLowerCase() === 'all'
      continue
    }
    if (arg.startsWith('--tier=')) {
      const val = arg.slice('--tier='.length)
      const parsed = parseTiers(val)
      if (!parsed) return { error: `Invalid --tier value: ${val}` }
      opts.tiers = parsed
      opts.explicitAll = val.trim().toLowerCase() === 'all'
      continue
    }
    if (arg === '--grep') {
      const next = argv[++i]
      if (!next) return { error: 'Missing value for --grep' }
      opts.grep = next
      continue
    }
    if (arg.startsWith('--grep=')) {
      opts.grep = arg.slice('--grep='.length)
      continue
    }
    if (arg === '--workers') {
      const next = argv[++i]
      if (!next || !/^[1-9]\d*$/.test(next)) return { error: `Invalid --workers value: ${next ?? ''}` }
      opts.workers = next
      continue
    }
    if (arg.startsWith('--workers=')) {
      const val = arg.slice('--workers='.length)
      if (!/^[1-9]\d*$/.test(val)) return { error: `Invalid --workers value: ${val}` }
      opts.workers = val
      continue
    }
    return { error: `Unknown argument: ${arg}` }
  }

  return { opts }
}

async function collectSpecsInDir(dir) {
  if (!existsSync(dir)) return []
  const results = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
        results.push(fullPath)
      }
    }
  }
  await walk(dir)
  return results
}

async function discoverTiers(tiers) {
  const discovered = []
  for (const tier of tiers) {
    const tierName = `tier${tier}`
    const tierDir = join(e2eDir, tierName)
    const specs = await collectSpecsInDir(tierDir)
    discovered.push({
      tier,
      tierName,
      tierDir,
      specs: specs.map(s => relative(rootDir, s).replaceAll('\\', '/')),
    })
  }
  return discovered
}

async function runList(tiers) {
  const discovered = await discoverTiers(tiers)
  let total = 0
  for (const entry of discovered) {
    console.log(`[${entry.tierName}] (${entry.specs.length} spec${entry.specs.length === 1 ? '' : 's'})`)
    for (const spec of entry.specs) {
      console.log(`  - ${spec}`)
    }
    total += entry.specs.length
  }
  console.log(`Total: ${total} spec file(s) across ${discovered.length} tier(s).`)
  return 0
}

async function checkInternalImports(tiers) {
  const violations = []
  const helpersDir = join(e2eDir, 'helpers')
  if (existsSync(helpersDir)) {
    const files = await readdir(helpersDir, { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile() || (!file.name.endsWith('.ts') && !file.name.endsWith('.mts'))) continue
      if (file.name === 'app-harness.ts') continue
      const fullPath = join(helpersDir, file.name)
      const content = await readFile(fullPath, 'utf8')
      const matches = content.match(FORBIDDEN_INTERNAL_IMPORT_RE)
      if (matches) {
        violations.push(`${relative(rootDir, fullPath).replaceAll('\\', '/')}: forbidden internal import (${matches.join(', ')})`)
      }
    }
  }

  const discovered = await discoverTiers(tiers)
  for (const entry of discovered) {
    for (const relSpec of entry.specs) {
      const content = await readFile(resolve(rootDir, relSpec), 'utf8')
      const matches = content.match(FORBIDDEN_INTERNAL_IMPORT_RE)
      if (matches) {
        violations.push(`${relSpec}: forbidden internal import (${matches.join(', ')})`)
      }
    }
  }
  return violations
}

async function runCheck(opts) {
  let ok = true
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) {
    console.error(`FAIL: Node >= 24 required, found ${process.versions.node}`)
    ok = false
  } else {
    console.log(`OK: Node ${process.versions.node}`)
  }

  let filesOk = true
  for (const relPath of REQUIRED_INFRA_FILES) {
    const absPath = resolve(rootDir, relPath)
    if (!existsSync(absPath)) {
      console.error(`FAIL: Missing required E2E file: ${relPath}`)
      filesOk = false
      ok = false
    }
  }
  if (filesOk) {
    console.log(`OK: All ${REQUIRED_INFRA_FILES.length} required E2E infrastructure files exist.`)
  }

  const runCheckRes = spawnSync(process.execPath, ['--check', fileURLToPath(import.meta.url)], {
    cwd: rootDir,
    encoding: 'utf8',
  })
  if (runCheckRes.status !== 0) {
    console.error(`FAIL: node --check test/e2e/run.mjs failed:\n${runCheckRes.stderr}`)
    ok = false
  } else {
    console.log('OK: node --check test/e2e/run.mjs passed.')
  }

  const importViolations = await checkInternalImports(opts.tiers)
  if (importViolations.length) {
    for (const v of importViolations) console.error(`FAIL: ${v}`)
    ok = false
  } else {
    console.log('OK: Zero forbidden internal imports in test/e2e/helpers/* (outside app-harness.ts) and specs.')
  }

  const discovered = await discoverTiers(opts.tiers)
  for (const entry of discovered) {
    console.log(`INFO: ${entry.tierName}: ${entry.specs.length} spec file(s)`)
    if (opts.requireSpecs && entry.specs.length === 0) {
      console.error(`FAIL: ${entry.tierName} has 0 *.spec.ts files (--require-specs enabled).`)
      ok = false
    }
  }

  const tscPath = resolve(rootDir, 'node_modules/typescript/bin/tsc')
  if (existsSync(tscPath)) {
    const tscRes = spawnSync(process.execPath, [tscPath, '-p', 'test/e2e/tsconfig.json', '--noEmit'], {
      cwd: rootDir,
      stdio: 'inherit',
    })
    if (tscRes.status !== 0) {
      console.error('FAIL: TypeScript check (tsc -p test/e2e/tsconfig.json --noEmit) failed.')
      ok = false
    } else {
      console.log('OK: tsc -p test/e2e/tsconfig.json --noEmit passed.')
    }
  } else if (opts.offline) {
    console.log('WARN: node_modules/typescript/bin/tsc not found (skipped in --offline mode).')
  } else {
    console.error('FAIL: node_modules/typescript/bin/tsc not found. Run npm ci or pass --offline.')
    ok = false
  }

  const distReady = existsSync(resolve(rootDir, 'dist/index.html'))
  const probePkgReady = existsSync(resolve(rootDir, 'dist/probes/submeld-quality-probe.tgz'))
  const mihomoName = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
  const binReady = Boolean(process.env.SUBMELD_MIHOMO_BIN) || existsSync(resolve(rootDir, 'bin', mihomoName))

  console.log(`READINESS: dist/index.html=${distReady}, dist/probes/submeld-quality-probe.tgz=${probePkgReady}, bin/${mihomoName}=${binReady}`)
  return ok ? 0 : 1
}

async function runPlaywright(opts) {
  const cliPath = resolve(rootDir, 'node_modules/@playwright/test/cli.js')
  if (!existsSync(cliPath)) {
    console.error('Missing node_modules/@playwright/test/cli.js. Run npm ci first.')
    return 1
  }

  const distHtml = resolve(rootDir, 'dist/index.html')
  if (!existsSync(distHtml)) {
    console.error('Missing dist/index.html. Run npm run build first.')
    return 1
  }

  const discovered = await discoverTiers(opts.tiers)
  const emptyTiers = discovered.filter(d => d.specs.length === 0)
  if (emptyTiers.length) {
    console.error(`Refusing to run: selected tier(s) have 0 *.spec.ts files: ${emptyTiers.map(d => d.tierName).join(', ')}`)
    return 1
  }

  const pwArgs = [cliPath, 'test', '-c', 'test/e2e/playwright.config.ts']
  if (!opts.explicitAll) {
    for (const entry of discovered) {
      pwArgs.push(`--project=${entry.tierName}`)
    }
  }
  if (opts.headed) pwArgs.push('--headed')
  if (opts.grep) pwArgs.push(`--grep=${opts.grep}`)
  if (opts.workers) pwArgs.push(`--workers=${opts.workers}`)
  if (opts.extra.length) pwArgs.push(...opts.extra)

  const env = opts.workers ? { ...process.env, E2E_WORKERS: opts.workers } : process.env
  const res = spawnSync(process.execPath, pwArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    env,
  })

  if (res.error) {
    console.error(res.error.message)
    return 1
  }
  return res.status ?? 1
}

const parsed = parseCliArgs(process.argv.slice(2))
if (parsed.error) {
  console.error(`Error: ${parsed.error}\n`)
  printUsage(process.stderr)
  process.exit(2)
}

const { opts } = parsed
if (opts.help) {
  printUsage(process.stdout)
  process.exit(0)
}

if (opts.list) {
  process.exit(await runList(opts.tiers))
}

if (opts.check) {
  process.exit(await runCheck(opts))
}

process.exit(await runPlaywright(opts))
