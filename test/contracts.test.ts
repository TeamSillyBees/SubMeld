import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { hasQualityConditions, poolCondition, qualityPresets, qualityReason, resolvePool, skippedMetrics } from '../shared/group-filter.ts'
import {
  aiStates, availabilityStatsSchema, defaultQualityScheduleConfig, latestNodeQualitySchema,
  qualityConfig, qualityDefaults, qualityScheduleConfigSchema, scheduleRunSchema, surfaces, surfaceNames, type AiReading, type LatestNodeQuality, type QualityRow,
} from '../shared/quality.ts'
import { minimumProbeVersion, probeProtocol } from '../shared/quality-options.ts'
import {
  compareQuality, getAiDisplayStatus, higherFirst, inferredExitRegion, latestQualitySnapshot, nodeQualityFromLatest, qualityValue,
  type NodeQuality, type QualitySnapshot,
} from '../shared/quality-snapshot.ts'
import { group, read } from '../server/schema.ts'

test('R1 surface contracts & protocol v4 constants match specification', () => {
  assert.equal(probeProtocol, 4)
  assert.equal(minimumProbeVersion, '2.0.0')
  assert.deepEqual(surfaces, ['chatgptWeb', 'chatgptApp', 'gemini', 'antigravity'])
  assert.deepEqual(surfaceNames, {
    chatgptWeb: 'ChatGPT Web',
    chatgptApp: 'ChatGPT APP',
    gemini: 'Gemini Web',
    antigravity: 'Antigravity',
  })
  assert.equal(qualityDefaults.basic, true)
  assert.deepEqual(qualityPresets.ai.condition.platforms, ['chatgptWeb', 'gemini'])
})

test('getAiDisplayStatus maps null, needsReview, and all 11 aiStates deterministically', () => {
  assert.equal(getAiDisplayStatus(null), null)
  assert.equal(getAiDisplayStatus(undefined, 'JP'), null)

  const make = (state: AiReading['state'], needsReview = false, providerRegion: string | null = null): AiReading => ({
    state,
    evidence: 'unrecognized',
    httpStatus: 200,
    needsReview,
    providerRegion,
  })

  // Any state with needsReview === true -> warning / '未知'
  for (const state of aiStates) {
    assert.deepEqual(getAiDisplayStatus(make(state, true, 'US'), 'JP'), { tone: 'warning', label: '未知' })
  }

  // Confirmed reachable -> providerRegion || exitRegion || '可用'
  assert.deepEqual(getAiDisplayStatus(make('reachable', false, 'US'), 'JP'), { tone: 'success', label: 'US' })
  assert.deepEqual(getAiDisplayStatus(make('reachable', false, null), 'JP'), { tone: 'success', label: 'JP' })
  assert.deepEqual(getAiDisplayStatus(make('reachable', false, null), null), { tone: 'success', label: '可用' })
  assert.deepEqual(getAiDisplayStatus(make('reachable', false, null), ''), { tone: 'success', label: '可用' })

  // Explicit strict restrictions -> danger / '受限'
  for (const state of ['region_restricted', 'ip_blocked', 'unavailable'] as const) {
    assert.deepEqual(getAiDisplayStatus(make(state, false, 'CN'), 'HK'), { tone: 'danger', label: '受限' })
  }

  // Remaining uncertain/transient states -> warning / '未知'
  for (const state of ['challenge', 'degraded_challenge', 'unknown', 'network_error', 'authentication', 'rate_limited', 'region_mismatch'] as const) {
    assert.deepEqual(getAiDisplayStatus(make(state, false, 'JP'), 'JP'), { tone: 'warning', label: '未知' })
  }
})

test('inferredExitRegion requires >= 2 agreeing non-fallback surfaces and zero disagreements', () => {
  const mk = (providerRegion: string | null, evidence: AiReading['evidence'] = 'web_entry'): AiReading => ({
    state: 'reachable', evidence, httpStatus: 200, needsReview: false, providerRegion,
  })
  const baseRow: QualityRow = {
    key: 'source01/node0001', available: true, error: null, samples: [], tlsMedianMs: 10, httpsMedianMs: 50,
    jitterMs: 1, lossRate: 0, exit: null, speed: null,
    ai: { chatgptWeb: mk('JP'), chatgptApp: mk('JP'), gemini: mk(null), antigravity: mk(null) },
  }
  assert.equal(inferredExitRegion(baseRow), 'JP')
  assert.equal(inferredExitRegion({ ...baseRow, ai: { chatgptWeb: mk('JP'), chatgptApp: mk(null), gemini: mk('JP'), antigravity: mk(null) } }), 'JP')
  assert.equal(inferredExitRegion({ ...baseRow, ai: { chatgptWeb: mk('JP'), chatgptApp: mk(null), gemini: mk(null), antigravity: mk(null) } }), null)
  assert.equal(inferredExitRegion({ ...baseRow, ai: { chatgptWeb: mk('JP'), chatgptApp: mk('US'), gemini: mk('JP'), antigravity: mk(null) } }), null)
  assert.equal(inferredExitRegion({ ...baseRow, ai: { chatgptWeb: mk('JP', 'exit_region_fallback'), chatgptApp: mk('JP'), gemini: mk(null), antigravity: mk(null) } }), null)
})

test('qualityConfig, availabilityStatsSchema, latestNodeQualitySchema, and qualityScheduleConfigSchema validate boundaries', () => {
  const { basic: _omitted, ...legacyShape } = qualityDefaults
  assert.equal(qualityConfig.parse(legacyShape).basic, true)
  assert.equal(qualityConfig.parse({ ...qualityDefaults, basic: false, ai: true }).basic, false)
  assert.throws(() => qualityConfig.parse({ ...qualityDefaults, basic: false, ai: false }))

  const now = new Date().toISOString()
  const validStats = { window: [true, false, true, true], total: 4, success: 3, rate: 0.75, updatedAt: now }
  assert.deepEqual(availabilityStatsSchema.parse(validStats), validStats)
  assert.deepEqual(availabilityStatsSchema.parse({ window: [true, false, false], total: 3, success: 1, rate: 1 / 3, updatedAt: now }).total, 3)
  assert.deepEqual(availabilityStatsSchema.parse({ window: [], total: 0, success: 0, rate: 0, updatedAt: now }).rate, 0)
  assert.throws(() => availabilityStatsSchema.parse({ ...validStats, total: 5 }))
  assert.throws(() => availabilityStatsSchema.parse({ ...validStats, success: 2 }))
  assert.throws(() => availabilityStatsSchema.parse({ window: [true, false], total: 2, success: 1, rate: 0.9, updatedAt: now }))
  assert.throws(() => availabilityStatsSchema.parse({ window: [true, false, false], total: 3, success: 1, rate: 0.33, updatedAt: now }))
  assert.throws(() => availabilityStatsSchema.parse({ window: [], total: 0, success: 0, rate: 0.1, updatedAt: now }))
  assert.throws(() => availabilityStatsSchema.parse({
    window: Array(21).fill(true), total: 21, success: 21, rate: 1, updatedAt: now,
  }))

  const reading: AiReading = { state: 'reachable', evidence: 'web_entry', httpStatus: 200, needsReview: false, providerRegion: 'US' }
  const validLatest = {
    nodeKey: 'source01/node0001',
    deviceId: randomUUID(),
    basic: {
      available: true, httpsMs: 42, tlsMs: 12, jitterMs: 3, lossRate: 0,
      exit: { ip: '192.0.2.1', region: 'US' }, infoNode: false, error: null, updatedAt: now,
    },
    speed: { speedMbps: 55.2, speedFailed: false, updatedAt: now },
    ai: { results: { chatgptWeb: reading, chatgptApp: reading, gemini: reading, antigravity: reading }, updatedAt: now },
    availability: validStats,
  }
  assert.deepEqual(latestNodeQualitySchema.parse(validLatest), validLatest)
  assert.throws(() => latestNodeQualitySchema.parse({ ...validLatest, extra: true }))
  assert.throws(() => latestNodeQualitySchema.parse({
    ...validLatest,
    ai: { results: { ...validLatest.ai.results, grok: reading }, updatedAt: now },
  }))

  assert.deepEqual(qualityScheduleConfigSchema.parse(defaultQualityScheduleConfig), defaultQualityScheduleConfig)
  const minimalSchedule = qualityScheduleConfigSchema.parse({
    targetDeviceId: null,
    basic: { enabled: true, intervalMinutes: 60, rounds: 2, concurrency: 1, bandwidth: false },
    ai: { enabled: false, intervalMinutes: 43200, concurrency: 12 },
  })
  assert.equal(minimalSchedule.scope, 'kept')
  assert.equal(minimalSchedule.autoRefreshGroups, true)
  assert.equal(minimalSchedule.basic.lastRunAt, null)
  assert.equal(minimalSchedule.basic.lastJobId, null)
  assert.equal(minimalSchedule.ai.lastRunAt, null)
  assert.equal(minimalSchedule.ai.lastJobId, null)
  assert.equal(qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    basic: { ...defaultQualityScheduleConfig.basic, intervalMinutes: 1, rounds: 8, concurrency: 12 },
    ai: { ...defaultQualityScheduleConfig.ai, intervalMinutes: 1, concurrency: 1 },
  }).basic.intervalMinutes, 1)
  assert.throws(() => qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    basic: { ...defaultQualityScheduleConfig.basic, intervalMinutes: 0 },
  }))
  assert.throws(() => qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    basic: { ...defaultQualityScheduleConfig.basic, intervalMinutes: 1.5 },
  }))
  assert.throws(() => qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    basic: { ...defaultQualityScheduleConfig.basic, rounds: 1 },
  }))
  assert.throws(() => qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    basic: { ...defaultQualityScheduleConfig.basic, rounds: 9 },
  }))
  assert.throws(() => qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    basic: { ...defaultQualityScheduleConfig.basic, concurrency: 0 },
  }))
  assert.throws(() => qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    ai: { ...defaultQualityScheduleConfig.ai, intervalMinutes: 43201 },
  }))
  assert.throws(() => qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    ai: { ...defaultQualityScheduleConfig.ai, concurrency: 13 },
  }))
  assert.throws(() => qualityScheduleConfigSchema.parse({ ...defaultQualityScheduleConfig, scope: 'selected' }))
  assert.throws(() => qualityScheduleConfigSchema.parse({ ...defaultQualityScheduleConfig, targetDeviceId: 'not-a-uuid' }))
  assert.throws(() => qualityScheduleConfigSchema.parse({ ...defaultQualityScheduleConfig, extra: true }))
  assert.throws(() => qualityScheduleConfigSchema.parse({
    ...defaultQualityScheduleConfig,
    basic: { ...defaultQualityScheduleConfig.basic, lastRunAt: 'not-iso' },
  }))
  assert.deepEqual(scheduleRunSchema.parse({}), { kind: 'due' })
  assert.deepEqual(scheduleRunSchema.parse({ kind: 'basic' }), { kind: 'basic' })
  assert.deepEqual(scheduleRunSchema.parse({ kind: 'ai' }), { kind: 'ai' })
  assert.throws(() => scheduleRunSchema.parse({ kind: 'other' }))
  assert.throws(() => scheduleRunSchema.parse({ kind: 'due', extra: 1 }))
})

test('Group.qualityDeviceId & QualityCondition.{minAvailability, aiAll, aiSurfaces} schemas and filter semantics work', () => {
  const deviceId = randomUUID()
  const baseGroup = { id: 'group001', name: 'G', type: 'select' as const, enabled: true, members: [] }
  assert.equal(read(group, { ...baseGroup, qualityDeviceId: deviceId }).qualityDeviceId, deviceId)
  assert.equal(read(group, { ...baseGroup, qualityDeviceId: null }).qualityDeviceId, null)
  assert.equal(read(group, baseGroup).qualityDeviceId, undefined)
  assert.throws(() => read(group, { ...baseGroup, qualityDeviceId: 'not-a-uuid' }))

  const validPool = poolCondition({
    quality: { minAvailability: 0.8, aiAll: true, aiSurfaces: ['chatgptWeb', 'gemini'] },
  })
  assert.deepEqual(read(group, { ...baseGroup, members: [validPool] }).members[0], validPool)
  assert.throws(() => read(group, {
    ...baseGroup,
    members: [poolCondition({ quality: { minAvailability: 1.1 } })],
  }))
  assert.throws(() => read(group, {
    ...baseGroup,
    members: [poolCondition({ quality: { aiSurfaces: ['grok' as never] } })],
  }))

  assert.deepEqual(skippedMetrics({ aiAll: true }, { bandwidth: true, ai: false }), { bandwidth: false, ai: true })
  assert.deepEqual(skippedMetrics({ aiSurfaces: ['gemini'] }, { bandwidth: true, ai: false }), { bandwidth: false, ai: true })

  const baseQuality: NodeQuality = {
    available: true, httpsMs: 50, tlsMs: 20, lossRate: 0, speedMbps: 20, speedFailed: false,
    reachable: ['chatgptWeb', 'gemini'],
  }

  // minAvailability: allows historical availability >= threshold even if single latest check failed (when alive is not set)
  assert.equal(qualityReason({ minAvailability: 0.8 }, { ...baseQuality, available: false, availabilityRate: 0.85 }), null)
  assert.equal(qualityReason({ alive: true, minAvailability: 0.8 }, { ...baseQuality, available: false, availabilityRate: 0.85 }), 'unavailable')
  assert.equal(qualityReason({ minAvailability: 0.8 }, { ...baseQuality, availabilityRate: 0.75 }), 'availability')
  assert.equal(qualityReason({ minAvailability: 0.8 }, baseQuality), 'untested')

  // minAvailability + basic metric (maxLatencyMs) on a failed basic check returns 'unavailable' (not 'untested')
  assert.equal(qualityReason({ minAvailability: 0.8, maxLatencyMs: 250 }, { ...baseQuality, available: false, httpsMs: null, availabilityRate: 0.9 }), 'unavailable')
  // T2-F4-02 guard: minAvailability + aiAll with preserved AI remains eligible when latest basic check failed
  assert.equal(qualityReason({ minAvailability: 0.5, aiAll: true }, { ...baseQuality, available: false, httpsMs: null, availabilityRate: 0.5, reachable: ['chatgptWeb', 'chatgptApp', 'gemini', 'antigravity'] }), null)

  // aiAll requires all 4 surfaces; aiSurfaces requires only selected surfaces
  assert.equal(qualityReason({ aiAll: true }, baseQuality), 'platform')
  assert.equal(qualityReason({ aiAll: true }, { ...baseQuality, reachable: ['chatgptWeb', 'chatgptApp', 'gemini'] }), 'platform')
  assert.equal(qualityReason({ aiAll: true }, { ...baseQuality, reachable: ['chatgptWeb', 'chatgptApp', 'gemini', 'antigravity'] }), null)
  assert.equal(qualityReason({ aiSurfaces: ['chatgptWeb', 'gemini'] }, baseQuality), null)
  assert.equal(qualityReason({ aiSurfaces: ['antigravity'] }, baseQuality), 'platform')
  assert.equal(qualityReason({ aiSurfaces: ['antigravity'] }, { ...baseQuality, reachable: ['antigravity'] }), null)

  // resolvePool end-to-end with minAvailability, aiAll, and relaxWhenEmpty
  const nodes = [
    { key: 's1/n1', name: 'N1', kept: true, sourceId: 's1', region: 'JP' },
    { key: 's1/n2', name: 'N2', kept: true, sourceId: 's1', region: 'JP' },
    { key: 's1/n3', name: 'N3', kept: true, sourceId: 's1', region: 'JP' },
  ]
  const snapshot: QualitySnapshot = {
    reportId: randomUUID(),
    rows: {
      's1/n1': { ...baseQuality, availabilityRate: 0.9, reachable: ['chatgptWeb', 'chatgptApp', 'gemini', 'antigravity'] },
      's1/n2': { ...baseQuality, availabilityRate: 0.5, reachable: ['chatgptWeb', 'chatgptApp', 'gemini', 'antigravity'] },
      's1/n3': { ...baseQuality, availabilityRate: 0.95, reachable: ['chatgptWeb', 'gemini', 'antigravity'], surfaceIssues: { chatgptApp: 'degraded_challenge' } },
    },
  }
  const filtered = resolvePool(poolCondition({ quality: { minAvailability: 0.8, aiAll: true } }), nodes, snapshot)
  assert.deepEqual(filtered.matches.map(n => n.key), ['s1/n1'])
  assert.deepEqual(filtered.reasons, { availability: 1, platform: 1 })

  const relaxed = resolvePool(
    poolCondition({ quality: { aiAll: true, relaxWhenEmpty: true } }),
    [nodes[2]],
    snapshot,
  )
  assert.equal(relaxed.relaxation, 'challenge')
  assert.deepEqual(relaxed.matches.map(n => n.key), ['s1/n3'])
})

test('nodeQualityFromLatest, latestQualitySnapshot, hasQualityConditions, and availability sorting behave consistently', () => {
  const now = new Date().toISOString()
  const deviceId = randomUUID()
  const reading = (providerRegion: string | null, state: AiReading['state'] = 'reachable'): AiReading => ({
    state, evidence: 'web_entry', httpStatus: 200, needsReview: false, providerRegion,
  })
  const aiOnlyRecord: LatestNodeQuality = {
    nodeKey: 's1/n1',
    deviceId,
    basic: null,
    speed: null,
    ai: {
      results: { chatgptWeb: reading('JP'), chatgptApp: reading('JP'), gemini: reading(null), antigravity: reading(null) },
      updatedAt: now,
    },
    availability: null,
  }
  const projected = nodeQualityFromLatest(aiOnlyRecord)
  assert.equal(projected.available, true)
  assert.equal(projected.exitRegion, 'JP')
  assert.equal(projected.exitRegionInferred, true)
  assert.equal(projected.availabilityRate, null)
  assert.deepEqual(projected.reachable, ['chatgptWeb', 'chatgptApp', 'gemini', 'antigravity'])

  // Untested speed/basic remain 'untested' because latestQualitySnapshot omits config
  const snap = latestQualitySnapshot({ 's1/n1': aiOnlyRecord }, deviceId)
  assert.equal(snap.config, undefined)
  assert.equal(qualityReason({ aiAll: true }, snap.rows['s1/n1'], snap.config), null)
  assert.equal(qualityReason({ minBandwidthMbps: 10 }, snap.rows['s1/n1'], snap.config), 'untested')
  assert.equal(qualityReason({ minAvailability: 0.5 }, snap.rows['s1/n1'], snap.config), 'untested')

  assert.equal(hasQualityConditions(null), false)
  assert.equal(hasQualityConditions(undefined), false)
  assert.equal(hasQualityConditions({}), false)
  assert.equal(hasQualityConditions({ relaxWhenEmpty: true }), false)
  assert.equal(hasQualityConditions({ minAvailability: 0 }), true)
  assert.equal(hasQualityConditions({ sortBy: 'availability' }), true)

  assert.equal(higherFirst('availability'), true)
  const highRateDownNow: NodeQuality = { available: false, httpsMs: 100, tlsMs: 20, lossRate: 0, speedMbps: null, speedFailed: false, reachable: null, availabilityRate: 0.9 }
  const lowRateUpNow: NodeQuality = { available: true, httpsMs: 50, tlsMs: 10, lossRate: 0, speedMbps: null, speedFailed: false, reachable: null, availabilityRate: 0.8 }
  const tiedUpNow: NodeQuality = { available: true, httpsMs: 80, tlsMs: 20, lossRate: 0, speedMbps: null, speedFailed: false, reachable: null, availabilityRate: 0.9 }
  const untestedAvail: NodeQuality = { available: true, httpsMs: 20, tlsMs: 10, lossRate: 0, speedMbps: null, speedFailed: false, reachable: null, availabilityRate: null }
  assert.equal(qualityValue(highRateDownNow, 'availability'), 0.9)
  assert.ok(compareQuality(highRateDownNow, lowRateUpNow, 'availability') < 0)
  assert.ok(compareQuality(tiedUpNow, highRateDownNow, 'availability') < 0)
  assert.ok(compareQuality(highRateDownNow, untestedAvail, 'availability') < 0)
  assert.ok(compareQuality(highRateDownNow, lowRateUpNow, 'availability', true) > 0)
})
