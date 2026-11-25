import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultFilter } from '../shared/catalog.ts'
import { poolCondition } from '../shared/group-filter.ts'
import { qualityDefaults, type AiReading } from '../shared/quality.ts'
import { latestQualitySnapshot, qualitySnapshot } from '../shared/quality-snapshot.ts'
import { exportBackup, restoreBackup } from '../server/backup.ts'
import { cleanupLegacyQualityData } from '../server/cleanup.ts'
import { createApplication } from '../server/http.ts'
import { qualitySpaces } from '../server/quality.ts'
import { openStore, type Store } from '../server/store.ts'
import { createWorkspace } from '../server/workspace.ts'

const reading = (state: AiReading['state']): AiReading => ({
  state, evidence: 'unrecognized', httpStatus: 200, needsReview: false, providerRegion: 'JP',
})

async function seedLegacyStore(store: Store) {
  const work = createWorkspace({ store, verify: async () => null, remote: {}, tickMs: 0 })
  try {
    const initial = work.state()
    const source = { id: 'src-clean', name: 'S', local: true as const, url: '', tag: '', minutes: 60, paused: false, enabled: true, filter: defaultFilter }
    const pool = poolCondition({ sourceIds: [source.id] })
    const group = { id: 'grp-clean', name: 'Pool', type: 'select' as const, enabled: true, members: [pool] }
    const saved = await work.saveDraft(initial.id, 'seed', {
      revision: initial.revision,
      draft: { ...initial.draft, sources: [source], groups: [group] },
      localNodes: { [source.id]: [{ name: 'N1', type: 'http', server: 'node.example', port: 8000 }] },
    })
    await work.publish(saved.id, saved.revision)
    const profileId = saved.id
    const reportId = randomUUID()
    const deviceId = randomUUID()
    const spaces = qualitySpaces(profileId)
    const now = new Date().toISOString()

    // 1. Seed legacy quality-reports/${profileId}
    store.set(spaces.reports, reportId, {
      schemaVersion: 1,
      jobId: reportId,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      config: qualityDefaults,
      results: [
        {
          key: 'src-clean/node0001', name: 'N1', sourceName: 'S', available: true, error: null,
          samples: [], tlsMedianMs: 10, httpsMedianMs: 50, jitterMs: 1, lossRate: 0, exit: null, speed: null,
          ai: {
            chatgptWeb: reading('reachable'), chatgptApp: reading('reachable'), gemini: reading('reachable'),
            claudeWeb: reading('reachable'), claudeApi: reading('reachable'), grok: reading('region_restricted'),
          } as never,
        },
        {
          key: 'src-clean/node0002', name: 'N2', sourceName: 'S', available: false, error: 'no_response',
          samples: [], tlsMedianMs: null, httpsMedianMs: null, jitterMs: null, lossRate: null, exit: null, speed: null,
          ai: null,
        },
        {
          key: 'src-clean/node0003', name: 'N3', sourceName: 'S', available: true, error: null,
          samples: [], tlsMedianMs: 12, httpsMedianMs: 60, jitterMs: 2, lossRate: 0, exit: null, speed: null,
          ai: { grok: reading('unknown') } as never,
        },
      ],
    })

    // 2. Seed legacy profiles (draft.groups + fixedQualitySnapshot)
    const profile = store.get('profiles', profileId)!
    const legacySnapshot = {
      reportId,
      rows: {
        'src-clean/node0001': {
          available: true, httpsMs: 50, tlsMs: 10, lossRate: 0, speedMbps: null, speedFailed: false,
          reachable: ['chatgptWeb', 'grok'],
          platforms: { ChatGPT: 'unlocked', Gemini: 'unlocked', Claude: 'region_restricted', Grok: 'blocked_or_unreachable' },
          surfaceIssues: { grok: 'challenge', chatgptApp: 'degraded_challenge' },
        },
        'src-clean/node0002': {
          available: true, httpsMs: 60, tlsMs: 15, lossRate: 0, speedMbps: null, speedFailed: false,
          reachable: ['grok'],
          platforms: { ChatGPT: 'unlocked', Gemini: null, Claude: 'unlocked', Grok: 'unlocked' },
          surfaceIssues: { claudeWeb: 'unknown' },
        },
      },
    }
    store.set('profiles', profileId, {
      ...profile,
      draft: {
        ...profile.draft,
        qualityBaselinePolicy: { mode: 'fixed', reportId },
        groups: [
          {
            id: 'grp-legacy-1', name: 'Legacy1', type: 'select', enabled: true,
            members: [
              { kind: 'pool', regions: [], sourceIds: [source.id], includeRegex: '', excludeRegex: '', quality: { platforms: ['chatgptWeb', 'grok'] as never, sortBy: 'Grok' as never, sortReverse: true } },
              { kind: 'pool', regions: [], sourceIds: [source.id], includeRegex: '', excludeRegex: '', quality: { platforms: ['grok'] as never, aiPlatforms: ['ChatGPT', 'Claude'] as never } },
              { kind: 'pool', regions: [], sourceIds: [source.id], includeRegex: '', excludeRegex: '', quality: { aiPlatforms: ['Grok'] as never, minUnlockLevel: 2, sortBy: 'claudeWeb' as never } },
            ],
          },
        ],
      } as never,
      fixedQualitySnapshot: legacySnapshot as never,
    } as never)

    // 3. Seed legacy versions/${profileId}
    const verSpace = `versions/${profileId}` as const
    const version = store.get(verSpace, '000000000001')!
    store.set(verSpace, '000000000001', {
      ...version,
      qualityReportId: reportId,
      qualityDeviceId: deviceId,
      qualitySnapshot: legacySnapshot as never,
      recipe: {
        ...version.recipe,
        qualityBaselinePolicy: { mode: 'latest' },
        groups: [
          {
            id: 'grp-ver-1', name: 'Ver1', type: 'select', enabled: true,
            members: [
              { kind: 'pool', regions: [], sourceIds: [source.id], includeRegex: '', excludeRegex: '', quality: { platforms: ['claudeWeb', 'gemini'] as never, aiPlatforms: ['Claude'] as never, minUnlockLevel: 3, sortBy: 'Claude' as never } },
            ],
          },
        ],
      } as never,
    } as never)

    // 4. Seed legacy system/library
    const lib = store.get('system', 'library') ?? { filters: [], groups: [], providers: [] }
    store.set('system', 'library', {
      ...lib,
      groups: [
        {
          id: 'template01', name: 'Template',
          groups: [
            {
              id: 'grp-lib-1', name: 'Lib1', type: 'select', enabled: true,
              members: [
                { kind: 'pool', regions: [], sourceIds: [], includeRegex: '', excludeRegex: '', quality: { aiSurfaces: ['chatgptWeb', 'claudeApi'] as never, aiPlatforms: ['Grok'] as never, minUnlockLevel: 2, sortBy: 'grok' as never } },
              ],
            },
          ],
        },
      ],
    })

    // 5. Seed legacy quality-device/${profileId} keys + invite + paired device
    store.set(spaces.device, 'registration' as never, { name: 'Old', platform: 'linux', lastSeen: now, secretHash: 'abc' } as never)
    store.set(spaces.device, 'next' as never, reportId as never)
    store.set(spaces.device, 'invite', { ticketHash: 'keep-invite-hash', expiresAt: now })
    store.set(spaces.devices, deviceId, {
      id: deviceId, name: 'Old Paired', remark: '', platform: 'windows',
      lastSeenAt: now, secretHash: 'keep-device-hash', protocolVersion: 3, agentVersion: '1.3.1',
    })

    return { profileId, reportId, deviceId }
  } finally {
    await work.stop()
  }
}

test('cleanupLegacyQualityData scrubs all 5 spaces idempotently, preserves invite/devices, and keeps backup valid', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-cleanup-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const { profileId, reportId, deviceId } = await seedLegacyStore(store)
  const spaces = qualitySpaces(profileId)

  const summary = cleanupLegacyQualityData(store)
  assert.deepEqual(summary, { updated: 4, removed: 2 })

  // Verify quality-reports cleaned
  const report = store.get(spaces.reports, reportId)!
  assert.deepEqual(Object.keys(report.results[0].ai!).sort(), ['antigravity', 'chatgptApp', 'chatgptWeb', 'gemini'])
  assert.equal(report.results[0].ai!.antigravity.state, 'unknown')
  assert.equal(report.results[0].ai!.antigravity.needsReview, true)
  assert.equal(report.results[1].ai, null)
  assert.equal(report.results[2].ai, null)

  // Verify profiles cleaned (including removal of fixedQualitySnapshot and qualityBaselinePolicy)
  const profile = store.get('profiles', profileId)! as unknown as Record<string, unknown>
  const draftRecord = profile.draft as { groups: Array<{ members: Array<{ quality?: Record<string, unknown> }> }> }
  const [m0, m1, m2] = draftRecord.groups[0].members
  assert.deepEqual(m0.quality, { platforms: ['chatgptWeb'] })
  assert.deepEqual(m1.quality, { aiPlatforms: ['ChatGPT'] })
  assert.deepEqual(m2.quality, {})
  assert.equal(Object.hasOwn(profile, 'fixedQualitySnapshot'), false)
  assert.equal(Object.hasOwn(draftRecord, 'qualityBaselinePolicy'), false)

  // Verify versions cleaned (including removal of qualitySnapshot, qualityReportId, qualityDeviceId, recipe.qualityBaselinePolicy)
  const ver = store.get(`versions/${profileId}`, '000000000001')! as unknown as Record<string, unknown>
  const recipeRecord = ver.recipe as { groups: Array<{ members: Array<{ quality?: Record<string, unknown> }> }> }
  const vm0 = recipeRecord.groups[0].members[0]
  assert.deepEqual(vm0.quality, { platforms: ['gemini'] })
  assert.equal(Object.hasOwn(ver, 'qualitySnapshot'), false)
  assert.equal(Object.hasOwn(ver, 'qualityReportId'), false)
  assert.equal(Object.hasOwn(ver, 'qualityDeviceId'), false)
  assert.equal(Object.hasOwn(recipeRecord, 'qualityBaselinePolicy'), false)

  // Verify system/library cleaned
  const lib = store.get('system', 'library')!
  const lm0 = lib.groups[0].groups[0].members[0] as { quality?: Record<string, unknown> }
  assert.deepEqual(lm0.quality, { aiSurfaces: ['chatgptWeb'] })

  // Verify quality-device & quality-devices
  assert.equal(store.get(spaces.device, 'registration' as never), null)
  assert.equal(store.get(spaces.device, 'next' as never), null)
  assert.deepEqual(store.get(spaces.device, 'invite'), { ticketHash: 'keep-invite-hash', expiresAt: store.get(spaces.device, 'invite')!.expiresAt })
  assert.equal(store.get(spaces.devices, deviceId)?.agentVersion, '1.3.1')

  // Verify strict idempotency (zero writes on 2nd run)
  let writes = 0
  store.onWrite(() => { writes++ })
  assert.deepEqual(cleanupLegacyQualityData(store), { updated: 0, removed: 0 })
  assert.equal(writes, 0)

  // Verify backup export & restore succeed on migrated store
  const work = createWorkspace({ store, verify: async () => null, remote: {}, tickMs: 0 })
  try {
    const backup = exportBackup(store, 'cleanup backup passphrase')
    await restoreBackup(work, backup, 'cleanup backup passphrase', async () => null)
  } finally {
    await work.stop()
  }
})

test('createApplication runs cleanupLegacyQualityData automatically on startup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-cleanup-startup-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const store = openStore(dir)
  const { profileId, reportId } = await seedLegacyStore(store)
  store.close()

  const app = createApplication({ directory: dir, tickMs: 0, verify: async () => null })
  try {
    const spaces = qualitySpaces(profileId)
    const verifyStore = app.workspace
    const state = verifyStore.state(profileId)
    const m1 = state.draft.groups[0].members[1] as { quality?: Record<string, unknown> }
    assert.deepEqual(m1.quality, { aiPlatforms: ['ChatGPT'] })
    await app.close()

    const reopened = openStore(dir)
    try {
      assert.equal(reopened.get(spaces.device, 'registration' as never), null)
      assert.equal(reopened.get(spaces.device, 'next' as never), null)
      assert.ok(reopened.get(spaces.device, 'invite'))
      assert.deepEqual(Object.keys(reopened.get(spaces.reports, reportId)!.results[0].ai!).sort(), ['antigravity', 'chatgptApp', 'chatgptWeb', 'gemini'])
    } finally {
      reopened.close()
    }
  } catch (err) {
    await app.close().catch(() => {})
    throw err
  }
})

test('cleanupLegacyQualityData normalizes partial legacy ai maps without crashing qualitySnapshot, cleans quality-latest, and tolerates corrupt docs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'submeld-cleanup-partial-'))
  const store = openStore(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })

  const profileId = randomUUID()
  const reportId = randomUUID()
  const deviceId = randomUUID()
  const spaces = qualitySpaces(profileId)
  const now = new Date().toISOString()

  store.set(spaces.reports, reportId, {
    schemaVersion: 1,
    jobId: reportId,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    config: qualityDefaults,
    results: [
      {
        key: 'src-partial/node0001',
        name: 'Partial Node',
        sourceName: 'S',
        available: true,
        error: null,
        samples: [],
        tlsMedianMs: 10,
        httpsMedianMs: 40,
        jitterMs: 1,
        lossRate: 0,
        exit: { ip: '192.0.2.10', region: 'JP' },
        speed: null,
        ai: {
          chatgptWeb: reading('reachable'),
          grok: reading('unknown'),
        } as never,
      },
      {
        key: 'src-partial/node0002',
        name: 'Partial Without Legacy',
        sourceName: 'S',
        available: true,
        error: null,
        samples: [],
        tlsMedianMs: 10,
        httpsMedianMs: 40,
        jitterMs: 1,
        lossRate: 0,
        exit: null,
        speed: null,
        ai: {
          gemini: reading('region_restricted'),
        } as never,
      },
    ],
  })

  store.set(spaces.latest, `${deviceId}/src-partial/node0001`, {
    nodeKey: 'src-partial/node0001',
    deviceId,
    basic: null,
    speed: null,
    availability: null,
    ai: {
      results: {
        chatgptWeb: reading('reachable'),
        claudeWeb: reading('reachable'),
      } as never,
      updatedAt: now,
    },
  })

  // Seed corrupt / non-object docs across all spaces handled by cleanupLegacyQualityData
  store.set(spaces.reports, randomUUID(), 'corrupt-report' as never)
  store.set(spaces.reports, randomUUID(), { results: 'not-an-array' } as never)
  store.set(spaces.latest, 'corrupt-latest', null as never)
  store.set('profiles', 'corrupt-profile', 'bad' as never)
  store.set(`versions/${profileId}`, '000000000001', ['corrupt'] as never)
  store.set('system', 'library', { groups: 'not-an-array' } as never)

  const summary = cleanupLegacyQualityData(store)
  assert.equal(summary.updated, 2)

  const cleanedReport = store.get(spaces.reports, reportId)!
  assert.deepEqual(Object.keys(cleanedReport.results[0].ai!).sort(), ['antigravity', 'chatgptApp', 'chatgptWeb', 'gemini'])
  assert.equal(cleanedReport.results[0].ai!.chatgptWeb.state, 'reachable')
  assert.equal(cleanedReport.results[0].ai!.chatgptApp.state, 'unknown')
  assert.equal(cleanedReport.results[0].ai!.gemini.state, 'unknown')
  assert.equal(cleanedReport.results[0].ai!.antigravity.state, 'unknown')
  assert.deepEqual(Object.keys(cleanedReport.results[1].ai!).sort(), ['antigravity', 'chatgptApp', 'chatgptWeb', 'gemini'])
  assert.equal(cleanedReport.results[1].ai!.gemini.state, 'region_restricted')

  // Must not throw TypeError in qualitySnapshot / platformVerdict
  const snap = qualitySnapshot(cleanedReport)
  assert.deepEqual(snap.rows['src-partial/node0001'].reachable, ['chatgptWeb'])
  assert.equal(snap.rows['src-partial/node0001'].platforms?.ChatGPT, 'partial_unlock')
  assert.equal(snap.rows['src-partial/node0002'].platforms?.Gemini, 'region_restricted')

  const cleanedLatest = store.get(spaces.latest, `${deviceId}/src-partial/node0001`)!
  assert.deepEqual(Object.keys(cleanedLatest.ai!.results!).sort(), ['antigravity', 'chatgptApp', 'chatgptWeb', 'gemini'])
  const latestSnap = latestQualitySnapshot({ 'src-partial/node0001': cleanedLatest }, deviceId)
  assert.deepEqual(latestSnap.rows['src-partial/node0001'].reachable, ['chatgptWeb'])

  // Idempotent on second run
  assert.deepEqual(cleanupLegacyQualityData(store), { updated: 0, removed: 0 })
})
