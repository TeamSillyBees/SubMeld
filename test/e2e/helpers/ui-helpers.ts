import { expect, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export type QualityTab = 'schedules' | 'reports' | 'probes'
export type AiTone = 'success' | 'danger' | 'warning'
export type AiSurfaceName = 'ChatGPT Web' | 'ChatGPT APP' | 'Gemini Web'

export const AI_SURFACE_ORDER: readonly AiSurfaceName[] = [
  'ChatGPT Web',
  'ChatGPT APP',
  'Gemini Web',
] as const

export const LEGACY_AI_TERMS = ['Grok', 'grok', 'Claude', 'claude', 'claudeWeb', 'claudeApi'] as const
const LEGACY_AI_REGEX = /(?:grok|claude)/i
export const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const

const SURFACE_NAME_REGEX: Record<AiSurfaceName, RegExp> = {
  'ChatGPT Web': /ChatGPT\s*Web/i,
  'ChatGPT APP': /ChatGPT\s*APP/i,
  'Gemini Web': /Gemini\s*Web/i,
}

const NON_AI_BADGE_PATTERNS: readonly RegExp[] = [
  /^已保留$/,
  /^已排除$/,
  /^名称冲突$/,
  /^精确重复/,
  /^提示条目$/,
  /^(?:标称|实测|推定)\s+/,
]

const UNTESTED_AI_CELL_REGEX = /^(?:未检测|未测|AI\s*未检测|已跳过|跳过|—|-)$/
const EXPLICIT_UNTESTED_AI_CELL_REGEX = /^(?:未检测|AI\s*未检测)$/
const TRANSIENT_LOADING_REGEX = /(?:读取中…|正在读取(?:定时检测配置|质量报告|质量记录|检测记录|报告|配置)|正在加载|加载中…)/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const QUALITY_TAB_LABELS: Record<QualityTab, RegExp> = {
  schedules: /定时任务/,
  reports: /检测报告/,
  probes: /探针管理/,
}

export interface ErrorCollector {
  readonly errors: string[]
  assertNoErrors(): void
}

export function attachErrorCollectors(page: Page): ErrorCollector {
  const errors: string[] = []
  page.on('pageerror', error => {
    errors.push(`pageerror: ${error.message}`)
  })
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  return {
    errors,
    assertNoErrors() {
      expect(errors, 'Expected zero runtime page/console errors').toEqual([])
    },
  }
}

export async function waitForAnimationsToSettle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
    const transitions = document
      .getAnimations()
      .filter(animation => Number(animation.effect?.getComputedTiming().endTime) <= 1000)
    await Promise.allSettled(transitions.map(animation => animation.finished))
  })
}

export async function runAxeAudit(
  page: Page,
  screenLabel: string,
  options: { include?: string; tags?: string[] } = {},
): Promise<void> {
  await waitForAnimationsToSettle(page)
  let builder = new AxeBuilder({ page }).withTags(options.tags ?? [...AXE_WCAG_TAGS])
  if (options.include) {
    builder = builder.include(options.include)
  }
  const result = await builder.analyze()
  expect(
    result.violations.map(violation => ({
      id: violation.id,
      nodes: violation.nodes.map(node => ({ target: node.target, issue: node.failureSummary })),
    })),
    screenLabel,
  ).toEqual([])
}

export async function expectNoHorizontalOverflow(page: Page, maxWidth?: number): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  const limit = maxWidth ?? metrics.clientWidth
  expect(
    metrics.scrollWidth,
    `Horizontal overflow detected: scrollWidth=${metrics.scrollWidth} > limit=${limit}`,
  ).toBeLessThanOrEqual(limit)
}

export async function unlockOrSetupAuth(
  page: Page,
  baseUrl: string,
  password: string,
  options: { mode?: 'api' | 'ui' } = {},
): Promise<void> {
  const mode = options.mode ?? 'api'
  const cleanBase = baseUrl.replace(/\/+$/, '')

  if (mode === 'api') {
    const sessionRes = await page.request.get(`${cleanBase}/api/session`)
    expect(sessionRes.ok()).toBe(true)
    const session = (await sessionRes.json()) as {
      setup?: boolean
      configured?: boolean
      authenticated?: boolean
    }
    if (session.setup) {
      const setupRes = await page.request.post(`${cleanBase}/api/setup`, { data: { password } })
      expect(setupRes.ok()).toBe(true)
    } else if (!session.authenticated) {
      const loginRes = await page.request.post(`${cleanBase}/api/login`, { data: { password } })
      expect(loginRes.ok()).toBe(true)
    }
    await page.goto(`${cleanBase}/#/home`)
    await expect(page.locator('#main-content')).toBeVisible()
    return
  }

  await page.goto(`${cleanBase}/`)
  const setupHeading = page.getByRole('heading', { name: '创建管理密码' })
  const loginHeading = page.getByRole('heading', { name: '登录工作台' })
  await expect(setupHeading.or(loginHeading)).toBeVisible()

  if (await setupHeading.isVisible()) {
    await page.getByLabel(/^管理密码/).fill(password)
    await page.getByLabel('确认密码').fill(password)
    await page.getByRole('button', { name: '创建并登录' }).click()
  } else {
    await page.getByLabel(/^管理密码/).fill(password)
    await page.getByRole('button', { name: '登录' }).click()
  }
  await expect(page.locator('#main-content')).toBeVisible()
}

export async function navigateToHash(
  page: Page,
  baseUrl: string,
  hashPath: string,
  expectedHeading?: RegExp,
): Promise<void> {
  const cleanBase = baseUrl.replace(/\/+$/, '')
  const normalizedHash = hashPath.startsWith('#')
    ? hashPath
    : hashPath.startsWith('/')
      ? `#${hashPath}`
      : `#/${hashPath}`
  await page.goto(`${cleanBase}/${normalizedHash}`)
  await expect(page.locator('#main-content')).toBeVisible()
  if (expectedHeading) {
    await expect(page.locator('#main-content h1').first()).toHaveText(expectedHeading)
  }
}

export async function navigateViaSidebar(page: Page, linkName: string | RegExp): Promise<void> {
  const menuTrigger = page.getByRole('button', { name: /^(?:打开导航|展开导航)$/ }).first()
  if ((await menuTrigger.count()) > 0 && (await menuTrigger.isVisible())) {
    await menuTrigger.click()
  }
  const nav = page.locator('nav[aria-label="主导航"]')
  await expect(nav).toBeVisible()
  await nav.getByRole('link', { name: linkName }).first().click()
  const mobileDialog = page.getByRole('dialog', { name: '导航菜单' })
  if ((await mobileDialog.count()) > 0) {
    await expect(mobileDialog).toBeHidden()
  }
  await expect(page.locator('#main-content')).toBeVisible()
}

export async function openQualityPage(
  page: Page,
  baseUrl: string,
  tab?: QualityTab,
): Promise<void> {
  await navigateToHash(page, baseUrl, '#/quality', /质量检测/)
  if (!tab) return
  const pattern = QUALITY_TAB_LABELS[tab]
  const tabControl = page
    .getByRole('tab', { name: pattern })
    .or(page.getByRole('radio', { name: pattern }))
    .or(page.getByRole('button', { name: pattern }))
    .first()
  await expect(tabControl).toBeVisible()
  await tabControl.click()
  await expect
    .poll(async () => {
      const selected = await tabControl.getAttribute('aria-selected')
      const checked = await tabControl.getAttribute('aria-checked')
      const pressed = await tabControl.getAttribute('aria-pressed')
      const state = await tabControl.getAttribute('data-state')
      return selected === 'true' || checked === 'true' || pressed === 'true' || state === 'on' || state === 'active'
    })
    .toBe(true)
}

export async function openNodesPage(
  page: Page,
  baseUrl: string,
  query?: Record<string, string>,
): Promise<void> {
  const suffix = query && Object.keys(query).length > 0
    ? `?${new URLSearchParams(query).toString()}`
    : ''
  await navigateToHash(page, baseUrl, `#/nodes${suffix}`, /节点管理/)
}

export async function openGroupsPage(
  page: Page,
  baseUrl: string,
  groupId?: string,
): Promise<void> {
  const hash = groupId ? `#/groups/${encodeURIComponent(groupId)}` : '#/groups'
  await navigateToHash(page, baseUrl, hash, /代理组/)
}

export async function openPublishPage(page: Page, baseUrl: string): Promise<void> {
  await navigateToHash(page, baseUrl, '#/publish', /配置发布/)
}

export async function openSourcesPage(page: Page, baseUrl: string): Promise<void> {
  await navigateToHash(page, baseUrl, '#/sources', /订阅源/)
}

export function findNodeRow(container: Page | Locator, nodeName: string): Locator {
  const page = 'page' in container ? container.page() : container
  const exactPattern = new RegExp(`^\\s*${escapeRegExp(nodeName)}\\s*$`)
  const primaryName = page
    .locator(':is(strong, [data-node-name]):not(small):not(small *):not(:has(small))')
    .filter({ hasText: exactPattern })
  const exactAny = page
    .locator('*:not(small):not(small *):not(:has(small))')
    .filter({ hasText: exactPattern })
  const primaryRow = container.getByRole('row').filter({ has: primaryName })
  const exactRowScope = !/\s{2,}/.test(nodeName)
    ? (() => {
        const hasPrimarySelector = `:is(strong, [data-node-name]):not(small):not(small *):not(:has(small)):text-is(${JSON.stringify(nodeName)})`
        return 'page' in container
          ? container.locator(`:scope:not(:has(${hasPrimarySelector}))`)
          : container.locator(`:root:not(:has(${hasPrimarySelector}))`)
      })()
    : container
  const exactRow = exactRowScope.getByRole('row').filter({ has: exactAny })
  return primaryRow.or(exactRow).first()
}

export interface AiSurfaceExpectation {
  surface?: AiSurfaceName
  tone: AiTone
  label: string | RegExp
}

type RgbaColor = [r: number, g: number, b: number, a: number]

function parseAlphaToken(token: string | undefined): number | null {
  if (token === undefined) return 1
  const trimmed = token.trim()
  if (trimmed === 'none') return 0
  if (trimmed.endsWith('%')) {
    const val = Number.parseFloat(trimmed.slice(0, -1))
    return Number.isFinite(val) ? Math.max(0, Math.min(1, val / 100)) : null
  }
  const val = Number.parseFloat(trimmed)
  return Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : null
}

function parseRgbChannelToken(token: string): number | null {
  const trimmed = token.trim()
  if (trimmed === 'none') return 0
  if (trimmed.endsWith('%')) {
    const val = Number.parseFloat(trimmed.slice(0, -1))
    return Number.isFinite(val) ? Math.max(0, Math.min(255, (val / 100) * 255)) : null
  }
  const val = Number.parseFloat(trimmed)
  return Number.isFinite(val) ? Math.max(0, Math.min(255, val)) : null
}

function parseUnitScalarToken(token: string): number | null {
  const trimmed = token.trim()
  if (trimmed === 'none') return 0
  if (trimmed.endsWith('%')) {
    const val = Number.parseFloat(trimmed.slice(0, -1))
    return Number.isFinite(val) ? val / 100 : null
  }
  const val = Number.parseFloat(trimmed)
  return Number.isFinite(val) ? val : null
}

function parseHueDegrees(token: string): number | null {
  const trimmed = token.trim().toLowerCase()
  if (trimmed === 'none') return 0
  if (trimmed.endsWith('deg')) {
    const val = Number.parseFloat(trimmed.slice(0, -3))
    return Number.isFinite(val) ? val : null
  }
  if (trimmed.endsWith('rad')) {
    const val = Number.parseFloat(trimmed.slice(0, -3))
    return Number.isFinite(val) ? (val * 180) / Math.PI : null
  }
  if (trimmed.endsWith('grad')) {
    const val = Number.parseFloat(trimmed.slice(0, -4))
    return Number.isFinite(val) ? val * 0.9 : null
  }
  if (trimmed.endsWith('turn')) {
    const val = Number.parseFloat(trimmed.slice(0, -4))
    return Number.isFinite(val) ? val * 360 : null
  }
  const val = Number.parseFloat(trimmed)
  return Number.isFinite(val) ? val : null
}

function linearSrgbToByte(c: number): number {
  const clamped = Math.max(0, Math.min(1, c))
  const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * (clamped ** (1 / 2.4)) - 0.055
  return Math.max(0, Math.min(255, srgb * 255))
}

function parseCssColorPure(raw: string): RgbaColor | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toLowerCase() === 'transparent') return [0, 0, 0, 0]

  const rgbMatch = trimmed.match(/^rgba?\((.+)\)$/i)
  if (rgbMatch) {
    const inner = rgbMatch[1].trim()
    if (inner.includes(',')) {
      const parts = inner.split(',').map(p => p.trim())
      if (parts.length === 3 || parts.length === 4) {
        const r = parseRgbChannelToken(parts[0])
        const g = parseRgbChannelToken(parts[1])
        const b = parseRgbChannelToken(parts[2])
        const a = parseAlphaToken(parts[3])
        if (r !== null && g !== null && b !== null && a !== null) {
          return [r, g, b, a]
        }
      }
    } else {
      const slashIdx = inner.indexOf('/')
      const colorPart = (slashIdx >= 0 ? inner.slice(0, slashIdx) : inner).trim()
      const alphaPart = slashIdx >= 0 ? inner.slice(slashIdx + 1).trim() : undefined
      const parts = colorPart.split(/\s+/)
      if (parts.length === 3) {
        const r = parseRgbChannelToken(parts[0])
        const g = parseRgbChannelToken(parts[1])
        const b = parseRgbChannelToken(parts[2])
        const a = parseAlphaToken(alphaPart)
        if (r !== null && g !== null && b !== null && a !== null) {
          return [r, g, b, a]
        }
      }
    }
  }

  const srgbMatch = trimmed.match(/^color\(\s*srgb\s+([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)(?:\s*\/\s*([^\s)]+))?\s*\)$/i)
  if (srgbMatch) {
    const r = parseUnitScalarToken(srgbMatch[1])
    const g = parseUnitScalarToken(srgbMatch[2])
    const b = parseUnitScalarToken(srgbMatch[3])
    const a = parseAlphaToken(srgbMatch[4])
    if (r !== null && g !== null && b !== null && a !== null) {
      return [
        Math.max(0, Math.min(255, r * 255)),
        Math.max(0, Math.min(255, g * 255)),
        Math.max(0, Math.min(255, b * 255)),
        a,
      ]
    }
  }

  const oklchMatch = trimmed.match(/^oklch\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)(?:\s*\/\s*([^\s)]+))?\s*\)$/i)
  if (oklchMatch) {
    const lVal = parseUnitScalarToken(oklchMatch[1])
    const cRaw = oklchMatch[2].trim()
    const cVal = cRaw === 'none'
      ? 0
      : cRaw.endsWith('%')
        ? (Number.parseFloat(cRaw.slice(0, -1)) * 0.4) / 100
        : Number.parseFloat(cRaw)
    const hDeg = parseHueDegrees(oklchMatch[3])
    const a = parseAlphaToken(oklchMatch[4])
    if (lVal !== null && Number.isFinite(cVal) && hDeg !== null && a !== null) {
      const rad = (hDeg * Math.PI) / 180
      const aLab = cVal * Math.cos(rad)
      const bLab = cVal * Math.sin(rad)
      const l_ = lVal + 0.3963377774 * aLab + 0.2158037573 * bLab
      const m_ = lVal - 0.1055613458 * aLab - 0.0638541728 * bLab
      const s_ = lVal - 0.0894841775 * aLab - 1.2914855480 * bLab
      const l = l_ * l_ * l_
      const m = m_ * m_ * m_
      const s = s_ * s_ * s_
      const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
      const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
      const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
      return [linearSrgbToByte(rLin), linearSrgbToByte(gLin), linearSrgbToByte(bLin), a]
    }
  }

  return null
}

async function assertToneVisualSemantics(badge: Locator, expectedTone: AiTone): Promise<void> {
  const dataTone = await badge.getAttribute('data-tone')
  if (dataTone) {
    expect(dataTone).toBe(expectedTone)
    return
  }

  const styleSamples = await badge.evaluate(el => {
    const style = getComputedStyle(el)
    const toCanvasRgba = (raw: string): [number, number, number, number] | null => {
      if (!raw || raw === 'transparent') return [0, 0, 0, 0]
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = raw
      ctx.fillRect(0, 0, 1, 1)
      const data = ctx.getImageData(0, 0, 1, 1).data
      return [data[0], data[1], data[2], data[3] / 255]
    }
    const samples = [
      { raw: style.color, canvas: toCanvasRgba(style.color) },
      { raw: style.backgroundColor, canvas: toCanvasRgba(style.backgroundColor) },
    ]
    const borderTopWidth = Number.parseFloat(style.borderTopWidth)
    if (Number.isFinite(borderTopWidth) && borderTopWidth > 0 && style.borderTopStyle !== 'none') {
      samples.push({ raw: style.borderTopColor, canvas: toCanvasRgba(style.borderTopColor) })
    }
    return samples
  })

  let best: { rgba: RgbaColor; chroma: number; raw: string } | null = null
  for (const entry of styleSamples) {
    const parsed = parseCssColorPure(entry.raw) ?? entry.canvas
    if (!parsed || parsed[3] <= 0.01) continue
    const chroma = Math.max(parsed[0], parsed[1], parsed[2]) - Math.min(parsed[0], parsed[1], parsed[2])
    if (!best || chroma > best.chroma) {
      best = { rgba: parsed, chroma, raw: entry.raw }
    }
  }

  expect(best, `Unable to inspect semantic tone "${expectedTone}" for element`).not.toBeNull()
  if (best) {
    expect(
      best.chroma,
      `Expected chromatic semantic color for "${expectedTone}", got neutral colors (${styleSamples.map(s => s.raw).join(', ')})`,
    ).toBeGreaterThan(10)
    const [r, g, b] = best.rgba
    if (expectedTone === 'success') {
      expect(g, `Expected green-dominant color for success, got ${best.raw}`).toBeGreaterThan(r)
      expect(g, `Expected green-dominant color for success, got ${best.raw}`).toBeGreaterThan(b)
    } else if (expectedTone === 'danger') {
      expect(r, `Expected red-dominant color for danger, got ${best.raw}`).toBeGreaterThan(g)
      expect(r, `Expected red-dominant color for danger, got ${best.raw}`).toBeGreaterThan(b)
    } else {
      expect(r, `Expected amber/yellow color for warning, got ${best.raw}`).toBeGreaterThan(b)
      expect(g, `Expected amber/yellow color for warning, got ${best.raw}`).toBeGreaterThan(b)
      expect(
        g,
        `Expected amber/yellow proportions (g >= 0.45 * r) for warning, got ${best.raw}`,
      ).toBeGreaterThanOrEqual(r * 0.45)
      expect(
        g,
        `Expected amber/yellow proportions (g <= 1.15 * r) for warning, got ${best.raw}`,
      ).toBeLessThanOrEqual(r * 1.15)
    }
  }
}

const AI_SURFACE_KEYS: Record<AiSurfaceName, 'chatgptWeb' | 'chatgptApp' | 'gemini'> = {
  'ChatGPT Web': 'chatgptWeb',
  'ChatGPT APP': 'chatgptApp',
  'Gemini Web': 'gemini',
}

export async function expectAiUnlockCell(
  rowOrContainer: Locator,
  expectations: readonly AiSurfaceExpectation[],
): Promise<void> {
  await expect(rowOrContainer).toBeVisible()
  await expect(rowOrContainer).not.toContainText(TRANSIENT_LOADING_REGEX)

  // Phase 1: Resolve searchRoot (AI cell if <tr>, else rowOrContainer)
  const isTableRow = await rowOrContainer.evaluate(el => el.tagName.toLowerCase() === 'tr')
  let resolvedAiCell: Locator | null = null

  if (isTableRow) {
    const explicitAiCell = rowOrContainer
      .locator(
        'td[data-col="ai"], [data-ai-unlock], td:has([data-surface]), td:has(.mobile-cell-label:has-text("AI 解锁")), td:has(:is(div, span, li)[aria-label*="ChatGPT Web"]), td:has(:is(div, span, li)[aria-label*="ChatGPT APP"]), td:has(:is(div, span, li)[aria-label*="Gemini Web"])',
      )
      .first()
    if ((await explicitAiCell.count()) > 0) {
      resolvedAiCell = explicitAiCell
    } else {
      const headerColIndex = await rowOrContainer.evaluate(tr => {
        const table = tr.closest('table')
        if (!table) return -1
        const headerRow =
          Array.from(table.querySelectorAll('thead tr')).find(r => r.querySelector('th') !== null) ??
          Array.from(table.querySelectorAll('tr')).find(r => r.querySelector('th') !== null) ??
          null
        if (!headerRow) return -1
        return Array.from(headerRow.children).findIndex(
          cell => cell.tagName.toLowerCase() === 'th' && /AI\s*解锁/i.test(cell.textContent ?? ''),
        )
      })
      if (headerColIndex >= 0) {
        const headerMatchedCell = rowOrContainer.locator(`td:nth-child(${headerColIndex + 1})`).first()
        await expect(headerMatchedCell, 'Matched AI 解锁 column header but cell is missing').toHaveCount(1)
        resolvedAiCell = headerMatchedCell
      } else {
        type HeaderlessClassification = {
          chosenIndex: number
          hasUntestedCell: boolean
          ambiguousCount: number
          hasTransientLoading: boolean
        }
        let classification: HeaderlessClassification = {
          chosenIndex: -1,
          hasUntestedCell: false,
          ambiguousCount: 0,
          hasTransientLoading: false,
        }
        await expect
          .poll(async () => {
            classification = await rowOrContainer.evaluate(
              (tr, args) => {
                const rowText = tr.textContent ?? ''
                const hasTransientLoading = new RegExp(args.loadingPattern.source, args.loadingPattern.flags).test(
                  rowText,
                )
                const nonAiRegexes = args.nonAiPatterns.map(p => new RegExp(p.source, p.flags))
                const surfaceRegexes = args.surfacePatterns.map(p => new RegExp(p.source, p.flags))
                const untestedRegex = new RegExp(args.untestedPattern.source, args.untestedPattern.flags)
                const explicitUntestedRegex = new RegExp(
                  args.explicitUntestedPattern.source,
                  args.explicitUntestedPattern.flags,
                )
                const tds = Array.from(tr.children).filter(el => el.tagName.toLowerCase() === 'td')
                const eligible = tds.map((td, idx) => {
                  const hasNonAiMarker =
                    td.querySelector(
                      'input[type="checkbox"], button, .node-final-name, .node-names, .node-meta, .row-actions',
                    ) !== null
                  const badges = Array.from(td.querySelectorAll('[data-slot="badge"]'))
                  const hasNonAiBadge = badges.some(b => {
                    const txt = (b.textContent ?? '').trim()
                    return nonAiRegexes.some(re => re.test(txt))
                  })
                  const text = (td.textContent ?? '').trim()
                  const hasSurfaceText = surfaceRegexes.some(re => re.test(text))
                  const isUntested = untestedRegex.test(text)
                  const isExplicitAiUntested = explicitUntestedRegex.test(text)
                  return {
                    idx,
                    excluded: hasNonAiMarker || hasNonAiBadge,
                    badgeCount: badges.length,
                    hasSurfaceText,
                    isUntested,
                    isExplicitAiUntested,
                  }
                }).filter(item => !item.excluded)

                const surfaceCell = eligible.find(item => item.hasSurfaceText)
                if (surfaceCell) {
                  return {
                    chosenIndex: surfaceCell.idx,
                    hasUntestedCell: false,
                    ambiguousCount: 1,
                    hasTransientLoading,
                  }
                }

                const threeBadgeCell = eligible.find(item => item.badgeCount >= 3)
                if (threeBadgeCell) {
                  return {
                    chosenIndex: threeBadgeCell.idx,
                    hasUntestedCell: false,
                    ambiguousCount: 1,
                    hasTransientLoading,
                  }
                }

                if (args.expectationsLength >= 2) {
                  const multiCell = eligible.find(item => item.badgeCount >= args.expectationsLength)
                  return {
                    chosenIndex: multiCell ? multiCell.idx : -1,
                    hasUntestedCell: false,
                    ambiguousCount: multiCell ? 1 : 0,
                    hasTransientLoading,
                  }
                }

                const badgeCells = eligible.filter(item => item.badgeCount >= 1)
                const hasUntestedCell =
                  badgeCells.length === 1
                    ? eligible.some(item => item.isExplicitAiUntested)
                    : eligible.some(item => item.isUntested)
                return {
                  chosenIndex: !hasUntestedCell && badgeCells.length === 1 ? badgeCells[0].idx : -1,
                  hasUntestedCell,
                  ambiguousCount: badgeCells.length,
                  hasTransientLoading,
                }
              },
              {
                loadingPattern: { source: TRANSIENT_LOADING_REGEX.source, flags: TRANSIENT_LOADING_REGEX.flags },
                nonAiPatterns: NON_AI_BADGE_PATTERNS.map(r => ({ source: r.source, flags: r.flags })),
                surfacePatterns: AI_SURFACE_ORDER.map(s => ({
                  source: SURFACE_NAME_REGEX[s].source,
                  flags: SURFACE_NAME_REGEX[s].flags,
                })),
                untestedPattern: { source: UNTESTED_AI_CELL_REGEX.source, flags: UNTESTED_AI_CELL_REGEX.flags },
                explicitUntestedPattern: {
                  source: EXPLICIT_UNTESTED_AI_CELL_REGEX.source,
                  flags: EXPLICIT_UNTESTED_AI_CELL_REGEX.flags,
                },
                expectationsLength: expectations.length,
              },
            )
            if (classification.hasTransientLoading) {
              return 'AI unlock cell is still loading'
            }
            if (expectations.length === 1) {
              if (classification.hasUntestedCell) {
                return 'Headerless row has untested AI cell and no explicit AI column marker'
              }
              if (classification.ambiguousCount !== 1) {
                return `Expected exactly 1 eligible AI badge cell in headerless row, found ${classification.ambiguousCount}`
              }
            }
            if (classification.chosenIndex < 0) {
              return 'Unable to locate AI unlock cell in headerless row'
            }
            return 'ok'
          })
          .toBe('ok')

        if (expectations.length === 1) {
          expect(
            classification.hasUntestedCell,
            'Headerless row has untested AI cell and no explicit AI column marker',
          ).toBe(false)
          expect(
            classification.ambiguousCount,
            `Expected exactly 1 eligible AI badge cell in headerless row, found ${classification.ambiguousCount}`,
          ).toBe(1)
        }
        expect(
          classification.chosenIndex,
          'Unable to locate AI unlock cell in headerless row',
        ).toBeGreaterThanOrEqual(0)
        resolvedAiCell = rowOrContainer.locator('td').nth(classification.chosenIndex)
      }
    }
  }

  const searchRoot = resolvedAiCell ?? rowOrContainer
  let searchRootText = ''
  await expect
    .poll(
      async () => {
        const raw = (await searchRoot.textContent()) ?? ''
        const trimmed = raw.trim()
        if (!trimmed || TRANSIENT_LOADING_REGEX.test(trimmed)) return false
        searchRootText = raw
        return true
      },
      { message: 'Expected AI unlock cell to finish loading before verifying surface states' },
    )
    .toBe(true)

  // Phase 2: Verify surface order on searchRoot (text labels & DOM attributes)
  const textMatches: Array<{ surface: AiSurfaceName; index: number }> = []
  for (const name of AI_SURFACE_ORDER) {
    const match = SURFACE_NAME_REGEX[name].exec(searchRootText)
    if (match && match.index !== undefined) {
      textMatches.push({ surface: name, index: match.index })
    }
  }
  if (textMatches.length >= 2) {
    for (let k = 1; k < textMatches.length; k++) {
      expect(
        textMatches[k].index,
        `Expected ${textMatches[k - 1].surface} before ${textMatches[k].surface} in AI unlock cell`,
      ).toBeGreaterThan(textMatches[k - 1].index)
    }
  }

  const domOrderError = await searchRoot.evaluate(
    (root, args) => {
      const surfaceEls: Array<{ surface: string; el: Element }> = []
      for (const name of args.order) {
        const key = args.keys[name]
        let found: Element | null = root.querySelector(`[data-surface="${key}"], [data-surface="${name}"]`)
        if (!found) {
          const candidates = Array.from(root.querySelectorAll(`[aria-label*="${name}"]`))
          found =
            candidates.find(el => {
              const label = el.getAttribute('aria-label') ?? ''
              const hasOtherName = args.order.some(other => other !== name && label.includes(other))
              const hasNestedSurface = Array.from(el.querySelectorAll('[data-surface]')).some(
                nested => nested.getAttribute('data-surface') !== key && nested.getAttribute('data-surface') !== name,
              )
              return !hasOtherName && !hasNestedSurface
            }) ?? null
        }
        if (found) surfaceEls.push({ surface: name, el: found })
      }
      for (let k = 1; k < surfaceEls.length; k++) {
        const prev = surfaceEls[k - 1]
        const curr = surfaceEls[k]
        const pos = prev.el.compareDocumentPosition(curr.el)
        if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) === 0 || (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0) {
          return `Expected DOM order ${prev.surface} before ${curr.surface}`
        }
      }
      return null
    },
    { order: [...AI_SURFACE_ORDER], keys: AI_SURFACE_KEYS },
  )
  expect(domOrderError, domOrderError ?? undefined).toBeNull()

  // Phase 3: Per-surface isolated slot & exact badge resolution
  const hasAnySurfaceText = AI_SURFACE_ORDER.some(s => SURFACE_NAME_REGEX[s].test(searchRootText))
  const hasAnySurfaceAttr =
    (await searchRoot
      .locator(
        '[data-surface], [aria-label*="ChatGPT Web"], [aria-label*="ChatGPT APP"], [aria-label*="Gemini Web"]',
      )
      .count()) > 0 ||
    (await searchRoot.evaluate(el => {
      if (el.hasAttribute('data-surface')) return true
      const aria = el.getAttribute('aria-label') ?? ''
      return /ChatGPT\s*Web|ChatGPT\s*APP|Gemini\s*Web/i.test(aria)
    }))

  const resolvedBadges: Array<{ surface: AiSurfaceName; badge: Locator }> = []
  const page = searchRoot.page()

  for (let i = 0; i < expectations.length; i++) {
    const item = expectations[i]
    const surfaceName = item.surface ?? AI_SURFACE_ORDER[i]
    const surfaceKey = AI_SURFACE_KEYS[surfaceName]
    const otherSurfaces = AI_SURFACE_ORDER.filter(s => s !== surfaceName)
    let badgeLocator: Locator | null = null

    // 3.1 Try tagged slot ([data-surface] or single-surface [aria-label])
    let dataSurfaceSlot = searchRoot.locator(`[data-surface="${surfaceKey}"], [data-surface="${surfaceName}"]`)
    for (const other of otherSurfaces) {
      dataSurfaceSlot = dataSurfaceSlot.filter({ hasNotText: SURFACE_NAME_REGEX[other] })
    }

    let taggedSlot: Locator | null = null
    if ((await dataSurfaceSlot.count()) > 0) {
      taggedSlot = dataSurfaceSlot.first()
    } else {
      const selfDataSurface = await searchRoot.evaluate(
        (el, args) => {
          const ds = el.getAttribute('data-surface')
          if (ds !== args.key && ds !== args.name) return false
          const txt = el.textContent ?? ''
          return !args.otherPatterns.some(p => new RegExp(p.source, p.flags).test(txt))
        },
        {
          key: surfaceKey,
          name: surfaceName,
          otherPatterns: otherSurfaces.map(o => ({
            source: SURFACE_NAME_REGEX[o].source,
            flags: SURFACE_NAME_REGEX[o].flags,
          })),
        },
      )
      if (selfDataSurface) {
        taggedSlot = searchRoot
      } else {
        let ariaCandidates = searchRoot.locator(`[aria-label*="${surfaceName}"]`)
        for (const other of otherSurfaces) {
          ariaCandidates = ariaCandidates.filter({ hasNotText: SURFACE_NAME_REGEX[other] })
        }
        const matchedAriaIdx = await ariaCandidates.evaluateAll(
          (els, args) =>
            els.findIndex(el => {
              const aria = el.getAttribute('aria-label') ?? ''
              if (args.otherNames.some(o => aria.includes(o))) return false
              const nested = Array.from(el.querySelectorAll('[data-surface]'))
              return !nested.some(n => {
                const ds = n.getAttribute('data-surface')
                return ds !== args.key && ds !== args.name
              })
            }),
          { otherNames: otherSurfaces, key: surfaceKey, name: surfaceName },
        )
        if (matchedAriaIdx >= 0) {
          taggedSlot = ariaCandidates.nth(matchedAriaIdx)
        } else {
          const selfAriaMatches = await searchRoot.evaluate(
            (el, args) => {
              const aria = el.getAttribute('aria-label') ?? ''
              if (!aria.includes(args.name)) return false
              if (args.otherNames.some(o => aria.includes(o))) return false
              const txt = el.textContent ?? ''
              return !args.otherPatterns.some(p => new RegExp(p.source, p.flags).test(txt))
            },
            {
              name: surfaceName,
              otherNames: otherSurfaces,
              otherPatterns: otherSurfaces.map(o => ({
                source: SURFACE_NAME_REGEX[o].source,
                flags: SURFACE_NAME_REGEX[o].flags,
              })),
            },
          )
          if (selfAriaMatches) taggedSlot = searchRoot
        }
      }
    }

    if (taggedSlot) {
      const nestedBadge = taggedSlot.locator('[data-slot="badge"]')
      if ((await nestedBadge.count()) > 0) {
        badgeLocator = nestedBadge.first()
        await expect(badgeLocator).toHaveText(item.label)
      } else {
        if (typeof item.label === 'string') {
          const slotText = ((await taggedSlot.textContent()) ?? '').trim()
          badgeLocator =
            slotText === item.label ? taggedSlot : taggedSlot.getByText(item.label, { exact: true }).first()
        } else {
          const leaf = taggedSlot.locator('span, strong, b, code, small').filter({ hasText: item.label }).last()
          badgeLocator = (await leaf.count()) > 0 ? leaf : taggedSlot
        }
        await expect(badgeLocator).toHaveText(item.label)
      }
    } else if (hasAnySurfaceText) {
      // 3.2 Un-tagged text-labeled layout: NEVER match multi-surface ancestor, NEVER fall through to positional
      let singleSurface = searchRoot
        .locator('div, li, p, span, section, article, dd')
        .filter({ hasText: SURFACE_NAME_REGEX[surfaceName] })
      for (const other of otherSurfaces) {
        singleSurface = singleSurface.filter({ hasNotText: SURFACE_NAME_REGEX[other] })
      }
      const isSelfSingleSurface =
        SURFACE_NAME_REGEX[surfaceName].test(searchRootText) &&
        !otherSurfaces.some(other => SURFACE_NAME_REGEX[other].test(searchRootText))

      const totalBadges = await searchRoot.locator('[data-slot="badge"]').count()
      if (totalBadges > 0) {
        const withBadge = singleSurface.filter({ has: page.locator('[data-slot="badge"]') }).last()
        if ((await withBadge.count()) > 0) {
          badgeLocator = withBadge.locator('[data-slot="badge"]').first()
          await expect(badgeLocator).toHaveText(item.label)
        } else if (isSelfSingleSurface) {
          badgeLocator = searchRoot.locator('[data-slot="badge"]').first()
          await expect(badgeLocator).toHaveText(item.label)
        } else {
          // Flat-sibling DOM-order scan inside searchRoot
          const flatBadgeIndex = await searchRoot.evaluate(
            (root, args) => {
              const allBadges = Array.from(root.querySelectorAll('[data-slot="badge"]'))
              const surfaceRegexes = args.surfaces.map(s => ({
                name: s.name,
                re: new RegExp(s.source, s.flags),
              }))
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
              let currentSurface: string | null = null
              let pendingText = ''
              let node: Node | null = walker.nextNode()
              while (node) {
                if (node.nodeType === Node.TEXT_NODE) {
                  const parentEl = node.parentElement
                  if (!parentEl || !parentEl.closest('[data-slot="badge"]')) {
                    pendingText += node.textContent ?? ''
                    let latestSurface: { name: string; end: number } | null = null
                    for (const s of surfaceRegexes) {
                      const m = s.re.exec(pendingText)
                      if (m && m.index !== undefined) {
                        const end = m.index + m[0].length
                        if (!latestSurface || end > latestSurface.end) {
                          latestSurface = { name: s.name, end }
                        }
                      }
                    }
                    if (latestSurface) {
                      currentSurface = latestSurface.name
                      pendingText = pendingText.slice(latestSurface.end)
                    }
                  }
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                  const el = node as Element
                  if (el.matches('[data-slot="badge"]') && !el.parentElement?.closest('[data-slot="badge"]')) {
                    if (currentSurface === args.targetSurface) {
                      return allBadges.indexOf(el)
                    }
                    currentSurface = null
                    pendingText = ''
                  }
                }
                node = walker.nextNode()
              }
              return -1
            },
            {
              targetSurface: surfaceName,
              surfaces: AI_SURFACE_ORDER.map(s => ({
                name: s,
                source: SURFACE_NAME_REGEX[s].source,
                flags: SURFACE_NAME_REGEX[s].flags,
              })),
            },
          )
          expect(
            flatBadgeIndex,
            `Unable to locate badge for surface "${surfaceName}" in flat-sibling AI unlock cell`,
          ).toBeGreaterThanOrEqual(0)
          badgeLocator = searchRoot.locator('[data-slot="badge"]').nth(flatBadgeIndex)
          await expect(badgeLocator).toHaveText(item.label)
        }
      } else {
        // 3.2b Plain-text layout (0 [data-slot="badge"] elements)
        const candidateIdx = await singleSurface.evaluateAll(
          (els, pat) => {
            const re = new RegExp(pat.source, pat.flags)
            for (let idx = els.length - 1; idx >= 0; idx--) {
              const stripped = (els[idx].textContent ?? '').replace(re, '').trim()
              if (stripped.length > 0) return idx
            }
            return -1
          },
          { source: SURFACE_NAME_REGEX[surfaceName].source, flags: SURFACE_NAME_REGEX[surfaceName].flags },
        )
        let isolatedContainer: Locator
        if (candidateIdx >= 0) {
          isolatedContainer = singleSurface.nth(candidateIdx)
        } else if (isSelfSingleSurface) {
          isolatedContainer = searchRoot
        } else {
          expect(
            candidateIdx,
            `Unable to locate isolated text container for surface "${surfaceName}"`,
          ).toBeGreaterThanOrEqual(0)
          isolatedContainer = singleSurface.first()
        }

        if (typeof item.label === 'string') {
          badgeLocator = isolatedContainer.getByText(item.label, { exact: true }).first()
        } else {
          const leaf = isolatedContainer.locator('span, strong, b, code, small').filter({ hasText: item.label }).last()
          badgeLocator = (await leaf.count()) > 0 ? leaf : isolatedContainer
        }
        await expect(badgeLocator).toHaveText(item.label)
      }
    } else if (hasAnySurfaceAttr) {
      expect(
        0,
        `Expected tagged slot for surface "${surfaceName}" inside attributed AI unlock cell`,
      ).toBeGreaterThan(0)
      badgeLocator = searchRoot
    } else {
      // 3.3 Pure positional badge cell (no surface text and no surface attributes)
      const surfaceIndex = item.surface ? AI_SURFACE_ORDER.indexOf(item.surface) : i
      badgeLocator = searchRoot.locator('[data-slot="badge"]').nth(surfaceIndex)
      await expect(badgeLocator).toHaveText(item.label)
    }

    // Phase 4: Visual tone verification
    await assertToneVisualSemantics(badgeLocator, item.tone)
    resolvedBadges.push({ surface: surfaceName, badge: badgeLocator })
  }

  // Phase 4b: Verify resolved badge DOM order follows AI_SURFACE_ORDER
  if (resolvedBadges.length >= 2) {
    const orderedBadges = [...resolvedBadges].sort(
      (a, b) => AI_SURFACE_ORDER.indexOf(a.surface) - AI_SURFACE_ORDER.indexOf(b.surface),
    )
    const handles = await Promise.all(orderedBadges.map(entry => entry.badge.elementHandle()))
    for (let k = 1; k < handles.length; k++) {
      const prev = handles[k - 1]
      const curr = handles[k]
      if (prev && curr && orderedBadges[k - 1].surface !== orderedBadges[k].surface) {
        const follows = await prev.evaluate(
          (prevEl, currEl) => (prevEl.compareDocumentPosition(currEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          curr,
        )
        expect(
          follows,
          `Expected resolved badge for ${orderedBadges[k - 1].surface} before ${orderedBadges[k].surface}`,
        ).toBe(true)
      }
    }
    await Promise.all(handles.map(h => h?.dispose()))
  }
}

export async function expectNoLegacyAiPlatforms(scope: Page | Locator): Promise<void> {
  const root = 'goto' in scope ? scope.locator('body') : scope
  const text = (await root.textContent()) ?? ''
  expect(text, 'Unexpected legacy AI term found in UI').not.toMatch(LEGACY_AI_REGEX)
}

export async function expectNoAiPlatformFilterDropdown(scope: Page | Locator): Promise<void> {
  const legacyDropdown = scope.getByLabel(/对比\s*AI\s*平台|AI\s*平台筛选|^AI\s*平台$/i)
  await expect(legacyDropdown).toHaveCount(0)

  const aiCombobox = scope.getByRole('combobox', { name: /AI\s*平台|对比\s*AI/i })
  await expect(aiCombobox).toHaveCount(0)

  const selects = scope.locator('select')
  const count = await selects.count()
  for (let i = 0; i < count; i++) {
    const optionTexts = await selects.nth(i).locator('option').allTextContents()
    for (const optionText of optionTexts) {
      expect(optionText, 'Unexpected AI platform filter option in select').not.toMatch(/ChatGPT|Gemini|Claude|Grok/i)
    }
  }

  const comboboxes = scope.getByRole('combobox')
  const comboCount = await comboboxes.count()
  for (let i = 0; i < comboCount; i++) {
    const box = comboboxes.nth(i)
    const ariaLabel = (await box.getAttribute('aria-label')) ?? ''
    const text = (await box.textContent()) ?? ''
    expect(ariaLabel, 'Unexpected AI platform combobox label').not.toMatch(/AI\s*平台|对比\s*AI/i)
    expect(text, 'Unexpected AI platform value in combobox').not.toMatch(/ChatGPT|Gemini|Claude|Grok/i)
  }
}

export function getRuleFilterSection(page: Page): Locator {
  return page.locator('.group-filter').or(page.getByRole('region', { name: /动态筛选/ })).first()
}

export async function toggleQuickQualityChip(scope: Locator, chipLabel: string | RegExp): Promise<void> {
  const chip = scope
    .getByRole('button', { name: chipLabel })
    .or(scope.getByRole('checkbox', { name: chipLabel }))
    .or(scope.getByRole('switch', { name: chipLabel }))
    .first()
  await expect(chip).toBeVisible()
  await chip.click()
}

export async function expectQuickChipActive(
  scope: Locator,
  chipLabel: string | RegExp,
  active = true,
): Promise<void> {
  const chip = scope
    .getByRole('button', { name: chipLabel })
    .or(scope.getByRole('checkbox', { name: chipLabel }))
    .or(scope.getByRole('switch', { name: chipLabel }))
    .first()
  await expect(chip).toBeVisible()
  await expect
    .poll(
      async () =>
        chip.evaluate(el => {
          if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
            return el.checked
          }
          const isPressed = el.getAttribute('aria-pressed')
          const isChecked = el.getAttribute('aria-checked')
          const dataState = el.getAttribute('data-state')
          return isPressed === 'true' || isChecked === 'true' || dataState === 'on' || dataState === 'checked'
        }),
      { message: `Expected quick chip "${String(chipLabel)}" active=${active}` },
    )
    .toBe(active)
}

export async function openAdvancedQualityModal(page: Page, scope?: Locator): Promise<Locator> {
  const trigger = (scope ?? page).getByRole('button', { name: /高级质量筛选/ }).first()
  await expect(trigger).toBeVisible()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: /高级质量筛选/ })
  await expect(dialog).toBeVisible()
  return dialog
}

export async function expectNoReportBaselinePicker(page: Page): Promise<void> {
  await expect(page.getByLabel(/基准质量报告|质量基准探针/)).toHaveCount(0)
  await expect(page.getByText(/锁定报告并预览/)).toHaveCount(0)
}

export async function expectInheritedProbeInRule(
  scope: Locator,
  probeName: string | RegExp,
): Promise<void> {
  const probeSelect = scope.getByRole('combobox', { name: /探针/ }).first()
  if ((await probeSelect.count()) > 0) {
    await expect(probeSelect).toBeVisible()
    const selectedText = await probeSelect.evaluate(el => {
      if (el instanceof HTMLSelectElement) {
        return el.selectedOptions[0]?.textContent ?? el.value
      }
      return el.textContent ?? ''
    })
    if (typeof probeName === 'string') {
      expect(selectedText).toContain(probeName)
    } else {
      expect(selectedText).toMatch(probeName)
    }
    return
  }
  await expect(scope.getByText(probeName).first()).toBeVisible()
}

export async function expectAvailabilityBadgeOrText(
  row: Locator,
  expectedPercent: string | RegExp,
): Promise<void> {
  await expect(row).toBeVisible()
  await expect(row).not.toContainText(TRANSIENT_LOADING_REGEX)
  let target = row
  const isTableRow = await row.evaluate(el => el.tagName.toLowerCase() === 'tr')
  if (isTableRow) {
    await expect
      .poll(async () => {
        const explicitCell = row
          .locator('td[data-col="availability"], [data-availability], td:has(.mobile-cell-label:has-text("可用率"))')
          .first()
        if ((await explicitCell.count()) > 0) {
          target = explicitCell
          return 'ok'
        }
        const headerInfo = await row.evaluate(tr => {
          const table = tr.closest('table')
          if (!table) return { hasHeaders: false, colIndex: -1 }
          const headerRow =
            Array.from(table.querySelectorAll('thead tr')).find(r => r.querySelector('th') !== null) ??
            Array.from(table.querySelectorAll('tr')).find(r => r.querySelector('th') !== null) ??
            null
          if (!headerRow) return { hasHeaders: false, colIndex: -1 }
          const colIndex = Array.from(headerRow.children).findIndex(
            cell => cell.tagName.toLowerCase() === 'th' && /可用率/i.test(cell.textContent ?? ''),
          )
          return { hasHeaders: true, colIndex }
        })
        if (headerInfo.colIndex >= 0) {
          const headerCell = row.locator(`td:nth-child(${headerInfo.colIndex + 1})`).first()
          if ((await headerCell.count()) !== 1) {
            return 'Matched 可用率 column header but cell is missing'
          }
          target = headerCell
          return 'ok'
        }
        if (headerInfo.hasHeaders) {
          return 'Table has headers but no 可用率 column or marker was found'
        }
        target = row
        return 'ok'
      })
      .toBe('ok')
  }

  await expect(target).not.toContainText(TRANSIENT_LOADING_REGEX)
  if (typeof expectedPercent === 'string') {
    const boundaryPattern = new RegExp(`(?:^|[^\\d.])${escapeRegExp(expectedPercent)}(?![\\d.])`)
    await expect(target).toContainText(boundaryPattern)
    return
  }
  await expect(target).toContainText(expectedPercent)
}

export interface ConfigureScheduleUiOptions {
  probeName?: string | RegExp
  scope?: 'kept' | 'all'
  autoRefreshGroups?: boolean
  basic?: { enabled?: boolean; intervalMinutes?: number; bandwidth?: boolean }
  ai?: { enabled?: boolean; intervalMinutes?: number }
}

async function setCheckboxOrSwitch(control: Locator, desired: boolean): Promise<void> {
  await expect(control).toBeVisible()
  const tagName = await control.evaluate(el => el.tagName.toLowerCase())
  if (tagName === 'input') {
    const checked = await control.isChecked()
    if (checked !== desired) await control.click()
    return
  }
  const ariaChecked = await control.getAttribute('aria-checked')
  const dataState = await control.getAttribute('data-state')
  const isOn = ariaChecked === 'true' || dataState === 'checked' || dataState === 'on'
  if (isOn !== desired) await control.click()
}

async function setNumberOrSelectControl(control: Locator, value: number): Promise<void> {
  await expect(control).toBeVisible()
  const tagName = await control.evaluate(el => el.tagName.toLowerCase())
  if (tagName === 'select') {
    await control.selectOption(String(value))
    return
  }
  await control.fill(String(value))
}

export async function configureQualitySchedule(
  page: Page,
  opts: ConfigureScheduleUiOptions,
): Promise<void> {
  await expect(page.getByText('正在读取定时检测配置…')).toBeHidden()

  if (opts.probeName !== undefined) {
    const probeSelect = page.getByRole('combobox', { name: /执行探针|目标探针/ }).first()
    await expect(probeSelect).toBeVisible()
    const optionLabel = typeof opts.probeName === 'string'
      ? opts.probeName
      : await probeSelect.locator('option').evaluateAll((options, pat) => {
          const re = new RegExp(pat.source, pat.flags)
          return options.find(o => re.test(o.textContent ?? ''))?.textContent?.trim() ?? ''
        }, { source: opts.probeName.source, flags: opts.probeName.flags })
    expect(optionLabel, `No matching probe option for ${String(opts.probeName)}`).not.toBe('')
    await probeSelect.selectOption({ label: optionLabel })
  }

  if (opts.scope !== undefined) {
    const scopeSelect = page.getByRole('combobox', { name: /检测范围/ }).first()
    await expect(scopeSelect).toBeVisible()
    await scopeSelect.selectOption(opts.scope)
  }

  if (opts.autoRefreshGroups !== undefined) {
    const autoToggle = page
      .getByRole('switch', { name: /联动更新动态代理组|自动联动更新/ })
      .or(page.getByRole('checkbox', { name: /联动更新动态代理组|自动联动更新/ }))
      .first()
    await setCheckboxOrSwitch(autoToggle, opts.autoRefreshGroups)
  }

  if (opts.basic?.enabled !== undefined) {
    const basicToggle = page
      .getByRole('switch', { name: /启用常规质量检测|常规质量检测/ })
      .or(page.getByRole('checkbox', { name: /启用常规质量检测|常规质量检测/ }))
      .first()
    await setCheckboxOrSwitch(basicToggle, opts.basic.enabled)
  }
  if (opts.basic?.intervalMinutes !== undefined) {
    const basicInterval = page
      .getByRole('spinbutton', { name: /常规检测周期|常规检测间隔/ })
      .or(page.getByRole('combobox', { name: /常规检测周期|常规检测间隔/ }))
      .first()
    await setNumberOrSelectControl(basicInterval, opts.basic.intervalMinutes)
  }
  if (opts.basic?.bandwidth !== undefined) {
    const bwToggle = page
      .getByRole('switch', { name: /包含下载测速|下载测速/ })
      .or(page.getByRole('checkbox', { name: /包含下载测速|下载测速/ }))
      .first()
    await setCheckboxOrSwitch(bwToggle, opts.basic.bandwidth)
  }

  if (opts.ai?.enabled !== undefined) {
    const aiToggle = page
      .getByRole('switch', { name: /启用\s*AI\s*解锁检测|AI\s*解锁检测/ })
      .or(page.getByRole('checkbox', { name: /启用\s*AI\s*解锁检测|AI\s*解锁检测/ }))
      .first()
    await setCheckboxOrSwitch(aiToggle, opts.ai.enabled)
  }
  if (opts.ai?.intervalMinutes !== undefined) {
    const aiInterval = page
      .getByRole('spinbutton', { name: /AI\s*检测周期|AI\s*检测间隔/ })
      .or(page.getByRole('combobox', { name: /AI\s*检测周期|AI\s*检测间隔/ }))
      .first()
    await setNumberOrSelectControl(aiInterval, opts.ai.intervalMinutes)
  }

  const saveButton = page.getByRole('button', { name: /保存定时配置|保存设置/ }).first()
  await expect(saveButton).toBeVisible()
  const responsePromise = page.waitForResponse(res => {
    if (res.request().method() !== 'POST') return false
    try {
      return new URL(res.url()).pathname.endsWith('/api/quality/schedule')
    } catch {
      return false
    }
  })
  await saveButton.click()
  const res = await responsePromise
  expect(res.ok(), `POST /api/quality/schedule failed with status ${res.status()}`).toBe(true)
}

export async function triggerScheduleRunButton(
  page: Page,
  kind: 'basic' | 'ai' | 'due',
): Promise<void> {
  const buttonName = kind === 'basic'
    ? /立即执行常规检测/
    : kind === 'ai'
      ? /立即执行\s*AI\s*检测/
      : /执行到期任务/
  const btn = page.getByRole('button', { name: buttonName }).first()
  await expect(btn).toBeVisible()
  await expect(btn).toBeEnabled()
  const responsePromise = page.waitForResponse(
    res => res.url().includes('/api/quality/schedule/run') && res.request().method() === 'POST',
  )
  await btn.click()
  const res = await responsePromise
  expect(res.ok()).toBe(true)
}

export async function confirmAlertDialog(
  page: Page,
  actionPattern: string | RegExp,
): Promise<void> {
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: actionPattern }).click()
  await expect(dialog).toBeHidden()
}

export async function closeModal(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toBeHidden()
}
