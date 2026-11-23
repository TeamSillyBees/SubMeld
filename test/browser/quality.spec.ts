import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { defaultFilter } from '../../shared/catalog.ts'
import { surfaces, type Assignment, type DevicePairing, type QualityJob, type QualityRow } from '../../shared/quality.ts'
import { classify } from '../../agent/ai.ts'
import { createApplication } from '../../server/http.ts'

test('selects across pages, pairs the PC probe, follows progress, inspects evidence and downloads JSON', async ({ page, context }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-browser-quality-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: 'quality browser fixture' })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port
    const initial = app.workspace.state()
    const source = { id: 'source-quality', name: '测试订阅', local: true, url: '', tag: '', minutes: 60, paused: false, enabled: true, filter: defaultFilter }
    const nodes = Array.from({ length: 205 }, (_, i) => ({ name: '东京 ' + String(i + 1).padStart(3, '0'), type: 'http', server: 'quality.invalid', port: 8000 + i, password: 'private-proxy-fixture' }))
    await app.workspace.saveDraft(initial.id, 'fixture', { revision: initial.revision, draft: { ...initial.draft, sources: [source] }, localNodes: { [source.id]: nodes } })
    expect((await page.request.get(base + '/api/quality/download')).status()).toBe(401)
    await page.request.post(base + '/api/login', { data: { password: 'quality browser fixture' } })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
    await page.goto(base + '/#/nodes')
    await page.getByRole('checkbox', { name: '选择节点 东京 001' }).click()
    await page.getByRole('button', { name: '质量检测', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '节点质量检测' })
    await expect(dialog.getByLabel('检测范围')).toHaveValue('selected')
    await dialog.getByLabel('检测范围').selectOption('filtered')
    await dialog.getByRole('switch', { name: '下载测速' }).click()
    await expect(dialog.getByText('205 个节点 · 下载最多 820 MiB')).toBeVisible()
    const captures = process.env.SUBMELD_QUALITY_SHOTS
    async function capture(name: string) {
      if (!captures) return
      await mkdir(captures, { recursive: true })
      await page.screenshot({ path: join(captures, 'quality-' + name + '.png'), animations: 'disabled' })
    }
    await capture('setup-desktop')
    await page.setViewportSize({ width: 390, height: 844 })
    await capture('setup-mobile')
    await expect(dialog.getByRole('button', { name: '创建检测任务' })).toBeInViewport()
    await expect(dialog.getByRole('button', { name: '创建检测任务' })).toBeDisabled()
    const href = await dialog.getByRole('link', { name: '下载 npm 安装包' }).getAttribute('href')
    const archive = await page.request.get(base + href)
    expect(archive.ok()).toBe(true)
    expect((await archive.body()).subarray(0, 2).toString('hex')).toBe('1f8b')
    const pairing = page.waitForResponse(r => r.url().includes('/api/quality/invite'))
    await dialog.getByRole('button', { name: '复制电脑配对链接', exact: true }).click()
    const invite = await (await pairing).json() as DevicePairing
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invite.pairing)
    const [, profileId, ticket] = new URL(invite.pairing).hash.slice(1).split('.')
    let jobId = ''
    const secret = randomBytes(32).toString('base64url')
    const worker = randomBytes(32).toString('base64url')
    const capabilities = { agentVersion: '1.3.0', mihomoVersion: 'v1.19', protocolVersion: 2, ipStack: 'dual', localRegion: 'JP', localIsp: 'Test ISP' }
    const post = (action: string, bearer: string, body: object) => page.request.post(base + '/api/quality/agent/' + action, {
      headers: { Authorization: 'Bearer ' + bearer }, data: { profileId, jobId, ...(['enroll', 'poll'].includes(action) && { capabilities }), ...body },
    })
    expect((await post('enroll', ticket, { secret, name: 'Desk PC', platform: 'windows' })).ok()).toBe(true)
    const device = (await (await page.request.get(base + '/api/quality/devices')).json())[0]
    await expect(dialog.getByRole('radio', { name: 'Desk PC' })).toBeChecked({ timeout: 15000 })
    const secondInvite = await (await page.request.post(base + '/api/quality/invite', { data: {} })).json() as DevicePairing
    const secondSecret = randomBytes(32).toString('base64url')
    expect((await post('enroll', secondInvite.pairing.split('.').at(-1)!, { name: 'Lab PC', platform: 'linux', secret: secondSecret })).ok()).toBe(true)
    const second = (await (await page.request.get(base + '/api/quality/devices')).json()).find((d: { name: string }) => d.name === 'Lab PC')
    await dialog.getByRole('radio', { name: 'Desk PC' }).check()
    await dialog.locator('.workspace-dialog-body').evaluate(el => { el.scrollTop = 0 })
    await capture('target-mobile')
    const created = page.waitForResponse(r => r.url().includes('/api/quality/queue'))
    await dialog.getByRole('button', { name: '创建检测任务' }).click()
    const queued = await (await created).json() as QualityJob
    jobId = queued.id
    expect(queued.targetDeviceId).toBe(device.id)
    await expect(dialog.getByRole('heading', { name: /等待 Desk PC 执行/ })).toBeVisible()
    await capture('pair-mobile')
    await dialog.getByLabel('改派在线探针').selectOption(second.id)
    await dialog.getByRole('button', { name: '改派任务' }).click()
    await expect(dialog.getByRole('heading', { name: /等待 Lab PC 执行/ })).toBeVisible()
    expect(await (await post('poll', secret, { worker })).json()).toBeNull()
    await dialog.getByLabel('改派在线探针').selectOption(device.id)
    await dialog.getByRole('button', { name: '改派任务' }).click()
    await expect(dialog.getByRole('heading', { name: /等待 Desk PC 执行/ })).toBeVisible()
    expect((await post('leave', secondSecret, {})).ok()).toBe(true)
    const job = await (await post('poll', secret, { worker })).json() as Assignment
    expect(job.nodes).toHaveLength(205)
    expect(await (await post('progress', worker, { progress: { stage: 'latency', done: 121, total: 205 } })).json()).toEqual({ ok: true })
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '121')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '质量检测', exact: true }).click()
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '121')
    const ai = Object.fromEntries(surfaces.map(s => [s, classify(s, null)])) as NonNullable<QualityRow['ai']>
    ai.grok = classify('grok', { status: 403, body: '', location: '', challenge: true })
    const results: QualityRow[] = job.nodes.map(({ key }, i) => {
      const slow = i === job.nodes.length - 1
      const httpsMs = slow ? 4500 : 60 + i
      return { key, available: true, error: null,
        samples: Array.from({ length: job.config.rounds }, () => ({ tlsMs: 25, httpsMs })),
        tlsMedianMs: 25, httpsMedianMs: httpsMs, jitterMs: 0, lossRate: 0,
        exit: { ip: slow ? '192.0.2.11' : '192.0.2.10', region: 'JP' }, ai: slow ? null : ai, aiSkipped: slow ? 'weak_connection' : undefined,
        speed: { bytes: 1048576, elapsedMs: 1000, averageBps: 1048576, peakBps: 1048576, perSecondBps: [1048576], stop: 'end' },
      }
    })
    expect((await post('complete', worker, { report: { schemaVersion: 1, jobId, startedAt: job.createdAt, finishedAt: new Date().toISOString(), results } })).ok()).toBe(true)
    await expect(dialog.getByRole('heading', { name: '检测结果' })).toBeVisible()
    await expect(dialog.getByText(/AI 已测 1 \/ 2 个/)).toContainText('需复核 1 个（占全部出口 50.0%，占已测出口 100.0%）')
    await dialog.getByLabel('对比 AI 平台').selectOption('grok')
    await capture('results-mobile')
    await page.setViewportSize({ width: 1440, height: 940 })
    await capture('results-desktop')
    const audit = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(audit.violations.map(v => [v.id, v.nodes.map(n => n.target)])).toEqual([])
    const twentieth = dialog.getByRole('button', { name: '查看检测详情 东京 020' })
    await twentieth.scrollIntoViewIfNeeded()
    const scrollBefore = await dialog.locator('.workspace-dialog-body').evaluate(el => el.scrollTop)
    await twentieth.click()
    await expect(dialog.getByRole('heading', { name: '东京 020' })).toBeFocused()
    await dialog.getByRole('button', { name: '返回检测结果' }).click()
    await expect(twentieth).toBeFocused()
    expect(await dialog.locator('.workspace-dialog-body').evaluate(el => el.scrollTop)).toBeCloseTo(scrollBefore, 0)
    await dialog.getByPlaceholder('搜索节点、出口 IP 或地区').fill('东京 001')
    await dialog.getByRole('button', { name: '查看检测详情 东京 001' }).click()
    await expect(dialog.getByText('Cloudflare 挑战', { exact: true })).toBeVisible()
    await expect(dialog.getByText('TLS 握手中位数', { exact: true })).toBeVisible()
    await capture('detail-desktop')
    await dialog.getByRole('button', { name: '返回检测结果' }).click()
    const downloaded = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '导出 JSON' }).click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe('SubMeld-质量检测-' + jobId + '.json')
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const part of stream!) chunks.push(part)
    const raw = Buffer.concat(chunks).toString()
    expect(JSON.parse(raw).results).toHaveLength(205)
    expect(raw).not.toContain('private-proxy-fixture')
    await dialog.getByRole('button', { name: '新建检测' }).click()
    await dialog.getByRole('switch', { name: 'AI 平台检测' }).click()
    // This dialog was reopened while the first job ran. New jobs default to no bandwidth test.
    await expect(dialog.getByRole('switch', { name: '下载测速' })).not.toBeChecked()
    await dialog.getByRole('radio', { name: 'Desk PC' }).check()
    await page.route('**/api/quality/queue*', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: '测试范围已更新。' }) }), { times: 1 })
    await dialog.getByRole('button', { name: '创建检测任务' }).click()
    await expect(dialog.getByText('测试范围已更新。')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '重新读取' })).toHaveCount(0)
    const nextCreated = page.waitForResponse(r => r.url().includes('/api/quality/queue'))
    await dialog.getByRole('button', { name: '创建检测任务' }).click()
    const next = await (await nextCreated).json() as QualityJob
    const job2 = await (await post('poll', secret, { worker })).json() as Assignment
    const latencyOnly = job2.nodes.map(({ key }) => ({ ...results[0], key, speed: null, ai: null }))
    await post('complete', worker, { jobId: next.id, report: { schemaVersion: 1, jobId: next.id, startedAt: job2.createdAt, finishedAt: new Date().toISOString(), results: latencyOnly } })
    await expect(dialog.getByText(/AI 未检测 · 下载未检测/)).toBeVisible()
    await expect(dialog.getByRole('columnheader', { name: '平均下载' })).toHaveCount(0)
    await expect(dialog.getByLabel('结果排序')).toHaveCount(0)
    await expect(dialog.getByLabel('对比 AI 平台')).toHaveCount(0)
    await capture('latency-only-desktop')
    await dialog.getByRole('button', { name: '新建检测' }).click()
    await expect(dialog.getByRole('radio', { name: 'Desk PC' })).toBeChecked()
    await dialog.getByRole('button', { name: '创建检测任务' }).click()
    await dialog.getByRole('button', { name: '取消任务' }).click()
    await expect(dialog.getByText('已取消', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: /管理探针与配对/ }).click()
    await dialog.getByRole('button', { name: '解除配对', exact: true }).click()
    await dialog.getByRole('button', { name: '确认解除配对' }).click()
    await expect(dialog.getByRole('button', { name: '安装并配对常驻探针' })).toBeVisible()
    expect((await post('poll', secret, { worker })).status()).toBe(403)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByLabel('基准质量报告').selectOption(queued.id)
    await expect.poll(() => app.workspace.state().draft.qualityBaselinePolicy).toEqual({ mode: 'fixed', reportId: queued.id })
    await page.reload()
    await expect(page.getByLabel('基准质量报告')).toHaveValue(queued.id)
    await page.getByRole('button', { name: '丢包率', exact: true }).click()
    await page.getByRole('button', { name: '丢包率，当前升序' }).click()
    await expect(page.getByRole('button', { name: '丢包率，当前降序' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByLabel('节点质量筛选').selectOption('lowLatency')
    await expect(page.getByRole('checkbox', { name: '选择节点 东京 001' })).toBeVisible()
    await capture('nodes-desktop')
    await page.setViewportSize({ width: 390, height: 844 })
    await capture('nodes-mobile')
    await page.getByRole('button', { name: '保存为代理组筛选池' }).click()
    await expect.poll(() => app.workspace.state().draft.groups.some(g => g.name.includes('低延迟'))).toBe(true)
    const group = app.workspace.state().draft.groups.find(g => g.name.includes('低延迟'))!
    await page.goto(base + '/#/groups/' + group.id)
    await page.getByRole('button', { name: '低延迟高速', exact: true }).click()
    await expect(page.getByText('匹配 10 个保留节点', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /最终输出 10，查看淘汰原因/ }).click()
    await expect(page.getByRole('heading', { name: '最终输出的淘汰原因' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '自定义阈值与兜底' }).click()
    await page.getByLabel('最大 HTTPS 延迟（ms）', { exact: true }).fill('')
    await page.getByLabel('最多保留节点数').fill('')
    await page.getByLabel('最低带宽（Mbps）', { exact: true }).fill('20')
    await expect(page.getByText('带宽不足 205')).toBeVisible()
    await page.getByRole('switch', { name: '筛空时恢复基础候选' }).click()
    await expect(page.getByText(/兜底恢复 205 个节点/)).toBeVisible()
    let finishRead!: () => void
    const holdRead = new Promise<void>(resolve => { finishRead = resolve })
    await page.route('**/api/quality/snapshot?id=' + next.id + '*', async route => {
      await holdRead
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '质量报告读取失败。' }) })
    }, { times: 1 })
    await page.getByLabel('基准质量报告').selectOption(next.id)
    try {
      await expect(page.locator('.group-filter').getByText('正在读取质量报告…')).toBeVisible()
      await expect(page.getByRole('button', { name: /补测 .* 个节点/ })).toHaveCount(0)
    } finally { finishRead() }
    await expect(page.getByText('质量报告读取失败。')).toBeVisible()
    await expect(page.getByRole('button', { name: /补测 .* 个节点/ })).toHaveCount(0)
    await page.getByRole('button', { name: '重新读取报告' }).click()
    await expect(page.getByText('当前基准报告未检测带宽，已跳过对应条件。')).toBeVisible()
    await expect(page.getByText('匹配 1 个保留节点', { exact: true })).toBeVisible()
    const supplement = page.getByRole('button', { name: '补测 204 个节点' })
    await expect(supplement).toBeVisible()
    await page.getByRole('button', { name: '自定义阈值与兜底' }).click()
    await page.locator('.pool-quality').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 70))
    await capture('pool-mobile')
    await page.setViewportSize({ width: 1440, height: 940 })
    await page.locator('.pool-quality').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 80))
    await capture('pool-desktop')
    await supplement.click()
    await expect(dialog.getByRole('switch', { name: '下载测速' })).toBeChecked()
    await expect(dialog.getByRole('button', { name: '创建检测任务' })).toBeDisabled()

  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})
