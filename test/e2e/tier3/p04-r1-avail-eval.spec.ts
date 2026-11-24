import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import { startAppHarness, type AppHarness } from '../helpers/app-harness.ts'
import { aiPresets, aiReading, buildAiResults, createMockProbe, parseInviteLink, type QualityNode } from '../helpers/mock-probe.ts'
import { startMockSubServer, type MockSubServer } from '../helpers/mock-sub-server.ts'
import {
  assertAvailabilityStats,
  assertNoLegacyAiStrings,
  assertThreeSurfaceAi,
  assertYamlGroupExactOrder,
  basicAndAiConfig,
  buildDraft,
  buildPoolMember,
  buildProxyGroup,
  buildProxyNode,
  buildQualityCondition,
  buildSource,
  getYamlGroupProxies,
  parseMihomoYaml,
  uniqueId,
  unwrapLatestForDevice,
  type LatestNodeQuality,
} from '../helpers/fixtures.ts'
import {
  attachErrorCollectors,
  expectNoLegacyAiPlatforms,
  expectNoReportBaselinePicker,
  openGroupsPage,
  openNodesPage,
  openPublishPage,
  unlockOrSetupAuth,
} from '../helpers/ui-helpers.ts'

interface StateResponse {
  revision: number
  draft: ReturnType<typeof buildDraft>
}

interface SourceNodesResponse {
  good: {
    nodes: Array<{ id: string; name: string }>
  } | null
}

interface QualityDeviceSummary {
  id: string
  name: string
}

interface LinkResponse {
  url: string | null
  active: boolean
  revoked: boolean
}

test.describe('T3-P04 R1 3-Surface AI, Multi-Check Availability & Single-Probe Group Evaluation (F1, F5, F6)', () => {
  test('T3-P04-01 (F1,F5,F6): group evaluation reads per-probe latest store for 3-surface AI & multi-check availability without report pinning', async ({
    page,
  }) => {
    const errors = attachErrorCollectors(page)
    let subServer: MockSubServer | undefined
    let harness: AppHarness | undefined

    try {
      subServer = await startMockSubServer({
        main: {
          format: 'yaml',
          nodes: [
            buildProxyNode('🇺🇸 US-Pass-All', { server: 'us-pass.example.net', port: 10001 }),
            buildProxyNode('🇯🇵 JP-Low-Avail', { server: 'jp-low.example.net', port: 10002 }),
            buildProxyNode('🇭🇰 HK-Gemini-Blocked', { server: 'hk-gem.example.net', port: 10003 }),
          ],
        },
      })
      harness = await startAppHarness()

      const sourceId = uniqueId('src_')
      const source = buildSource({ id: sourceId, name: 'P04 订阅', url: subServer.urlFor('main') })
      const initialState = await harness.apiGet<StateResponse>('/api/state')
      expect(initialState.ok).toBe(true)
      expect((await harness.apiPost('/api/probe', { kind: 'source', id: sourceId, url: source.url })).ok).toBe(true)
      expect(
        (
          await harness.apiPost('/api/draft', {
            revision: initialState.data.revision,
            draft: buildDraft({ ...initialState.data.draft, sources: [source] }),
          })
        ).ok,
      ).toBe(true)

      const nodesRes = await harness.apiGet<SourceNodesResponse>(`/api/source-nodes?id=${encodeURIComponent(sourceId)}`)
      const nodes = nodesRes.data.good?.nodes ?? []
      expect(nodes).toHaveLength(3)
      const usKey = `${sourceId}/${nodes.find(n => n.name.includes('US-Pass-All'))!.id}`
      const jpKey = `${sourceId}/${nodes.find(n => n.name.includes('JP-Low-Avail'))!.id}`
      const hkKey = `${sourceId}/${nodes.find(n => n.name.includes('HK-Gemini-Blocked'))!.id}`
      const keys = [usKey, jpKey, hkKey]

      // Pair Probe 1 and Probe 2
      const invite1 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const parsed1 = parseInviteLink(invite1.data.pairing)
      const probe1 = createMockProbe({ origin: harness.baseUrl, profileId: parsed1.profileId, name: 'P04-Probe-1' })
      expect((await probe1.enroll(parsed1.ticket)).status).toBe(200)

      const invite2 = await harness.apiPost<{ pairing: string }>('/api/quality/invite', {})
      const parsed2 = parseInviteLink(invite2.data.pairing)
      const probe2 = createMockProbe({ origin: harness.baseUrl, profileId: parsed2.profileId, name: 'P04-Probe-2' })
      expect((await probe2.enroll(parsed2.ticket)).status).toBe(200)

      const devicesRes = await harness.apiGet<QualityDeviceSummary[]>('/api/quality/devices')
      const dev1 = devicesRes.data.find(d => d.name === 'P04-Probe-1')!
      const dev2 = devicesRes.data.find(d => d.name === 'P04-Probe-2')!

      // (F1,F5): Run 4 basic+AI checks on Probe 1:
      // US-Pass-All: 4/4 (100%) + all 3 AI green
      // JP-Low-Avail: 3/4 (75%) + all 3 AI green (even though 4th check passes, 3/4 = 0.75 < 0.80!)
      // HK-Gemini-Blocked: 4/4 (100%) + gemini restricted
      const jpOutcomes = [false, true, true, true] as const
      for (let i = 0; i < jpOutcomes.length; i++) {
        const qRes = await harness.apiPost('/api/quality/queue', {
          targetDeviceId: dev1.id,
          keys,
          config: basicAndAiConfig({ rounds: 2 }),
        })
        expect(qRes.status).toBe(200)

        const jpPass = jpOutcomes[i]
        const run = await probe1.pollAndComplete((node: QualityNode) => {
          if (node.key === usKey) {
            return { latencyMs: 50, ai: aiPresets.allGreen('US') }
          }
          if (node.key === jpKey) {
            return jpPass ? { latencyMs: 60, ai: aiPresets.allGreen('JP') } : { available: false }
          }
          return {
            latencyMs: 45,
            ai: buildAiResults(
              {
                gemini: aiReading.restricted('region_restricted', 'HK'),
              },
              'HK',
            ),
          }
        })
        expect(run.completeResponse?.status).toBe(200)
      }

      const latestRes = await harness.apiGet<Record<string, LatestNodeQuality>>(
        `/api/quality/latest?deviceId=${encodeURIComponent(dev1.id)}`,
      )
      expect(latestRes.status).toBe(200)
      assertNoLegacyAiStrings(latestRes.data)
      const latest = unwrapLatestForDevice(latestRes.data, dev1.id)
      assertAvailabilityStats(latest[usKey]?.availability, 4, 4)
      assertAvailabilityStats(latest[jpKey]?.availability, 3, 4)
      assertAvailabilityStats(latest[hkKey]?.availability, 4, 4)
      assertThreeSurfaceAi(latest[usKey]?.ai?.results)
      assertThreeSurfaceAi(latest[hkKey]?.ai?.results)

      // (F5,F6) & (F1,F6): Configure Group 1 bound to dev1 with { aiAll: true, minAvailability: 0.8 }
      // and Group 2 bound to dev2 (untested on dev2) to prove single-probe isolation & no report pinning.
      const stateBeforeGroup = await harness.apiGet<StateResponse>('/api/state')
      const group1 = buildProxyGroup({
        name: 'AI-HighAvail-Group',
        qualityDeviceId: dev1.id,
        members: [
          buildPoolMember({
            sourceIds: [sourceId],
            quality: buildQualityCondition({
              aiAll: true,
              minAvailability: 0.8,
              fallbackWhenEmpty: false,
            }),
          }),
        ],
      })
      const group2 = buildProxyGroup({
        name: 'Probe2-Untested-Group',
        qualityDeviceId: dev2.id,
        members: [
          buildPoolMember({
            sourceIds: [sourceId],
            quality: buildQualityCondition({
              aiAll: true,
              minAvailability: 0.8,
              fallbackWhenEmpty: false,
            }),
          }),
          { kind: 'builtin', id: 'DIRECT' },
        ],
      })

      const saveGroupRes = await harness.apiPost<StateResponse>('/api/draft', {
        revision: stateBeforeGroup.data.revision,
        draft: buildDraft({
          ...stateBeforeGroup.data.draft,
          sources: [source],
          groups: [group1, group2],
        }),
      })
      expect(saveGroupRes.status).toBe(200)

      // Publish without expectedQualityReportId
      const publishRes = await harness.apiPost<StateResponse>('/api/publish', {
        revision: saveGroupRes.data.revision,
      })
      expect(publishRes.status).toBe(200)

      const linkRes = await harness.apiPost<LinkResponse>('/api/link', { action: 'rotate' })
      expect(linkRes.status).toBe(200)
      assert.ok(linkRes.data.url)

      const subRes = await harness.subGet(linkRes.data.url)
      expect(subRes.status).toBe(200)
      const yaml = parseMihomoYaml(subRes.text)
      assertNoLegacyAiStrings(yaml)

      // Only US-Pass-All meets both 3/3 AI unlock AND >= 80% availability (JP is 75%, HK has gemini restricted)
      assertYamlGroupExactOrder(yaml, 'AI-HighAvail-Group', ['🇺🇸 US-Pass-All'])
      // Probe 2 has no measurements, so Probe2-Untested-Group must not leak Probe 1's data
      assertYamlGroupExactOrder(yaml, 'Probe2-Untested-Group', ['DIRECT'])
      const probe2Proxies = getYamlGroupProxies(yaml, 'Probe2-Untested-Group')
      expect(probe2Proxies).not.toContain('🇺🇸 US-Pass-All')
      expect(probe2Proxies).not.toContain('🇯🇵 JP-Low-Avail')
      expect(probe2Proxies).not.toContain('🇭🇰 HK-Gemini-Blocked')

      // Verify UI has no QualityBaselinePicker and no Grok/Claude
      await unlockOrSetupAuth(page, harness.baseUrl, harness.password!)
      await openNodesPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)
      await expectNoLegacyAiPlatforms(page)

      await openGroupsPage(page, harness.baseUrl, group1.id)
      await expectNoReportBaselinePicker(page)
      await expectNoLegacyAiPlatforms(page)

      await openPublishPage(page, harness.baseUrl)
      await expectNoReportBaselinePicker(page)

      errors.assertNoErrors()
    } finally {
      await harness?.close()
      await subServer?.close()
    }
  })
})
