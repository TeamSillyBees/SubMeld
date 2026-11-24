import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import {
  aiOnlyConfig,
  assertYamlGroupExactOrder,
  basicAndBandwidthConfig,
  basicOnlyConfig,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildSource,
  parseMihomoYaml,
} from '../helpers/fixtures.ts'
import {
  aiPresets,
  aiReading,
  createMockProbe,
  parseInviteLink,
  type AutoResponderHandle,
} from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  attachErrorCollectors,
  closeModal,
  expectQuickChipActive,
  getRuleFilterSection,
  openAdvancedQualityModal,
  openGroupsPage,
  toggleQuickQualityChip,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface SourceNodesPayload {
  good: {
    nodes: Array<{ id: string; name: string }>
  } | null
}

interface WorkspaceStatePayload {
  id: string
  revision: number
  token: string | null
  draft: {
    sources: Array<Record<string, unknown>>
    groups: Array<Record<string, unknown>>
    services: unknown[]
    rules: unknown[]
    base: Record<string, unknown>
  }
}

test.describe('T3-P10 Modular Probe x Latest Store x Inline Quality Filter & Modal (F3, F4, F9)', () => {
  test('T3-P10-01 (F3,F9) (F4,F9): sequential basic-only and ai-only incremental merge drives inline AND quick-filter chips in GroupFilter', async ({ page }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        feed: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
            buildProxyNode('🇸🇬 SG-SIN-01', { server: 'sg-sin-01.example.net', port: 10003 }),
            buildProxyNode('🇭🇰 HK-HKG-01', { server: 'hk-hkg-01.example.net', port: 10004 }),
          ],
        },
      })
      harness = await startAppHarness()

      const initState = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const profileId = initState.data.id
      const source = buildSource({ name: 'Chip Feed', url: subServer.urlFor('feed') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })).status, 200)

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Filter-Probe' })
      assert.equal((await probe.enroll(parseInviteLink(inviteRes.data.pairing).ticket)).status, 200)
      const deviceId = (await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')).data[0].id

      const group = buildProxyGroup({
        name: 'Modular-Chip-Group',
        qualityDeviceId: deviceId,
        members: [buildPoolMember({ sourceIds: [source.id] })],
      })
      const saveDraftRes = await harness.apiPost<WorkspaceStatePayload>('/api/draft', {
        revision: initState.data.revision,
        draft: { ...initState.data.draft, sources: [source], groups: [group] },
      })
      assert.equal(saveDraftRes.status, 200)

      const nodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
      const nodes = nodesRes.data.good?.nodes ?? []
      const keyOf = (needle: string) => `${source.id}/${nodes.find(n => n.name.includes(needle))!.id}`
      const usKey = keyOf('US-LAX-01')
      const jpKey = keyOf('JP-TYO-01')
      const sgKey = keyOf('SG-SIN-01')
      const hkKey = keyOf('HK-HKG-01')

      // Run 1: basicOnlyConfig() differentiates latency & loss
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceId,
          keys: [usKey, jpKey, sgKey, hkKey],
          config: basicOnlyConfig(),
        })).status,
        200,
      )
      assert.equal(
        (await probe.pollAndComplete(node => {
          if (node.key === usKey) return { latencyMs: 45, lossRate: 0, exit: { ip: '198.51.100.1', region: 'US' } }
          if (node.key === jpKey) return { latencyMs: 450, lossRate: 0, exit: { ip: '198.51.100.2', region: 'JP' } }
          if (node.key === sgKey) return { latencyMs: 60, lossRate: 0.2, exit: { ip: '198.51.100.3', region: 'SG' } }
          return { latencyMs: 35, lossRate: 0, exit: { ip: '198.51.100.4', region: 'HK' } }
        })).completeResponse?.status,
        200,
      )

      // Run 2: aiOnlyConfig() differentiates AI unlock while preserving basic latency/loss in quality-latest
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceId,
          keys: [usKey, jpKey, sgKey, hkKey],
          config: aiOnlyConfig(),
        })).status,
        200,
      )
      assert.equal(
        (await probe.pollAndComplete(node => {
          if (node.key === usKey) return { exit: { ip: '198.51.100.1', region: 'US' }, ai: aiPresets.allGreen('US') }
          if (node.key === jpKey) return { exit: { ip: '198.51.100.2', region: 'JP' }, ai: aiPresets.allGreen('JP') }
          if (node.key === sgKey) return { exit: { ip: '198.51.100.3', region: 'SG' }, ai: aiPresets.allGreen('SG') }
          return { exit: null, ai: aiPresets.allRestricted('HK') }
        })).completeResponse?.status,
        200,
      )

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      const rule = getRuleFilterSection(page)
      await expect(rule.getByRole('status')).toContainText('匹配 4 个保留节点')

      // (F3, F9) & (F4, F9) AND quick chips cumulatively narrow merged latest records
      await toggleQuickQualityChip(rule, /全\s*AI\s*解锁/)
      await expectQuickChipActive(rule, /全\s*AI\s*解锁/, true)
      await expect(rule.getByRole('status')).toContainText('匹配 3 个保留节点')

      await toggleQuickQualityChip(rule, /低延迟/)
      await expectQuickChipActive(rule, /低延迟/, true)
      await expect(rule.getByRole('status')).toContainText('匹配 2 个保留节点')

      await toggleQuickQualityChip(rule, /低丢包率/)
      await expectQuickChipActive(rule, /低丢包率/, true)
      await expect(rule.getByRole('status')).toContainText('匹配 1 个保留节点')
      await expect(rule.locator('.pool-sample')).toContainText('US-LAX-01')

      await page.getByRole('button', { name: '保存代理组' }).click()
      await expect.poll(async () => {
        const st = await harness!.apiGet<WorkspaceStatePayload>('/api/state')
        const grp = st.data.draft.groups.find(g => g.id === group.id) as {
          members?: Array<{ quality?: { aiAll?: boolean } }>
        } | undefined
        return grp?.members?.[0]?.quality?.aiAll === true
      }).toBe(true)

      const afterSave = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const pubRes = await harness.apiPost<WorkspaceStatePayload>('/api/publish', { revision: afterSave.data.revision })
      assert.equal(pubRes.status, 200)
      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.equal(linkRes.status, 200)
      assert.ok(linkRes.data.url)

      const yamlObj = parseMihomoYaml((await harness.subGet(linkRes.data.url)).text)
      assertYamlGroupExactOrder(yamlObj, 'Modular-Chip-Group', ['🇺🇸 US-LAX-01'])

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })

  test('T3-P10-02 (F3,F9) (F4,F9): basic+bandwidth merged with ai-only satisfies advanced quality modal thresholds and surface selection', async ({ page }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined
    let responder: AutoResponderHandle | undefined

    try {
      subServer = await startMockSubServer({
        feed: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-LAX-01', { server: 'us-lax-01.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-TYO-01', { server: 'jp-tyo-01.example.net', port: 10002 }),
          ],
        },
      })
      harness = await startAppHarness()

      const initState = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const profileId = initState.data.id
      const source = buildSource({ name: 'Modal Feed', url: subServer.urlFor('feed') })
      assert.equal((await harness.apiPost('/api/probe', { kind: 'source', id: source.id, url: source.url })).status, 200)

      const inviteRes = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const probe = createMockProbe({ origin: harness.baseUrl, profileId, name: 'Modal-Probe' })
      assert.equal((await probe.enroll(parseInviteLink(inviteRes.data.pairing).ticket)).status, 200)
      const deviceId = (await harness.apiGet<Array<{ id: string; name: string }>>('/api/quality/devices')).data[0].id

      const group = buildProxyGroup({
        name: 'Modular-Modal-Group',
        qualityDeviceId: deviceId,
        members: [buildPoolMember({ sourceIds: [source.id] })],
      })
      assert.equal(
        (await harness.apiPost('/api/draft', {
          revision: initState.data.revision,
          draft: { ...initState.data.draft, sources: [source], groups: [group] },
        })).status,
        200,
      )

      const nodesRes = await harness.apiGet<SourceNodesPayload>(`/api/source-nodes?id=${encodeURIComponent(source.id)}`)
      const nodes = nodesRes.data.good?.nodes ?? []
      const usKey = `${source.id}/${nodes.find(n => n.name.includes('US-LAX-01'))!.id}`
      const jpKey = `${source.id}/${nodes.find(n => n.name.includes('JP-TYO-01'))!.id}`

      // Run 1: basic+bandwidth (US fast 150 Mbps, JP slow 15 Mbps)
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceId,
          keys: [usKey, jpKey],
          config: basicAndBandwidthConfig(),
        })).status,
        200,
      )
      assert.equal(
        (await probe.pollAndComplete(node => {
          if (node.key === usKey) return { latencyMs: 50, speedMbps: 150, exit: { ip: '198.51.100.1', region: 'US' } }
          return { latencyMs: 50, speedMbps: 15, exit: { ip: '198.51.100.2', region: 'JP' } }
        })).completeResponse?.status,
        200,
      )

      // Run 2: ai-only (US unlocks ChatGPT Web & APP; JP unlocks all 3)
      assert.equal(
        (await harness.apiPost('/api/quality/queue', {
          targetDeviceId: deviceId,
          keys: [usKey, jpKey],
          config: aiOnlyConfig(),
        })).status,
        200,
      )
      assert.equal(
        (await probe.pollAndComplete(node => {
          if (node.key === usKey) {
            return {
              exit: { ip: '198.51.100.1', region: 'US' },
              ai: {
                chatgptWeb: aiReading.green('US', 'chatgptWeb'),
                chatgptApp: aiReading.green('US', 'chatgptApp'),
                gemini: aiReading.restricted('region_restricted', 'HK'),
              },
            }
          }
          return { exit: { ip: '198.51.100.2', region: 'JP' }, ai: aiPresets.allGreen('JP') }
        })).completeResponse?.status,
        200,
      )

      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openGroupsPage(page, harness.baseUrl, group.id)

      const rule = getRuleFilterSection(page)
      const modal = await openAdvancedQualityModal(page, rule)

      // Set minimum bandwidth to 50 Mbps and require ChatGPT Web + ChatGPT APP
      await modal.getByLabel(/最低带宽/).first().fill('50')
      for (const surfaceRe of [/ChatGPT\s*Web/i, /ChatGPT\s*APP/i]) {
        const control = modal
          .getByRole('checkbox', { name: surfaceRe })
          .or(modal.getByRole('button', { name: surfaceRe }))
          .or(modal.getByRole('switch', { name: surfaceRe }))
          .first()
        await expect(control).toBeVisible()
        await control.click()
      }

      const applyBtn = modal.getByRole('button', { name: /^(?:应用|确定|保存)$/ }).first()
      if ((await applyBtn.count()) > 0 && (await applyBtn.isVisible())) {
        await applyBtn.click()
        await expect(modal).toBeHidden()
      } else {
        await closeModal(modal)
      }

      // Only US-LAX-01 satisfies both speed >= 50 Mbps (from basic+bandwidth) and ChatGPT Web+APP (from ai-only)
      await expect(rule.getByRole('status')).toContainText('匹配 1 个保留节点')
      await expect(rule.locator('.pool-sample')).toContainText('US-LAX-01')
      await expect(rule.locator('.pool-sample')).not.toContainText('JP-TYO-01')

      await page.getByRole('button', { name: '保存代理组' }).click()
      await expect.poll(async () => {
        const st = await harness!.apiGet<WorkspaceStatePayload>('/api/state')
        const grp = st.data.draft.groups.find(g => g.id === group.id) as {
          members?: Array<{ quality?: { minBandwidthMbps?: number; aiSurfaces?: string[] } }>
        } | undefined
        const q = grp?.members?.[0]?.quality
        return q?.minBandwidthMbps === 50 && q?.aiSurfaces?.includes('chatgptWeb') && q?.aiSurfaces?.includes('chatgptApp')
      }).toBe(true)

      const afterSave = await harness.apiGet<WorkspaceStatePayload>('/api/state')
      const pubRes = await harness.apiPost<WorkspaceStatePayload>('/api/publish', { revision: afterSave.data.revision })
      assert.equal(pubRes.status, 200)
      const linkRes = await harness.apiGet<{ url: string | null }>('/api/link')
      assert.equal(linkRes.status, 200)
      assert.ok(linkRes.data.url)
      const yamlObj = parseMihomoYaml((await harness.subGet(linkRes.data.url)).text)
      assertYamlGroupExactOrder(yamlObj, 'Modular-Modal-Group', ['🇺🇸 US-LAX-01'])

      errors.assertNoErrors()
    } finally {
      await responder?.stop()
      await harness?.close()
      await subServer?.close()
    }
  })
})
