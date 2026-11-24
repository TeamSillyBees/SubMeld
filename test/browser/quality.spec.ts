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

test('selects across pages, pairs the PC probe, verifies unified AI & availability, inline pool filters, schedules and accessibility', async ({ page, context }) => {
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
    async function audit(label: string, include?: string) {
      const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      if (include) builder.include(include)
      const result = await builder.analyze()
      expect(result.violations.map(v => [label, v.id, v.nodes.map(n => n.target)])).toEqual([])
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
    const capabilities = { agentVersion: '2.0.0', mihomoVersion: 'v1.19', protocolVersion: 4, ipStack: 'dual', localRegion: 'JP', localIsp: 'Test ISP' }
    const post = (action: string, bearer: string, body: object) => page.request.post(base + '/api/quality/agent/' + action, {
      headers: { Authorization: 'Bearer ' + bearer }, data: { profileId, jobId, ...(['enroll', 'poll'].includes(action) && { capabilities }), ...body },
    })
    expect((await post('enroll', ticket, { secret, name: 'Desk PC', platform: 'windows' })).ok()).toBe(true)
    const device = (await (await page.request.get(base + '/api/quality/devices')).json())[0]
    await expect(dialog.getByRole('radio', { name: 'Desk PC' })).toBeChecked({ timeout: 15000 })
    const secondInvite = await (await page.request.post(base + '/api/quality/invite', { data: {} })).json() as DevicePairing
    const secondSecret = randomBytes(32).toString('base64url')
    expect((await post('enroll', secondInvite.pairing.split('.').at(-1)!, { name: 'Lab PC', platform: 'linux', secret: secondSecret,
      capabilities: { ...capabilities, agentVersion: '2.0.0', protocolVersion: 4 } })).ok()).toBe(true)
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

    const mixedAi = {
      chatgptWeb: classify('chatgptWeb', { status: 403, body: '', location: '', challenge: true }),
      chatgptApp: classify('chatgptApp', { status: 403, body: '{"cf_details":"Request is not allowed. Please try again later."}', location: '', challenge: false }, null, 'JP'),
      gemini: classify('gemini', { status: 451, body: '', location: '', challenge: false }, null, 'JP'),
    } satisfies NonNullable<QualityRow['ai']>
    const unlockedAi = {
      chatgptWeb: classify('chatgptWeb', { status: 200, body: '{"cookie_consent_required":false}', location: '', challenge: false }, null, 'JP'),
      chatgptApp: classify('chatgptApp', { status: 403, body: '{"cf_details":"Request is not allowed. Please try again later."}', location: '', challenge: false }, null, 'JP'),
      gemini: classify('gemini', { status: 200, body: '<title>Gemini</title>"K4WWud":["JP"]', location: '', challenge: false }, 'JP'),
    } satisfies NonNullable<QualityRow['ai']>

    const results: QualityRow[] = job.nodes.map(({ key }, i) => {
      const slow = i === job.nodes.length - 1
      const httpsMs = slow ? 4500 : 60 + i
      return { key, available: true, error: null,
        samples: Array.from({ length: job.config.rounds }, () => ({ tlsMs: 25, httpsMs })),
        tlsMedianMs: 25, httpsMedianMs: httpsMs, jitterMs: 0, lossRate: 0,
        exit: i === 0 ? null : { ip: slow ? '192.0.2.11' : '192.0.2.10', region: 'JP' },
        ai: slow ? null : (i === 1 ? unlockedAi : mixedAi),
        aiSkipped: slow ? 'weak_connection' : undefined,
        speed: { bytes: 1048576, elapsedMs: 1000, averageBps: 1048576, peakBps: 1048576, perSecondBps: [1048576], stop: 'end' },
      }
    })
    expect((await post('complete', worker, { report: { schemaVersion: 1, jobId, startedAt: job.createdAt, finishedAt: new Date().toISOString(), results } })).ok()).toBe(true)
    await expect(dialog.getByRole('heading', { name: '检测结果' })).toBeVisible()
    await expect(dialog.getByText(/有 AI 结果的节点 204 个/)).toContainText('出口 IP 覆盖 1 / 2 个 · 需复核 1 个（占全部出口 50.0%，占已测出口 100.0%）')
    await expect(dialog.getByLabel('对比 AI 平台')).toHaveCount(0)
    await expect(dialog).not.toContainText(/grok|claude/i)
    await expect(dialog.getByRole('columnheader', { name: 'AI 解锁' })).toBeVisible()

    const firstRow = dialog.locator('tbody tr', { hasText: '东京 001' })
    const firstAiItems = firstRow.locator('[data-col="ai"] [data-surface]')
    await expect(firstAiItems).toHaveCount(3)
    await expect(firstAiItems.nth(0)).toContainText('ChatGPT Web')
    await expect(firstAiItems.nth(0).locator('[data-slot="badge"]')).toHaveAttribute('data-tone', 'warning')
    await expect(firstAiItems.nth(0).locator('[data-slot="badge"]')).toHaveText('未知')
    await expect(firstAiItems.nth(1)).toContainText('ChatGPT APP')
    await expect(firstAiItems.nth(1).locator('[data-slot="badge"]')).toHaveAttribute('data-tone', 'success')
    await expect(firstAiItems.nth(1).locator('[data-slot="badge"]')).toHaveText('JP')
    await expect(firstAiItems.nth(2)).toContainText('Gemini Web')
    await expect(firstAiItems.nth(2).locator('[data-slot="badge"]')).toHaveAttribute('data-tone', 'danger')
    await expect(firstAiItems.nth(2).locator('[data-slot="badge"]')).toHaveText('受限')

    await capture('results-mobile')
    await page.setViewportSize({ width: 1440, height: 940 })
    await capture('results-desktop')
    await audit('ReportView dialog', '[role="dialog"]')

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
    await expect(dialog.getByText('测试订阅 · 未采集到出口')).toBeVisible()
    await expect(dialog.getByText('100%（1/1 次）')).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'AI 平台' })).toBeVisible()
    await expect(dialog.locator('.quality-ai')).toContainText('ChatGPT Web')
    await expect(dialog.locator('.quality-ai')).toContainText('ChatGPT APP')
    await expect(dialog.locator('.quality-ai')).toContainText('Gemini Web')
    await expect(dialog).not.toContainText(/grok|claude/i)
    await expect(dialog.getByText(/应用网关已响应 · HTTP 403/)).toBeVisible()
    await expect(dialog.getByText(/Cloudflare 挑战/)).toBeVisible()
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

    // Job 2: basic-only run where 东京 001 fails (50% availability 1/2), 东京 002..205 succeed (100% 2/2)
    await dialog.getByRole('button', { name: '新建检测' }).click()
    await dialog.getByLabel('检测范围').selectOption('filtered')
    await dialog.getByRole('switch', { name: 'AI 平台检测' }).click()
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
    const latencyOnly: QualityRow[] = job2.nodes.map(({ key }, i) => i === 0
      ? {
          key,
          available: false,
          error: 'https_no_response',
          samples: Array.from({ length: job2.config.rounds }, () => ({ tlsMs: 25, httpsMs: null })),
          tlsMedianMs: 25,
          httpsMedianMs: null,
          jitterMs: null,
          lossRate: 1,
          exit: null,
          speed: null,
          ai: null,
        }
      : { ...results[i], key, speed: null, ai: null, aiSkipped: undefined })
    expect((await post('complete', worker, { jobId: next.id, report: { schemaVersion: 1, jobId: next.id, startedAt: job2.createdAt, finishedAt: new Date().toISOString(), results: latencyOnly } })).ok()).toBe(true)
    await expect(dialog.getByText(/AI 未检测 · 下载未检测/)).toBeVisible()
    await expect(dialog.getByRole('columnheader', { name: '平均下载' })).toHaveCount(0)
    await expect(dialog.getByLabel('结果排序')).toHaveCount(0)
    await expect(dialog.getByLabel('对比 AI 平台')).toHaveCount(0)
    await expect(dialog.locator('tbody tr', { hasText: '东京 002' })).toContainText('100%')
    await expect(dialog.locator('tbody tr', { hasText: '东京 002' })).toContainText('2/2')
    await dialog.getByPlaceholder('搜索节点、出口 IP 或地区').fill('东京 001')
    await expect(dialog.locator('tbody tr', { hasText: '东京 001' })).toContainText('50%')
    await expect(dialog.locator('tbody tr', { hasText: '东京 001' })).toContainText('1/2')
    await dialog.getByPlaceholder('搜索节点、出口 IP 或地区').fill('')
    await capture('latency-only-desktop')

    await dialog.getByRole('button', { name: '新建检测' }).click()
    await expect(dialog.getByRole('radio', { name: 'Desk PC' })).toBeChecked()
    await dialog.getByRole('button', { name: '创建检测任务' }).click()
    await dialog.getByRole('button', { name: '取消任务' }).click()
    await expect(dialog.getByText('已取消', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()

    // NodesPage: no baseline picker, unified AI unlock column, multi-check availability & sort
    await expect(page.getByLabel(/质量基准探针|基准质量报告/)).toHaveCount(0)
    await expect(page.getByLabel('对比 AI 平台')).toHaveCount(0)
    await expect(page.locator('.node-quality-bar')).toContainText('探针：Desk PC')
    await expect(page.getByRole('columnheader', { name: '可用率' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'AI 解锁' })).toBeVisible()
    const node001Row = page.locator('.nodes-table tbody tr', { hasText: '东京 001' })
    await expect(node001Row).toContainText('50%')
    await expect(node001Row).toContainText('1/2')
    await expect(node001Row).toContainText('连接失败')
    await expect(node001Row.locator('[data-col="ai"] [data-surface]').nth(1)).toContainText('JP')
    await expect(node001Row.locator('[data-col="ai"] [data-surface]').nth(2)).toContainText('受限')

    await page.getByRole('button', { name: '可用率', exact: true }).click()
    await expect(page.getByRole('button', { name: '可用率，当前降序' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.nodes-table tbody tr').first()).toContainText('东京 002')
    await page.getByRole('button', { name: '丢包率', exact: true }).click()
    await page.getByRole('button', { name: '丢包率，当前升序' }).click()
    await expect(page.getByRole('button', { name: '丢包率，当前降序' })).toHaveAttribute('aria-pressed', 'true')
    await audit('NodesPage with quality columns')

    await page.getByLabel('节点质量筛选').selectOption('highAvailability')
    await expect(page.getByRole('checkbox', { name: '选择节点 东京 002' })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: '选择节点 东京 001' })).toHaveCount(0)
    await capture('nodes-desktop')
    await page.setViewportSize({ width: 390, height: 844 })
    await capture('nodes-mobile')

    await page.getByRole('button', { name: '保存为代理组筛选池' }).click()
    await expect.poll(() => app.workspace.state().draft.groups.some(g => g.name.includes('高可用率'))).toBe(true)
    const group = app.workspace.state().draft.groups.find(g => g.name.includes('高可用率'))!
    expect(group.qualityDeviceId).toBe(device.id)

    // GroupEditor: inline quick-filter AND chips, 高级质量筛选 modal, single-probe inheritance
    await page.setViewportSize({ width: 1440, height: 940 })
    await page.goto(base + '/#/groups/' + group.id)
    await expect(page.getByLabel(/质量基准探针|基准质量报告/)).toHaveCount(0)
    await expect(page.getByText(/锁定报告并预览|按质量报告筛选/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: '低延迟高速', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '自定义阈值与兜底' })).toHaveCount(0)

    const filterSection = page.locator('.group-filter')
    await expect(filterSection.getByLabel('检测探针')).toHaveValue(device.id)
    const chipAllAi = filterSection.getByRole('button', { name: '全 AI 解锁', exact: true })
    const chipHighAvail = filterSection.getByRole('button', { name: '高可用率', exact: true })
    await expect(chipHighAvail).toHaveAttribute('aria-pressed', 'true')
    await chipAllAi.click()
    await expect(chipAllAi).toHaveAttribute('aria-pressed', 'true')
    await expect(filterSection.getByText('匹配 1 个保留节点', { exact: true })).toBeVisible()
    await audit('GroupEditor inline quality')

    await filterSection.getByRole('button', { name: /高级质量筛选/ }).click()
    const advModal = page.getByRole('dialog', { name: '高级质量筛选' })
    await expect(advModal.getByLabel('检测探针')).toHaveValue(device.id)
    await expect(advModal.getByRole('button', { name: 'ChatGPT Web', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(advModal).not.toContainText(/grok|claude/i)
    await audit('Advanced quality modal', '[role="dialog"]')

    await advModal.getByRole('button', { name: '重置条件' }).click()
    await advModal.getByLabel('最多保留节点数', { exact: true }).fill('5')
    await expect(advModal.getByRole('button', { name: '重置条件' })).toBeEnabled()
    await advModal.getByRole('button', { name: '确定' }).click()
    await expect(advModal).toHaveCount(0)
    await expect(filterSection.getByText('前 5 个')).toBeVisible()
    await expect(filterSection.locator('.quality-funnel')).toBeVisible()
    await expect(filterSection.getByRole('button', { name: /最终输出 5/ })).toBeVisible()
    await filterSection.getByRole('button', { name: /高级质量筛选/ }).click()
    await advModal.getByRole('button', { name: '重置条件' }).click()
    await expect(advModal.getByRole('button', { name: '重置条件' })).toBeDisabled()
    await expect(advModal.getByLabel('最多保留节点数', { exact: true })).toHaveValue('')
    await advModal.getByLabel('最低带宽（Mbps）', { exact: true }).fill('20')
    await advModal.getByRole('button', { name: '确定' }).click()
    await expect(advModal).toHaveCount(0)
    await expect(filterSection.getByText('带宽 ≥ 20 Mbps')).toBeVisible()
    await expect(filterSection.getByText(/带宽不足 204/)).toBeVisible()

    await filterSection.getByRole('button', { name: /高级质量筛选/ }).click()
    await advModal.getByRole('switch', { name: '筛空时恢复基础候选' }).click()
    await advModal.getByRole('button', { name: '确定' }).click()
    await expect(filterSection.getByText(/兜底恢复 205 个节点/)).toBeVisible()

    await filterSection.getByRole('button', { name: '另加一条筛选' }).click()
    await expect(filterSection.getByLabel('检测探针')).toHaveValue(device.id)
    await capture('pool-desktop')
    await page.getByRole('button', { name: '保存代理组' }).click()
    await expect(page.getByRole('button', { name: '保存代理组' })).toHaveCount(0)
    const savedGroup = app.workspace.state().draft.groups.find(g => g.id === group.id)
    expect(savedGroup?.qualityDeviceId).toBe(device.id)
    expect(savedGroup?.members[0]).toMatchObject({ kind: 'pool', quality: { minBandwidthMbps: 20, fallbackWhenEmpty: true } })
    await page.reload()
    await expect(filterSection.getByLabel('检测探针')).toHaveValue(device.id)
    await expect(filterSection.getByText('带宽 ≥ 20 Mbps')).toBeVisible()

    // PublishPage: no QualityBaselinePicker even when hasQualityPools is true
    await page.goto(base + '/#/publish')
    await expect(page.getByRole('heading', { name: '代理组质量差异' })).toBeVisible()
    await expect(page.getByLabel(/质量基准探针|基准质量报告/)).toHaveCount(0)

    // QualityPage (#/quality): schedules, AI-only trigger preserving availability, reports, and probe unpair
    await page.goto(base + '/#/quality')
    await expect(page.getByRole('heading', { name: '质量检测', exact: true })).toBeVisible()
    await page.getByLabel('执行探针').selectOption(device.id)
    await page.getByRole('switch', { name: '启用常规质量检测' }).click()
    await page.getByRole('switch', { name: '启用 AI 解锁检测' }).click()
    await page.getByRole('button', { name: '保存定时配置' }).first().click()
    await expect(page.getByText('定时检测配置已保存')).toBeVisible()
    await audit('QualityPage schedules tab')

    const scheduleRun = page.waitForResponse(r => r.url().includes('/api/quality/schedule/run') && r.request().method() === 'POST')
    await page.getByRole('button', { name: '立即执行 AI 检测' }).click()
    expect((await scheduleRun).ok()).toBe(true)
    await expect(page.getByText(/已创建 1 个定时检测任务/)).toBeVisible()
    await expect(page.getByRole('button', { name: '查看最近报告' })).toBeVisible()
    const aiJob = await (await post('poll', secret, { worker })).json() as Assignment
    expect(aiJob.config.basic).toBe(false)
    expect(aiJob.config.ai).toBe(true)
    const aiOnlyResults: QualityRow[] = aiJob.nodes.map(({ key }) => ({
      key,
      available: true,
      error: null,
      samples: [],
      tlsMedianMs: null,
      httpsMedianMs: null,
      jitterMs: null,
      lossRate: null,
      exit: null,
      speed: null,
      ai: unlockedAi,
    }))
    expect((await post('complete', worker, { jobId: aiJob.jobId, report: { schemaVersion: 1, jobId: aiJob.jobId, startedAt: aiJob.createdAt, finishedAt: new Date().toISOString(), results: aiOnlyResults } })).ok()).toBe(true)

    await page.getByRole('tab', { name: '检测报告' }).click()
    await expect(page.getByRole('heading', { name: '检测结果' })).toBeVisible()
    await expect(page.getByLabel('对比 AI 平台')).toHaveCount(0)
    await expect(page.locator('.quality-results')).not.toContainText(/grok|claude/i)
    await audit('QualityPage reports tab')

    // Verify AI-only run updated AI to JP/JP/JP while preserving 50% (1/2) availability on 东京 001
    await page.goto(base + '/#/nodes')
    const refreshed001 = page.locator('.nodes-table tbody tr', { hasText: '东京 001' })
    await expect(refreshed001).toContainText('50%')
    await expect(refreshed001).toContainText('1/2')
    await expect(refreshed001.locator('[data-col="ai"] [data-surface]').nth(0)).toContainText('JP')
    await expect(refreshed001.locator('[data-col="ai"] [data-surface]').nth(2)).toContainText('JP')

    // Unpair probe in #/quality/probes at the end of the flow
    await page.goto(base + '/#/quality/probes')
    await audit('QualityPage probes tab')
    await page.getByRole('button', { name: '解除配对', exact: true }).click()
    await page.getByRole('button', { name: '确认解除配对' }).click()
    await expect(page.getByRole('heading', { name: '常驻探针管理 0' })).toBeVisible()
    await expect(page.getByRole('button', { name: '解除配对', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '复制电脑配对链接', exact: true })).toBeVisible()
    expect((await post('poll', secret, { worker })).status()).toBe(403)
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})
