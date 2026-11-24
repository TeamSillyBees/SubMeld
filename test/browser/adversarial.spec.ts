import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { stringify } from 'yaml'
import { defaultFilter } from '../../shared/catalog.ts'
import type { Projection } from '../../shared/model.ts'
import { poolCondition } from '../../shared/group-filter.ts'
import { defaultQualityScheduleConfig, qualityDefaults, type Assignment, type DevicePairing, type QualityRow } from '../../shared/quality.ts'
import { minimumProbeVersion, probeProtocol } from '../../shared/quality-options.ts'
import { createApplication } from '../../server/http.ts'
import { createFeedbackNotifier } from '../../src/notify.ts'

const PASSWORD = 'adversarial browser fixture'

test('FE-T5-01: PublishPage ignores stale /api/check and /api/publish 422 results when datasetKey changes mid-flight', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-release-'))
  let upstreamProxies = [
    { name: '🇭🇰 HK-01', type: 'ss', cipher: 'aes-128-gcm', server: 'adv.example.net', port: 9001, password: 'pw' },
  ]
  const upstream = createServer((_, res) => {
    res.end(stringify({ proxies: upstreamProxies }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamUrl = 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port + '/sub'

  const app = createApplication({ directory: dir, allowPrivate: true, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const sourceId = 'src-adv-release'
    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{
          id: sourceId, name: 'AdvSub', tag: '', url: upstreamUrl,
          enabled: true, paused: false, minutes: 60, filter: defaultFilter,
        }],
      },
    })
    await app.workspace.refresh(initial.id, { id: sourceId })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/publish')
    await expect(page.getByRole('button', { name: '运行检查' })).toBeVisible()

    // Part A: /api/check TOCTOU — fetch pre-refresh 0-issue result, hold response while source refreshes, then fulfill
    let checkPickedUp!: () => void
    let releaseCheck!: () => void
    const checkPickedUpPromise = new Promise<void>(r => { checkPickedUp = r })
    const releaseCheckPromise = new Promise<void>(r => { releaseCheck = r })

    await page.route('**/api/check*', async route => {
      const response = await route.fetch()
      checkPickedUp()
      await releaseCheckPromise
      await route.fulfill({ response })
    })

    await page.getByRole('button', { name: '运行检查' }).click()
    await checkPickedUpPromise

    const revisionBefore = app.workspace.state().revision
    upstreamProxies = [
      { name: '🇭🇰 HK-01', type: 'ss', cipher: 'aes-128-gcm', server: 'adv.example.net', port: 9001, password: 'pw' },
      { name: '🇭🇰 HK-01', type: 'ss', cipher: 'aes-128-gcm', server: 'adv.example.net', port: 9002, password: 'pw' },
    ]
    const nodesUpdatedA = page.waitForResponse(r => new URL(r.url()).pathname === '/api/source-nodes' && r.ok())
    await page.request.post(base + '/api/refresh', { data: { id: sourceId } })
    await nodesUpdatedA
    await page.waitForTimeout(100)
    expect(app.workspace.state().revision).toBe(revisionBefore)

    releaseCheck()
    await expect(page.getByRole('button', { name: '运行检查' })).toBeEnabled()
    await expect(page.getByText('校验通过')).toHaveCount(0)

    await page.unroute('**/api/check*')

    // Part B: /api/publish 422 TOCTOU — hold 422 response while source refreshes, verify stale 422 error is not shown
    const preRefreshCheck = await (await page.request.post(base + '/api/check', { data: {} })).json() as Projection
    let publishPickedUp!: () => void
    let releasePublish!: () => void
    const publishPickedUpPromise = new Promise<void>(r => { publishPickedUp = r })
    const releasePublishPromise = new Promise<void>(r => { releasePublish = r })

    await page.route('**/api/publish*', async route => {
      publishPickedUp()
      await releasePublishPromise
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          message: '校验未通过',
          detail: {
            ...preRefreshCheck,
            issues: [{
              severity: 'error',
              code: 'stale-422',
              message: 'STALE_PUBLISH_422_ERROR',
              pane: 'nodes',
              id: sourceId,
            }],
          },
        }),
      })
    })

    await page.getByRole('button', { name: '发布配置' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '确认发布' }).click()
    await publishPickedUpPromise

    upstreamProxies = [
      { name: '🇭🇰 HK-01', type: 'ss', cipher: 'aes-128-gcm', server: 'adv.example.net', port: 9001, password: 'pw' },
      { name: '🇯🇵 JP-01', type: 'ss', cipher: 'aes-128-gcm', server: 'adv.example.net', port: 9003, password: 'pw' },
    ]
    const nodesUpdatedB = page.waitForResponse(r => new URL(r.url()).pathname === '/api/source-nodes' && r.ok())
    await page.request.post(base + '/api/refresh', { data: { id: sourceId } })
    await nodesUpdatedB
    await page.waitForTimeout(100)

    releasePublish()
    await expect(page.getByRole('button', { name: '发布配置' })).toBeEnabled()
    await expect(page.getByText('STALE_PUBLISH_422_ERROR')).toHaveCount(0)
  } finally {
    await app.close()
    await new Promise(resolve => upstream.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-T5-02: feedback notifier activates after dispose() and delivers live UI toasts', async ({ page }) => {
  // 1. Direct notifier dispose() -> activate() verification
  const shown: string[] = []
  const notifier = createFeedbackNotifier({
    dismiss: () => {},
    show: (message) => shown.push(message),
  })
  notifier.dispose()
  notifier.notify('dropped-while-disposed', 'info')
  await page.waitForTimeout(80)
  expect(shown).toEqual([])

  notifier.activate()
  notifier.notify('delivered-after-activate', 'success')
  await expect.poll(() => shown.length).toBe(1)
  expect(shown).toEqual(['delivered-after-activate'])
  notifier.dispose()

  // 2. Real browser toast delivery
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-toast-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port
    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{ id: 'src-toast', local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }],
      },
      localNodes: { 'src-toast': [{ name: 'ToastNode', type: 'http', server: 'toast.invalid', port: 8000 }] },
    })
    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/nodes')
    await page.getByRole('button', { name: '收藏或备注 ToastNode' }).click()
    await page.getByRole('dialog', { name: '节点收藏与备注' }).getByRole('button', { name: '保存备注' }).click()
    await expect(page.locator('[data-sonner-toast]')).toContainText('节点备注已保存')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-T5-03: GroupEditor inline 复制 button locks busy/disabled on double-click during delayed POST /api/draft', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-copy-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port
    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        groups: [{
          id: 'grp-copy-1', name: 'CopyTarget', type: 'select', enabled: true,
          members: [{ kind: 'builtin', id: 'DIRECT' }],
          testUrl: '', seconds: 300, tolerance: 50, strategy: 'consistent-hashing', lazy: true, disableUdp: false,
        }],
      },
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/groups/grp-copy-1')

    let draftPosts = 0
    let conflictResponses = 0
    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') {
        draftPosts++
        await new Promise(r => setTimeout(r, 250))
      }
      const res = await route.fetch()
      if (res.status() === 409) conflictResponses++
      await route.fulfill({ response: res })
    })

    const copyBtn = page.getByRole('button', { name: '复制' })
    await expect(copyBtn).toBeVisible()
    await copyBtn.click()
    await expect(copyBtn).toBeDisabled()
    await copyBtn.click({ force: true })

    await expect(copyBtn).toBeEnabled()
    expect(draftPosts).toBe(1)
    expect(conflictResponses).toBe(0)
    await expect(page.getByText('配置已在另一处更新')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-T5-04: NodesPage saveNote locks busy/disabled on double-click during delayed POST /api/note', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-note-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port
    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{ id: 'src-note', local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }],
      },
      localNodes: { 'src-note': [{ name: 'NoteNode', type: 'http', server: 'note.invalid', port: 8000 }] },
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/nodes')

    let notePosts = 0
    await page.route('**/api/note*', async route => {
      if (route.request().method() === 'POST') {
        notePosts++
        await new Promise(r => setTimeout(r, 250))
      }
      await route.continue()
    })

    await page.getByRole('button', { name: '收藏或备注 NoteNode' }).click()
    const dialog = page.getByRole('dialog', { name: '节点收藏与备注' })
    await dialog.getByLabel('备注').fill('防抖测试备注')
    const saveBtn = dialog.getByRole('button', { name: '保存备注' })
    await saveBtn.click()
    await expect(saveBtn).toBeDisabled()
    await saveBtn.click({ force: true })

    await expect(dialog).toBeHidden()
    expect(notePosts).toBe(1)
    await expect(page.locator('[data-sonner-toast]')).toContainText('节点备注已保存')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-T5-05: disabled Toggle label uses cursor: not-allowed while enabled Toggle label uses cursor: pointer', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-cursor-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port
    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{ id: 'src-cursor', local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }],
      },
      localNodes: { 'src-cursor': [{ name: 'CursorNode', type: 'http', server: 'cursor.invalid', port: 8000 }] },
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/nodes')
    await page.getByRole('button', { name: '质量检测', exact: true }).click()

    const dialog = page.getByRole('dialog', { name: '节点质量检测' })
    await dialog.getByRole('switch', { name: '常规质量检测' }).click()
    await expect(dialog.getByRole('switch', { name: '下载测速' })).toBeDisabled()

    const basicLabel = dialog.locator('.setting-toggle').filter({ hasText: '常规质量检测' }).locator('[data-slot="field-label"]')
    const speedToggle = dialog.locator('.setting-toggle').filter({ hasText: '下载测速' })
    const speedLabel = speedToggle.locator('[data-slot="field-label"]')

    await expect(speedToggle).toHaveAttribute('data-disabled', 'true')
    expect(await basicLabel.evaluate(el => getComputedStyle(el).cursor)).toBe('pointer')
    expect(await speedLabel.evaluate(el => getComputedStyle(el).cursor)).toBe('not-allowed')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-T5-06: navigating #/home -> #/groups immediately refreshes useLatestQuality without waiting 8s', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-nav-refresh-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    const invite = await (await page.request.post(base + '/api/quality/invite', { data: {} })).json() as DevicePairing
    const [, profileId, ticket] = new URL(invite.pairing).hash.slice(1).split('.')
    const secret = randomBytes(32).toString('base64url')
    const worker = randomBytes(32).toString('base64url')
    const capabilities = { agentVersion: minimumProbeVersion, protocolVersion: probeProtocol, localRegion: 'JP', localIsp: 'ISP', ipStack: 'dual', mihomoVersion: '1.0' }
    const agentPost = (action: string, bearer: string, payload: unknown) => page.request.post(base + '/api/quality/agent/' + action, {
      headers: { Authorization: 'Bearer ' + bearer }, data: payload,
    })
    expect((await agentPost('enroll', ticket, { profileId, name: 'Nav Probe', platform: 'linux', secret, capabilities })).ok()).toBe(true)
    const deviceId = ((await (await page.request.get(base + '/api/quality/devices')).json()) as Array<{ id: string }>)[0].id

    const initial = app.workspace.state()
    const sourceId = 'source-nav-01'
    const saved = await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{ id: sourceId, local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }],
        groups: [{
          id: 'grp-nav-1', name: 'NavPool', type: 'select', enabled: true, qualityDeviceId: deviceId,
          members: [poolCondition({ quality: { maxLatencyMs: 200, untestedPolicy: 'exclude' } })],
        }],
      },
      localNodes: {
        [sourceId]: [
          { name: 'Fast-Node', type: 'http', server: 'nav.invalid', port: 8001 },
          { name: 'Slow-Node', type: 'http', server: 'nav.invalid', port: 8002 },
        ],
      },
    })
    const keys = saved.sources[sourceId].good!.nodes.map(n => sourceId + '/' + n.id)

    // Land on #/home and wait for initial quality/latest poll to settle (with empty data)
    const initialLatest = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/latest' && r.ok())
    await page.goto(base + '/#/home')
    await initialLatest
    await expect(page.getByRole('heading', { name: '订阅工作台' })).toBeVisible()

    // Out-of-band quality job completion while user is on #/home
    const qRes = await page.request.post(base + '/api/quality/queue', {
      data: { targetDeviceId: deviceId, keys, config: { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 } },
    })
    const qJob = await qRes.json() as { id: string; createdAt: string }
    const assignment = await (await agentPost('poll', secret, { profileId, worker, capabilities })).json() as Assignment
    expect(assignment.jobId).toBe(qJob.id)
    const rows: QualityRow[] = [
      { key: keys[0], available: true, error: null, samples: [{ tlsMs: 10, httpsMs: 40 }, { tlsMs: 12, httpsMs: 40 }], tlsMedianMs: 11, httpsMedianMs: 40, jitterMs: 0, lossRate: 0, exit: { ip: '192.0.2.1', region: 'JP' }, speed: null, ai: null },
      { key: keys[1], available: true, error: null, samples: [{ tlsMs: 20, httpsMs: 400 }, { tlsMs: 20, httpsMs: 400 }], tlsMedianMs: 20, httpsMedianMs: 400, jitterMs: 0, lossRate: 0, exit: { ip: '192.0.2.2', region: 'JP' }, speed: null, ai: null },
    ]
    expect((await agentPost('complete', worker, {
      profileId, jobId: qJob.id,
      report: { schemaVersion: 1, jobId: qJob.id, startedAt: qJob.createdAt, finishedAt: new Date().toISOString(), results: rows },
    })).ok()).toBe(true)

    // Navigate via SPA sidebar link #/home -> #/groups (NO reload!) and assert immediate refresh (< 3000ms, well below 8000ms poll)
    const navLatest = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/latest' && r.ok(), { timeout: 3000 })
    await page.locator('nav[aria-label="主导航"]').getByRole('link', { name: '代理组' }).click()
    await navLatest

    const filterSection = page.locator('.group-filter')
    await expect(filterSection.getByRole('status')).toContainText('匹配 1 个保留节点', { timeout: 2500 })
    await expect(filterSection.locator('.pool-sample')).toContainText('Fast-Node', { timeout: 2500 })
    await expect(filterSection.locator('.pool-sample')).not.toContainText('Slow-Node')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I2-01: QualitySchedulePanel drops stale GET /api/quality/schedule resolving after save()', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-sched-race-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    const invite = await (await page.request.post(base + '/api/quality/invite', { data: {} })).json() as DevicePairing
    const [, profileId, ticket] = new URL(invite.pairing).hash.slice(1).split('.')
    const secret = randomBytes(32).toString('base64url')
    const worker = randomBytes(32).toString('base64url')
    const capabilities = { agentVersion: minimumProbeVersion, protocolVersion: probeProtocol, localRegion: 'JP', localIsp: 'ISP', ipStack: 'dual', mihomoVersion: '1.0' }
    const agentPost = (action: string, bearer: string, payload: unknown) => page.request.post(base + '/api/quality/agent/' + action, {
      headers: { Authorization: 'Bearer ' + bearer }, data: payload,
    })
    expect((await agentPost('enroll', ticket, { profileId, name: 'Sched Probe', platform: 'linux', secret, capabilities })).ok()).toBe(true)
    const deviceId = ((await (await page.request.get(base + '/api/quality/devices')).json()) as Array<{ id: string }>)[0].id

    const initial = app.workspace.state()
    const sourceId = 'src-sched-race'
    const saved = await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{ id: sourceId, local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }],
      },
      localNodes: { [sourceId]: [{ name: 'SchedNode', type: 'http', server: 'sched.invalid', port: 8001 }] },
    })
    const keys = saved.sources[sourceId].good!.nodes.map(n => sourceId + '/' + n.id)

    // Queue a live job so useQualityWorkspace polls every 2.5s
    const qRes = await page.request.post(base + '/api/quality/queue', {
      data: { targetDeviceId: deviceId, keys, config: { ...qualityDefaults, basic: true, bandwidth: false, ai: false, rounds: 2 } },
    })
    const qJob = await qRes.json() as { id: string; createdAt: string }

    const initialSched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'GET' && r.ok())
    await page.goto(base + '/#/quality/schedules')
    await initialSched

    const basicSwitch = page.getByRole('switch', { name: '启用常规质量检测' })
    await expect(basicSwitch).toBeVisible()
    await expect(basicSwitch).not.toBeChecked()

    // Hold the next GET /api/quality/schedule triggered by completedKey change
    let staleGetPickedUp!: () => void
    let releaseStaleGet!: () => void
    const staleGetPickedUpPromise = new Promise<void>(r => { staleGetPickedUp = r })
    const releaseStaleGetPromise = new Promise<void>(r => { releaseStaleGet = r })

    await page.route('**/api/quality/schedule*', async route => {
      if (route.request().method() === 'GET') {
        const response = await route.fetch()
        staleGetPickedUp()
        await releaseStaleGetPromise
        await route.fulfill({ response })
        return
      }
      await route.continue()
    })

    // Complete the job so the next 2.5s poll triggers completedKey -> loadSchedule(false)
    const assignment = await (await agentPost('poll', secret, { profileId, worker, capabilities })).json() as Assignment
    expect(assignment.jobId).toBe(qJob.id)
    expect((await agentPost('complete', worker, {
      profileId, jobId: qJob.id,
      report: {
        schemaVersion: 1, jobId: qJob.id, startedAt: qJob.createdAt, finishedAt: new Date().toISOString(),
        results: [{ key: keys[0], available: true, error: null, samples: [{ tlsMs: 10, httpsMs: 40 }, { tlsMs: 12, httpsMs: 42 }], tlsMedianMs: 11, httpsMedianMs: 41, jitterMs: 1, lossRate: 0, exit: { ip: '192.0.2.10', region: 'JP' }, speed: null, ai: null }],
      },
    })).ok()).toBe(true)

    await staleGetPickedUpPromise

    // Toggle and save while stale GET is still held in flight
    await basicSwitch.click()
    await expect(basicSwitch).toBeChecked()
    await expect(page.locator('.settings-save-bar')).toHaveCount(1)

    const savePost = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'POST' && r.ok())
    await page.locator('.settings-save-bar').getByRole('button', { name: '保存定时配置' }).click()
    await savePost
    await expect(page.locator('.settings-save-bar')).toHaveCount(0)

    // Release stale pre-save GET and assert original/dirty are not reverted
    releaseStaleGet()
    await page.waitForTimeout(200)
    await expect(page.locator('.settings-save-bar')).toHaveCount(0)
    await expect(basicSwitch).toBeChecked()
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I2-02: RulesPage disables row action buttons and blocks concurrent POST /api/draft 409 conflicts', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-rules-race-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        services: [{ id: 'svc-race-1', name: 'AdvSvc', enabled: true, target: 'DIRECT', provider: null, preset: null }],
        rules: [
          { id: 'rule-race-1', serviceId: 'svc-race-1', type: 'DOMAIN-SUFFIX', value: 'one.example.com', enabled: true, noResolve: false },
          { id: 'rule-race-2', serviceId: 'svc-race-1', type: 'DOMAIN-SUFFIX', value: 'two.example.com', enabled: true, noResolve: false },
        ],
      },
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/rules')

    const rows = page.locator('.rule-table tbody tr')
    await expect(rows).toHaveCount(2)
    const row1Btn = rows.nth(0).getByRole('button', { name: '停用' })
    const row2Btn = rows.nth(1).getByRole('button', { name: '停用' })
    await expect(row1Btn).toBeVisible()
    await expect(row2Btn).toBeVisible()

    let draftPosts = 0
    let status409 = 0
    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') {
        draftPosts++
        await new Promise(r => setTimeout(r, 250))
      }
      const res = await route.fetch()
      if (res.status() === 409) status409++
      await route.fulfill({ response: res })
    })

    await row1Btn.click()
    await expect(row1Btn).toBeDisabled()
    await expect(row2Btn).toBeDisabled()
    await row2Btn.click({ force: true })

    await expect(rows.nth(0).getByRole('button', { name: '启用' })).toBeEnabled()
    await expect(row2Btn).toBeEnabled()
    expect(draftPosts).toBe(1)
    expect(status409).toBe(0)
    await expect(page.getByText('配置已在另一处更新')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I2-03: GroupsPage locks GroupEditor fields during 复制 and prevents mid-flight delete modal close', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-groups-race-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        groups: [{
          id: 'grp-race-1', name: 'AdvGroup', type: 'select', enabled: true,
          members: [{ kind: 'builtin', id: 'DIRECT' }],
          testUrl: '', seconds: 300, tolerance: 50, strategy: 'consistent-hashing', lazy: true, disableUdp: false,
        }],
      },
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/groups/grp-race-1')

    // Part A: GroupEditor fields inert while 复制 is in flight
    let copyPickedUp!: () => void
    let releaseCopy!: () => void
    const copyPickedUpPromise = new Promise<void>(r => { copyPickedUp = r })
    const releaseCopyPromise = new Promise<void>(r => { releaseCopy = r })

    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') {
        const res = await route.fetch()
        copyPickedUp()
        await releaseCopyPromise
        await route.fulfill({ response: res })
        return
      }
      await route.continue()
    })

    const copyBtn = page.getByRole('button', { name: '复制' })
    await copyBtn.click()
    await copyPickedUpPromise

    const fields = page.locator('.group-fields')
    const nameInput = page.getByLabel('代理组名称')
    await expect(fields).toHaveAttribute('inert', '')
    expect(await nameInput.evaluate(el => {
      el.focus()
      return Boolean(el.closest('[inert]')) && document.activeElement !== el
    })).toBe(true)

    releaseCopy()
    await expect(copyBtn).toBeEnabled()
    await expect(fields).not.toHaveAttribute('inert', '')
    await page.unroute('**/api/draft*')

    // Part B: delete modal 取消 disabled and modal stays open mid-flight
    let delPickedUp!: () => void
    let releaseDel!: () => void
    const delPickedUpPromise = new Promise<void>(r => { delPickedUp = r })
    const releaseDelPromise = new Promise<void>(r => { releaseDel = r })

    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') {
        const res = await route.fetch()
        delPickedUp()
        await releaseDelPromise
        await route.fulfill({ response: res })
        return
      }
      await route.continue()
    })

    await page.getByRole('button', { name: '删除代理组 AdvGroup' }).click()
    const dialog = page.getByRole('dialog', { name: /删除代理组/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '确认删除' }).click()
    await delPickedUpPromise

    const cancelBtn = dialog.getByRole('button', { name: '取消' })
    await expect(cancelBtn).toBeDisabled()
    await cancelBtn.click({ force: true })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()

    releaseDel()
    await expect(dialog).toBeHidden()
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I2-04: SourcesPage disables 导入设置 and keeps delete modal open/取消 disabled mid-flight', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-sources-race-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{ id: 'src-race-1', local: true, name: 'AdvSource', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }],
      },
      localNodes: { 'src-race-1': [{ name: 'AdvNode', type: 'http', server: 'adv.invalid', port: 8001 }] },
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/sources')

    let delPickedUp!: () => void
    let releaseDel!: () => void
    const delPickedUpPromise = new Promise<void>(r => { delPickedUp = r })
    const releaseDelPromise = new Promise<void>(r => { releaseDel = r })

    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') {
        const res = await route.fetch()
        delPickedUp()
        await releaseDelPromise
        await route.fulfill({ response: res })
        return
      }
      await route.continue()
    })

    await page.getByRole('button', { name: '删除 AdvSource' }).click()
    const dialog = page.getByRole('dialog', { name: '删除订阅源' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '确认删除' }).click()
    await delPickedUpPromise

    const cancelBtn = dialog.getByRole('button', { name: '取消' })
    const importBtn = page.locator('button', { hasText: '导入设置' })
    await expect(cancelBtn).toBeDisabled()
    await expect(importBtn).toBeDisabled()
    await cancelBtn.click({ force: true })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()

    releaseDel()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: '导入设置' })).toBeEnabled()
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I3-01: GroupEditor inline 撤销更改 is disabled during save() in flight and prevents 409 conflict', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-undo-race-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        groups: [{
          id: 'grp-undo-1', name: 'UndoTarget', type: 'select', enabled: true,
          members: [{ kind: 'builtin', id: 'DIRECT' }],
          testUrl: '', seconds: 300, tolerance: 50, strategy: 'consistent-hashing', lazy: true, disableUdp: false,
        }],
      },
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/groups/grp-undo-1')

    const nameInput = page.getByLabel('代理组名称')
    await expect(nameInput).toHaveValue('UndoTarget')
    await nameInput.fill('UndoTargetEdited')

    const undoBtn = page.getByRole('button', { name: '撤销更改' })
    const saveBtn = page.getByRole('button', { name: '保存代理组' })
    await expect(undoBtn).toBeVisible()
    await expect(saveBtn).toBeEnabled()

    let draftPosts = 0
    let conflictCount = 0
    let savePickedUp!: () => void
    let releaseSave!: () => void
    const savePickedUpPromise = new Promise<void>(r => { savePickedUp = r })
    const releaseSavePromise = new Promise<void>(r => { releaseSave = r })

    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') {
        draftPosts++
        const res = await route.fetch()
        if (res.status() === 409) conflictCount++
        savePickedUp()
        await releaseSavePromise
        await route.fulfill({ response: res })
        return
      }
      await route.continue()
    })

    await saveBtn.click()
    await savePickedUpPromise

    await expect(undoBtn).toBeDisabled()
    await expect(page.locator('.group-fields')).toHaveAttribute('inert', '')
    await undoBtn.click({ force: true })
    await expect(page.getByRole('button', { name: '复制' })).toHaveCount(0)
    await expect(undoBtn).toBeDisabled()

    releaseSave()
    await expect(undoBtn).toHaveCount(0)
    await expect(page.getByRole('button', { name: '复制' })).toBeEnabled()
    expect(draftPosts).toBe(1)
    expect(conflictCount).toBe(0)
    await expect(page.getByText('配置已在另一处更新')).toHaveCount(0)
    expect(app.workspace.state().draft.groups.find(g => g.id === 'grp-undo-1')?.name).toBe('UndoTargetEdited')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I3-02: ServiceEditor locks 保存服务/取消/fields during POST /api/refresh and CatalogDialog locks 取消/fields during save', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-rules-busy-'))
  const upstream = createServer((_, res) => {
    res.setHeader('content-type', 'text/yaml')
    res.end(stringify({ payload: ['DOMAIN-SUFFIX,example.com'] }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const providerUrl = 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port + '/prov.yaml'

  const app = createApplication({ directory: dir, allowPrivate: true, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        services: [{
          id: 'svc-prov-1', name: 'ProviderSvc', enabled: true, target: 'DIRECT', preset: null,
          provider: { url: providerUrl, behavior: 'classical', format: 'yaml', minutes: 1440 },
        }],
        rules: [{
          id: 'rule-prov-1', serviceId: 'svc-prov-1', type: 'RULE-SET', value: '', enabled: true, noResolve: false,
        }],
      },
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/rules/svc-prov-1')

    const dialog = page.getByRole('dialog', { name: '编辑服务 · ProviderSvc' })
    await expect(dialog).toBeVisible()

    let draftPosts = 0
    let refreshPickedUp!: () => void
    let releaseRefresh!: () => void
    const refreshPickedUpPromise = new Promise<void>(r => { refreshPickedUp = r })
    const releaseRefreshPromise = new Promise<void>(r => { releaseRefresh = r })

    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') draftPosts++
      await route.continue()
    })
    await page.route('**/api/refresh*', async route => {
      const res = await route.fetch()
      refreshPickedUp()
      await releaseRefreshPromise
      await route.fulfill({ response: res })
    })

    await dialog.getByRole('button', { name: '刷新已保存版本' }).click()
    await refreshPickedUpPromise

    const saveBtn = dialog.getByRole('button', { name: '保存服务' })
    const cancelBtn = dialog.getByRole('button', { name: '取消' })
    await expect(saveBtn).toBeDisabled()
    await expect(cancelBtn).toBeDisabled()
    await expect(dialog.locator('.workspace-dialog-body > .stack')).toHaveAttribute('inert', '')

    await saveBtn.click({ force: true })
    await cancelBtn.click({ force: true })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    expect(draftPosts).toBe(0)

    releaseRefresh()
    await expect(saveBtn).toBeEnabled()
    await expect(cancelBtn).toBeEnabled()
    expect(draftPosts).toBe(0)

    await cancelBtn.click()
    await expect(dialog).toBeHidden()

    // Part B: CatalogDialog disables 取消 and marks FieldGroup inert while POST /api/library is in flight
    let libPickedUp!: () => void
    let releaseLib!: () => void
    const libPickedUpPromise = new Promise<void>(r => { libPickedUp = r })
    const releaseLibPromise = new Promise<void>(r => { releaseLib = r })

    await page.route('**/api/library*', async route => {
      if (route.request().method() === 'POST') {
        const res = await route.fetch()
        libPickedUp()
        await releaseLibPromise
        await route.fulfill({ response: res })
        return
      }
      await route.continue()
    })

    await page.getByRole('button', { name: '添加目录条目' }).click()
    const catDialog = page.getByRole('dialog', { name: '添加目录条目' })
    await expect(catDialog).toBeVisible()
    await catDialog.getByLabel('目录名称').fill('AdvCatalog')
    await catDialog.getByLabel('远程规则集地址').fill(providerUrl)
    await catDialog.getByRole('button', { name: '保存目录条目' }).click()
    await libPickedUpPromise

    const catCancel = catDialog.getByRole('button', { name: '取消' })
    await expect(catCancel).toBeDisabled()
    await expect(catDialog.locator('[data-slot="field-group"]').first()).toHaveAttribute('inert', '')
    await catCancel.click({ force: true })
    await page.keyboard.press('Escape')
    await expect(catDialog).toBeVisible()

    releaseLib()
    await expect(catDialog).toBeHidden()
  } finally {
    await app.close()
    await new Promise(resolve => upstream.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I3-03: SettingsPage 删除筛选模板 disables sibling delete buttons mid-flight and prevents lost-update resurrection', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-settings-lib-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const initial = app.workspace.state()
    await app.workspace.library(initial.id, {
      ...initial.library,
      filters: [
        { id: 'filter-probe-01', name: 'Filter-One', filter: defaultFilter },
        { id: 'filter-probe-02', name: 'Filter-Two', filter: defaultFilter },
      ],
    })

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/settings')

    const del1Btn = page.getByRole('button', { name: '删除筛选模板 Filter-One' })
    const del2Btn = page.getByRole('button', { name: '删除筛选模板 Filter-Two' })
    await expect(del1Btn).toBeVisible()
    await expect(del2Btn).toBeVisible()

    let libPosts = 0
    let delPickedUp!: () => void
    let releaseDel!: () => void
    const delPickedUpPromise = new Promise<void>(r => { delPickedUp = r })
    const releaseDelPromise = new Promise<void>(r => { releaseDel = r })

    await page.route('**/api/library*', async route => {
      if (route.request().method() === 'POST') {
        libPosts++
        const res = await route.fetch()
        delPickedUp()
        await releaseDelPromise
        await route.fulfill({ response: res })
        return
      }
      await route.continue()
    })

    await del1Btn.click()
    await page.getByRole('alertdialog').getByRole('button', { name: '删除模板' }).click()
    await delPickedUpPromise

    await expect(del1Btn).toBeDisabled()
    await expect(del2Btn).toBeDisabled()
    await del2Btn.click({ force: true })
    await expect(page.getByRole('alertdialog')).toHaveCount(0)

    releaseDel()
    await expect(del1Btn).toHaveCount(0)
    await expect(del2Btn).toBeEnabled()
    expect(libPosts).toBe(1)
    expect(app.workspace.state().library.filters.map(f => f.id)).toEqual(['filter-probe-02'])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I3-04: ProbeSetupBody disables controls mid-flight and guards parent QualityDialog onClose', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-probe-busy-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    const invite = await (await page.request.post(base + '/api/quality/invite', { data: {} })).json() as DevicePairing
    const [, profileId, ticket] = new URL(invite.pairing).hash.slice(1).split('.')
    const secret = randomBytes(32).toString('base64url')
    const capabilities = { agentVersion: minimumProbeVersion, protocolVersion: probeProtocol, localRegion: 'JP', localIsp: 'ISP', ipStack: 'dual', mihomoVersion: '1.0' }
    expect((await page.request.post(base + '/api/quality/agent/enroll', {
      headers: { Authorization: 'Bearer ' + ticket },
      data: { profileId, name: 'Probe-01', platform: 'linux', secret, capabilities },
    })).ok()).toBe(true)

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{ id: 'src-probe', local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }],
      },
      localNodes: { 'src-probe': [{ name: 'ProbeNode', type: 'http', server: 'probe.invalid', port: 8001 }] },
    })

    await page.goto(base + '/#/nodes')
    await page.getByRole('button', { name: '质量检测', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '节点质量检测' })
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: /管理探针与配对/ }).click()
    const editBtn = dialog.getByRole('button', { name: '编辑备注' })
    const revokeBtn = dialog.getByRole('button', { name: '解除配对' })
    await expect(editBtn).toBeVisible()
    await expect(revokeBtn).toBeVisible()

    // Part A: invite copy in flight disables 编辑备注 & 解除配对
    let invitePickedUp!: () => void
    let releaseInvite!: () => void
    const invitePickedUpPromise = new Promise<void>(r => { invitePickedUp = r })
    const releaseInvitePromise = new Promise<void>(r => { releaseInvite = r })

    await page.route('**/api/quality/invite*', async route => {
      const res = await route.fetch()
      invitePickedUp()
      await releaseInvitePromise
      await route.fulfill({ response: res })
    })

    await dialog.getByRole('button', { name: '复制电脑配对链接' }).click()
    await invitePickedUpPromise
    await expect(editBtn).toBeDisabled()
    await expect(revokeBtn).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()

    releaseInvite()
    await expect(editBtn).toBeEnabled()
    await expect(revokeBtn).toBeEnabled()

    // Part B: rename in flight disables Input & 取消 and blocks QualityDialog onClose
    let renamePickedUp!: () => void
    let releaseRename!: () => void
    const renamePickedUpPromise = new Promise<void>(r => { renamePickedUp = r })
    const releaseRenamePromise = new Promise<void>(r => { releaseRename = r })

    await page.route('**/api/quality/rename*', async route => {
      const res = await route.fetch()
      renamePickedUp()
      await releaseRenamePromise
      await route.fulfill({ response: res })
    })

    await editBtn.click()
    const remarkInput = dialog.getByLabel('探针备注名')
    const renameCancel = dialog.getByRole('button', { name: '取消' })
    await remarkInput.fill('RenamedProbe')
    await dialog.getByRole('button', { name: '保存备注' }).click()
    await renamePickedUpPromise

    await expect(remarkInput).toBeDisabled()
    await expect(renameCancel).toBeDisabled()
    await renameCancel.click({ force: true })
    await page.keyboard.press('Escape')
    await expect(remarkInput).toBeVisible()
    await expect(dialog).toBeVisible()

    releaseRename()
    await expect(dialog.locator('.device-entry').getByText('RenamedProbe')).toBeVisible()
    await expect(editBtn).toBeEnabled()
    await expect(revokeBtn).toBeEnabled()

    // Part C: revoke in flight disables 保留配对 and blocks QualityDialog onClose
    let revokePickedUp!: () => void
    let releaseRevoke!: () => void
    const revokePickedUpPromise = new Promise<void>(r => { revokePickedUp = r })
    const releaseRevokePromise = new Promise<void>(r => { releaseRevoke = r })

    await page.route('**/api/quality/revoke*', async route => {
      const res = await route.fetch()
      revokePickedUp()
      await releaseRevokePromise
      await route.fulfill({ response: res })
    })

    await revokeBtn.click()
    const keepBtn = dialog.getByRole('button', { name: '保留配对' })
    await expect(keepBtn).toBeVisible()
    await dialog.getByRole('button', { name: '确认解除配对' }).click()
    await revokePickedUpPromise

    await expect(keepBtn).toBeDisabled()
    await keepBtn.click({ force: true })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()

    releaseRevoke()
    await expect(dialog.getByText('RenamedProbe')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I4-01: QualityPage manual tabs prevent AlertDialog focus-restoration loop and support ArrowRight + Enter', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-tabs-loop-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    const initialSched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'GET' && r.ok())
    await page.goto(base + '/#/quality/schedules')
    await initialSched

    const basicSwitch = page.getByRole('switch', { name: '启用常规质量检测' })
    const schedulesTab = page.getByRole('tab', { name: '定时任务' })
    const reportsTab = page.getByRole('tab', { name: '检测报告' })
    await expect(basicSwitch).not.toBeChecked()
    await basicSwitch.click()
    await expect(basicSwitch).toBeChecked()

    const undoBtn = page.getByRole('button', { name: '撤销更改' })
    await expect(undoBtn).toBeVisible()

    // 1. Click 检测报告 while dirty -> AlertDialog opens -> click 取消 -> must close and stay closed
    await reportsTab.click()
    const alertDialog = page.getByRole('alertdialog')
    await expect(alertDialog).toBeVisible()
    await expect(alertDialog).toContainText('放弃本次修改？')
    await alertDialog.getByRole('button', { name: '取消' }).click()
    await expect(alertDialog).toHaveCount(0)
    await page.waitForTimeout(150)
    await expect(alertDialog).toHaveCount(0)
    await expect(page).toHaveURL(/#\/quality\/schedules$/)
    await expect(schedulesTab).toHaveAttribute('aria-selected', 'true')

    // 2. Click 检测报告 while dirty -> AlertDialog opens -> press Escape -> must close and stay closed
    await reportsTab.click()
    await expect(alertDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(alertDialog).toHaveCount(0)
    await page.waitForTimeout(150)
    await expect(alertDialog).toHaveCount(0)
    await expect(page).toHaveURL(/#\/quality\/schedules$/)

    // 3. Page is not trapped under an overlay: 撤销更改 is clickable and clears dirty state
    await undoBtn.click()
    await expect(undoBtn).toHaveCount(0)
    await expect(basicSwitch).not.toBeChecked()

    // 4. Manual tab activation: ArrowRight moves focus without switching; Enter activates tab
    await schedulesTab.focus()
    await expect(schedulesTab).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(reportsTab).toBeFocused()
    await expect(schedulesTab).toHaveAttribute('aria-selected', 'true')
    await expect(reportsTab).toHaveAttribute('aria-selected', 'false')
    await page.keyboard.press('Enter')
    await expect(reportsTab).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/#\/quality\/reports$/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I4-02: late-resolving POST /api/draft from Profile A does not hijack active Profile B workspace', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-cross-profile-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        groups: [{
          id: 'grp-adv-copy', name: 'AdvCopyGroup', type: 'select', enabled: true,
          members: [{ kind: 'builtin', id: 'DIRECT' }],
          testUrl: '', seconds: 300, tolerance: 50, strategy: 'consistent-hashing', lazy: true, disableUdp: false,
        }],
      },
    })
    const profileB = await app.workspace.profiles(initial.id, { action: 'create', title: 'ProfileB' })

    await page.addInitScript(id => {
      if (!localStorage.getItem('submeld.profile')) localStorage.setItem('submeld.profile', id)
    }, initial.id)
    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/groups/grp-adv-copy')

    const selector = page.locator('#profile-selector')
    await expect(selector).toContainText(initial.title)

    let draftPickedUp!: () => void
    let releaseDraft!: () => void
    const draftPickedUpPromise = new Promise<void>(r => { draftPickedUp = r })
    const releaseDraftPromise = new Promise<void>(r => { releaseDraft = r })

    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') {
        const res = await route.fetch()
        draftPickedUp()
        await releaseDraftPromise
        await route.fulfill({ response: res })
        return
      }
      await route.continue()
    })

    // Start GroupEditor 复制 on Profile A and hold POST /api/draft in flight
    const draftResponsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/draft' && r.request().method() === 'POST' && r.ok())
    await page.getByRole('button', { name: '复制' }).click()
    await draftPickedUpPromise

    // Switch via ProfileSelector to ProfileB while Profile A's mutation is still in flight
    await selector.click()
    await page.getByRole('menuitemradio', { name: 'ProfileB' }).click()
    await expect(selector).toContainText('ProfileB')
    await expect(page).toHaveURL(/#\/home$/)
    expect(await page.evaluate(() => localStorage.getItem('submeld.profile'))).toBe(profileB.id)

    // Release Profile A's delayed POST /api/draft response and wait deterministically for fulfillment + render settle
    releaseDraft()
    await draftResponsePromise
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

    // ProfileSelector, localStorage, hash, and active workspace state must remain on Profile B
    await expect(selector).toContainText('ProfileB')
    await expect(selector).not.toContainText(initial.title)
    expect(await page.evaluate(() => localStorage.getItem('submeld.profile'))).toBe(profileB.id)
    await expect(page).toHaveURL(/#\/home$/)
    await expect(page.locator('.bar-summary')).toContainText('0 节点 · 0 组 · 0 规则')

    // Profile A's mutation still succeeded on the server without corrupting Profile B
    expect(app.workspace.state(initial.id).draft.groups.length).toBe(2)
    expect(app.workspace.state(profileB.id).draft.groups.length).toBe(0)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I4-02b: 409 Conflict foreground reload on Profile A during in-flight switch to Profile B does not cancel switch or falsely toast Profile A', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-switch-409-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        groups: [{
          id: 'grp-adv-409', name: 'Adv409Group', type: 'select', enabled: true,
          members: [{ kind: 'builtin', id: 'DIRECT' }],
          testUrl: '', seconds: 300, tolerance: 50, strategy: 'consistent-hashing', lazy: true, disableUdp: false,
        }],
      },
    })
    const profileB = await app.workspace.profiles(initial.id, { action: 'create', title: 'ProfileB' })

    await page.addInitScript(id => {
      if (!localStorage.getItem('submeld.profile')) localStorage.setItem('submeld.profile', id)
    }, initial.id)
    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    await page.goto(base + '/#/groups/grp-adv-409')

    const selector = page.locator('#profile-selector')
    await expect(selector).toContainText(initial.title)

    let draftPickedUp!: () => void
    let releaseDraft!: () => void
    const draftPickedUpPromise = new Promise<void>(r => { draftPickedUp = r })
    const releaseDraftPromise = new Promise<void>(r => { releaseDraft = r })

    let switchPickedUp!: () => void
    let releaseSwitch!: () => void
    const switchPickedUpPromise = new Promise<void>(r => { switchPickedUp = r })
    const releaseSwitchPromise = new Promise<void>(r => { releaseSwitch = r })

    let profileAReloadsDuringSwitch = 0
    let switchInFlightFlag = false

    await page.route('**/api/draft*', async route => {
      if (route.request().method() === 'POST') {
        draftPickedUp()
        await releaseDraftPromise
        const res = await route.fetch()
        await route.fulfill({ response: res })
        return
      }
      await route.continue()
    })

    await page.route('**/api/status*', async route => {
      const url = new URL(route.request().url())
      if (switchInFlightFlag && url.searchParams.get('profile') === initial.id) {
        profileAReloadsDuringSwitch++
      }
      await route.continue()
    })

    await page.route('**/api/state*', async route => {
      const url = new URL(route.request().url())
      const targetProfile = url.searchParams.get('profile')
      if (targetProfile === profileB.id) {
        switchInFlightFlag = true
        const res = await route.fetch()
        switchPickedUp()
        await releaseSwitchPromise
        await route.fulfill({ response: res })
        switchInFlightFlag = false
        return
      }
      if (switchInFlightFlag && targetProfile === initial.id) {
        profileAReloadsDuringSwitch++
      }
      await route.continue()
    })

    // Start GroupEditor 复制 on Profile A and hold POST /api/draft before hitting server
    await page.getByRole('button', { name: '复制' }).click()
    await draftPickedUpPromise

    // Advance Profile A's revision on the server so the held POST /api/draft receives a real 409 Conflict
    const latestA = app.workspace.state(initial.id)
    await app.workspace.saveDraft(initial.id, 'bump-revision', {
      revision: latestA.revision,
      draft: {
        ...latestA.draft,
        groups: latestA.draft.groups.map(g => ({ ...g, name: 'Adv409GroupServerEdited' })),
      },
    })

    // Start switching to ProfileB and hold GET /api/state?profile=B in flight (switchInFlight.current === 1)
    const switchResponsePromise = page.waitForResponse(r => {
      const url = new URL(r.url())
      return url.pathname === '/api/state' && url.searchParams.get('profile') === profileB.id && r.ok()
    })
    await selector.click()
    await page.getByRole('menuitemradio', { name: 'ProfileB' }).click()
    await switchPickedUpPromise

    // Release Profile A's POST /api/draft -> real 409 Conflict -> triggers save()'s reload(targetProfile) while switch is in flight
    const draft409Promise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/draft' && r.request().method() === 'POST' && r.status() === 409)
    releaseDraft()
    await draft409Promise
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

    // Now release ProfileB's GET /api/state response
    releaseSwitch()
    await switchResponsePromise
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

    // Switch must complete cleanly to ProfileB, never cancelled by Profile A's 409 reload, and toast must announce ProfileB
    expect(profileAReloadsDuringSwitch).toBe(0)
    await expect(selector).toContainText('ProfileB')
    await expect(selector).not.toContainText(initial.title)
    expect(await page.evaluate(() => localStorage.getItem('submeld.profile'))).toBe(profileB.id)
    await expect(page).toHaveURL(/#\/home$/)
    await expect(page.locator('.bar-summary')).toContainText('0 节点 · 0 组 · 0 规则')
    await expect(page.getByText('已切换至「ProfileB」')).toBeVisible()
    await expect(page.getByText('已切换至「' + initial.title + '」')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I5-01: QualitySchedulePanel withholds editable form while initial GET is loading or failed, and recovers cleanly on 重试', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-sched-load-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  let expectSimulated500 = false
  page.on('pageerror', err => pageErrors.push(err.message))
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (expectSimulated500 && text.includes('500')) return
      consoleErrors.push(text)
    }
  })

  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })

    const seededSchedule = {
      ...defaultQualityScheduleConfig,
      scope: 'all' as const,
      autoRefreshGroups: false,
      basic: { ...defaultQualityScheduleConfig.basic, enabled: true, intervalMinutes: 720 },
      ai: { ...defaultQualityScheduleConfig.ai, enabled: true, intervalMinutes: 4320 },
    }
    expect((await page.request.post(base + '/api/quality/schedule', { data: seededSchedule })).ok()).toBe(true)

    // Part 1: Slow in-flight initial GET /api/quality/schedule
    let schedPickedUp!: () => void
    let releaseSched!: () => void
    const schedPickedUpPromise = new Promise<void>(r => { schedPickedUp = r })
    const releaseSchedPromise = new Promise<void>(r => { releaseSched = r })

    await page.route('**/api/quality/schedule*', async route => {
      if (route.request().method() === 'GET') {
        const response = await route.fetch()
        schedPickedUp()
        await releaseSchedPromise
        await route.fulfill({ response })
        return
      }
      await route.continue()
    })

    await page.goto(base + '/#/quality/schedules')
    await schedPickedUpPromise

    await expect(page.getByRole('status').filter({ hasText: '正在读取定时检测配置…' })).toBeVisible()
    await expect(page.getByRole('switch', { name: '启用常规质量检测' })).toHaveCount(0)
    await expect(page.getByRole('switch', { name: '启用 AI 解锁检测' })).toHaveCount(0)
    await expect(page.getByRole('spinbutton', { name: '常规检测周期（分钟）' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存定时配置' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '立即执行常规检测' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '立即执行 AI 检测' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '执行到期任务' })).toHaveCount(0)
    await expect(page.getByLabel('执行探针')).toHaveCount(0)

    releaseSched()

    const basicSwitch = page.getByRole('switch', { name: '启用常规质量检测' })
    const aiSwitch = page.getByRole('switch', { name: '启用 AI 解锁检测' })
    const basicIntervalInput = page.getByRole('spinbutton', { name: '常规检测周期（分钟）' })
    await expect(basicSwitch).toBeVisible()
    await expect(page.getByText('正在读取定时检测配置…')).toHaveCount(0)
    await expect(basicSwitch).toBeChecked()
    await expect(aiSwitch).toBeChecked()
    await expect(basicIntervalInput).toHaveValue('720')
    await expect(page.getByLabel('检测范围')).toHaveValue('all')
    await expect(page.getByRole('switch', { name: '检测完成后自动联动更新动态代理组' })).not.toBeChecked()
    await expect(page.getByRole('button', { name: '保存定时配置' })).toBeDisabled()

    await page.unroute('**/api/quality/schedule*')

    // Part 2: Initial GET /api/quality/schedule returns HTTP 500 -> loadError + 重试 -> recovers cleanly
    let getCount = 0
    let retryPickedUp!: () => void
    let releaseRetry!: () => void
    const retryPickedUpPromise = new Promise<void>(r => { retryPickedUp = r })
    const releaseRetryPromise = new Promise<void>(r => { releaseRetry = r })

    await page.route('**/api/quality/schedule*', async route => {
      if (route.request().method() === 'GET') {
        getCount++
        if (getCount === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: '模拟定时配置读取失败' }),
          })
          return
        }
        const response = await route.fetch()
        retryPickedUp()
        await releaseRetryPromise
        await route.fulfill({ response })
        return
      }
      await route.continue()
    })

    expectSimulated500 = true
    await page.reload()

    const retryBtn = page.getByRole('button', { name: '重试' })
    await expect(page.getByRole('alert').filter({ hasText: '模拟定时配置读取失败' })).toBeVisible()
    await expect(retryBtn).toBeVisible()
    await expect(retryBtn).toBeEnabled()
    await expect(page.getByRole('switch', { name: '启用常规质量检测' })).toHaveCount(0)
    await expect(page.getByRole('spinbutton', { name: '常规检测周期（分钟）' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存定时配置' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '立即执行常规检测' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '立即执行 AI 检测' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '执行到期任务' })).toHaveCount(0)

    expectSimulated500 = false
    await retryBtn.click()
    await retryPickedUpPromise

    await expect(page.getByRole('status').filter({ hasText: '正在读取定时检测配置…' })).toBeVisible()
    await expect(retryBtn).toHaveCount(0)
    await expect(page.getByRole('switch', { name: '启用常规质量检测' })).toHaveCount(0)

    releaseRetry()

    await expect(basicSwitch).toBeVisible()
    await expect(page.getByText('正在读取定时检测配置…')).toHaveCount(0)
    await expect(page.getByText('模拟定时配置读取失败')).toHaveCount(0)
    await expect(basicSwitch).toBeChecked()
    await expect(aiSwitch).toBeChecked()
    await expect(basicIntervalInput).toHaveValue('720')

    // Verify form edits and save work normally after recovery
    await basicIntervalInput.fill('360')
    await aiSwitch.click()
    await expect(aiSwitch).not.toBeChecked()

    const savePost = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'POST' && r.ok())
    await page.locator('.settings-save-bar').getByRole('button', { name: '保存定时配置' }).click()
    await savePost

    await expect(page.locator('[data-sonner-toast]')).toContainText('定时检测配置已保存')
    await expect(page.locator('.settings-save-bar')).toHaveCount(0)
    const persisted = await (await page.request.get(base + '/api/quality/schedule')).json() as typeof seededSchedule
    expect(persisted.basic.intervalMinutes).toBe(360)
    expect(persisted.ai.enabled).toBe(false)
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I6-01: QualitySchedulePanel ignores late-resolving save() and runNow() after profile switch', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-sched-switch-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', err => pageErrors.push(err.message))
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    const invite = await (await page.request.post(base + '/api/quality/invite', { data: {} })).json() as DevicePairing
    const [, profileId, ticket] = new URL(invite.pairing).hash.slice(1).split('.')
    const secret = randomBytes(32).toString('base64url')
    const capabilities = { agentVersion: minimumProbeVersion, protocolVersion: probeProtocol, localRegion: 'JP', localIsp: 'ISP', ipStack: 'dual', mihomoVersion: '1.0' }
    expect((await page.request.post(base + '/api/quality/agent/enroll', {
      headers: { Authorization: 'Bearer ' + ticket },
      data: { profileId, name: 'Switch Probe', platform: 'linux', secret, capabilities },
    })).ok()).toBe(true)
    const deviceId = ((await (await page.request.get(base + '/api/quality/devices')).json()) as Array<{ id: string }>)[0].id

    const initial = app.workspace.state()
    await app.workspace.saveDraft(initial.id, 'fixture', {
      revision: initial.revision,
      draft: {
        ...initial.draft,
        sources: [{ id: 'src-switch', local: true, name: 'Local', tag: '', url: '', enabled: true, paused: false, minutes: 60, filter: defaultFilter }],
      },
      localNodes: { 'src-switch': [{ name: 'SwitchNode', type: 'http', server: 'switch.invalid', port: 8001 }] },
    })
    expect((await page.request.post(base + '/api/quality/schedule', {
      data: {
        ...defaultQualityScheduleConfig,
        targetDeviceId: deviceId,
        basic: { ...defaultQualityScheduleConfig.basic, enabled: true, intervalMinutes: 720 },
      },
    })).ok()).toBe(true)
    await app.workspace.profiles(initial.id, { action: 'create', title: 'ProfileB' })

    await page.addInitScript(id => {
      if (!localStorage.getItem('submeld.profile')) localStorage.setItem('submeld.profile', id)
    }, initial.id)

    const initialSched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'GET' && r.ok())
    await page.goto(base + '/#/quality/schedules')
    await initialSched

    const selector = page.locator('#profile-selector')
    await expect(selector).toContainText(initial.title)

    // Part A: Hold POST /api/quality/schedule (save()) on Profile A, switch to Profile B (放弃修改), release POST
    let savePickedUp!: () => void
    let releaseSave!: () => void
    const savePickedUpPromise = new Promise<void>(r => { savePickedUp = r })
    const releaseSavePromise = new Promise<void>(r => { releaseSave = r })

    await page.route('**/api/quality/schedule*', async route => {
      if (new URL(route.request().url()).pathname === '/api/quality/schedule' && route.request().method() === 'POST') {
        const response = await route.fetch()
        savePickedUp()
        await releaseSavePromise
        await route.fulfill({ response })
        return
      }
      await route.continue()
    })

    await page.getByRole('switch', { name: '启用 AI 解锁检测' }).click()
    const saveResponsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'POST' && r.ok())
    await page.locator('.settings-save-bar').getByRole('button', { name: '保存定时配置' }).click()
    await savePickedUpPromise

    await selector.click()
    await page.getByRole('menuitemradio', { name: 'ProfileB' }).click()
    const confirmLeave = page.getByRole('alertdialog')
    await expect(confirmLeave).toBeVisible()
    await confirmLeave.getByRole('button', { name: '放弃修改' }).click()
    await expect(selector).toContainText('ProfileB')
    await expect(page.locator('[data-sonner-toast][data-visible="true"]')).toContainText('已切换至「ProfileB」')

    releaseSave()
    await saveResponsePromise
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.locator('[data-sonner-toast][data-visible="true"]')).toContainText('已切换至「ProfileB」')
    await expect(page.getByText('定时检测配置已保存')).toHaveCount(0)
    await page.unroute('**/api/quality/schedule*')

    // Part B: Switch back to Profile A, hold POST /api/quality/schedule/run (立即执行常规检测), switch to Profile B, release POST
    await selector.click()
    await page.getByRole('menuitemradio', { name: initial.title }).click()
    await expect(selector).toContainText(initial.title)

    const backSched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'GET' && r.ok())
    await page.locator('nav[aria-label="主导航"]').getByRole('link', { name: '质量检测' }).click()
    await backSched

    const runBasicBtn = page.getByRole('button', { name: '立即执行常规检测' })
    await expect(runBasicBtn).toBeEnabled()

    let runPickedUp!: () => void
    let releaseRun!: () => void
    const runPickedUpPromise = new Promise<void>(r => { runPickedUp = r })
    const releaseRunPromise = new Promise<void>(r => { releaseRun = r })

    await page.route('**/api/quality/schedule/run*', async route => {
      if (new URL(route.request().url()).pathname === '/api/quality/schedule/run' && route.request().method() === 'POST') {
        const response = await route.fetch()
        runPickedUp()
        await releaseRunPromise
        await route.fulfill({ response })
        return
      }
      await route.continue()
    })

    const runResponsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule/run' && r.request().method() === 'POST' && r.ok())
    await runBasicBtn.click()
    await runPickedUpPromise

    await selector.click()
    await page.getByRole('menuitemradio', { name: 'ProfileB' }).click()
    await expect(selector).toContainText('ProfileB')
    await expect(page.locator('[data-sonner-toast][data-visible="true"]')).toContainText('已切换至「ProfileB」')

    releaseRun()
    await runResponsePromise
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.locator('[data-sonner-toast][data-visible="true"]')).toContainText('已切换至「ProfileB」')
    await expect(page.getByText(/已创建.*定时检测任务|本次未调度任务/)).toHaveCount(0)

    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('FE-I6-02: QualitySchedulePanel renders saveError inside .settings-save-bar without blocking toast overlap on desktop or mobile', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-adv-sched-err-'))
  const app = createApplication({ directory: dir, tickMs: 0, password: PASSWORD, verify: async () => null })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  let expectSimulated500 = false
  page.on('pageerror', err => pageErrors.push(err.message))
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (expectSimulated500 && text.includes('500')) return
      consoleErrors.push(text)
    }
  })

  try {
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port

    await page.request.post(base + '/api/login', { data: { password: PASSWORD } })
    const initialSched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'GET' && r.ok())
    await page.goto(base + '/#/quality/schedules')
    await initialSched

    const basicSwitch = page.getByRole('switch', { name: '启用常规质量检测' })
    const basicIntervalInput = page.getByRole('spinbutton', { name: '常规检测周期（分钟）' })
    const saveBar = page.locator('.settings-save-bar')
    await expect(basicSwitch).not.toBeChecked()
    await expect(basicIntervalInput).toHaveValue('1440')

    // 1. Desktop (1440x940): HTTP 500 -> inline alert inside .settings-save-bar, zero toast overlap, immediate 撤销更改 click succeeds
    await page.setViewportSize({ width: 1440, height: 940 })
    await basicSwitch.click()
    await basicIntervalInput.fill('360')
    await expect(saveBar).toBeVisible()

    let failNextSaveWith: string | null = '模拟定时配置保存失败'
    await page.route('**/api/quality/schedule*', async route => {
      if (failNextSaveWith && new URL(route.request().url()).pathname === '/api/quality/schedule' && route.request().method() === 'POST') {
        const message = failNextSaveWith
        failNextSaveWith = null
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message }),
        })
        return
      }
      await route.continue()
    })

    expectSimulated500 = true
    const err500Desktop = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'POST' && r.status() === 500)
    await saveBar.getByRole('button', { name: '保存定时配置' }).click()
    await err500Desktop
    expectSimulated500 = false

    await expect(saveBar.getByRole('alert')).toContainText('模拟定时配置保存失败')
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)

    await saveBar.getByRole('button', { name: '撤销更改' }).click()
    await expect(saveBar).toHaveCount(0)
    await expect(basicSwitch).not.toBeChecked()
    await expect(basicIntervalInput).toHaveValue('1440')

    // 2. Mobile (390x844): inline alert inside .settings-save-bar has zero horizontal overflow and allows immediate retry after 500
    await page.setViewportSize({ width: 390, height: 844 })
    await basicIntervalInput.fill('720')
    await expect(saveBar).toBeVisible()

    failNextSaveWith = '模拟移动端保存失败'
    expectSimulated500 = true
    const err500Mobile = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'POST' && r.status() === 500)
    await saveBar.getByRole('button', { name: '保存定时配置' }).click()
    await err500Mobile
    expectSimulated500 = false

    await expect(saveBar.getByRole('alert')).toContainText('模拟移动端保存失败')
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    const retrySave = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/schedule' && r.request().method() === 'POST' && r.ok())
    await saveBar.getByRole('button', { name: '保存定时配置' }).click()
    await retrySave
    await expect(saveBar).toHaveCount(0)
    await expect(page.locator('[data-sonner-toast]')).toContainText('定时检测配置已保存')
    await expect(basicIntervalInput).toHaveValue('720')

    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
