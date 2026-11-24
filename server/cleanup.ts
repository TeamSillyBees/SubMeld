import type { Store } from './store.ts'
import { surfaces } from '../shared/quality-options.ts'

export interface CleanupSummary {
  updated: number
  removed: number
}

const LEGACY_SURFACES = new Set(['grok', 'claudeWeb', 'claudeApi'])
const LEGACY_PLATFORMS = new Set(['Claude', 'Grok'])
const LEGACY_SORTS = new Set(['Claude', 'Grok', 'claudeWeb', 'claudeApi', 'grok'])
const UNKNOWN_AI_READING = {
  state: 'unknown',
  evidence: 'unrecognized',
  httpStatus: null,
  needsReview: true,
  providerRegion: null,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanGroups(groups: unknown): boolean {
  if (!Array.isArray(groups)) return false
  let changed = false
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.members)) continue
    for (const member of group.members) {
      if (!isRecord(member) || member.kind !== 'pool' || !isRecord(member.quality)) continue
      const quality = member.quality
      if (Array.isArray(quality.platforms)) {
        const next = quality.platforms.filter(item => typeof item !== 'string' || !LEGACY_SURFACES.has(item))
        if (next.length !== quality.platforms.length) {
          changed = true
          if (next.length === 0) delete quality.platforms
          else quality.platforms = next
        }
      }
      if (Array.isArray(quality.aiSurfaces)) {
        const next = quality.aiSurfaces.filter(item => typeof item !== 'string' || !LEGACY_SURFACES.has(item))
        if (next.length !== quality.aiSurfaces.length) {
          changed = true
          if (next.length === 0) delete quality.aiSurfaces
          else quality.aiSurfaces = next
        }
      }
      if (Array.isArray(quality.aiPlatforms)) {
        const next = quality.aiPlatforms.filter(item => typeof item !== 'string' || !LEGACY_PLATFORMS.has(item))
        if (next.length !== quality.aiPlatforms.length) {
          changed = true
          if (next.length === 0) {
            delete quality.aiPlatforms
            delete quality.minUnlockLevel
          } else {
            quality.aiPlatforms = next
          }
        }
      }
      if (typeof quality.sortBy === 'string' && LEGACY_SORTS.has(quality.sortBy)) {
        delete quality.sortBy
        delete quality.sortReverse
        changed = true
      }
    }
  }
  return changed
}

function normalizeAiRecord(ai: Record<string, unknown>): { value: Record<string, unknown> | null; changed: boolean } {
  let changed = false
  for (const surface of LEGACY_SURFACES) {
    if (Object.hasOwn(ai, surface)) {
      delete ai[surface]
      changed = true
    }
  }
  const hasAnyCurrent = surfaces.some(s => isRecord(ai[s]))
  if (!hasAnyCurrent) {
    return { value: null, changed: true }
  }
  for (const surface of surfaces) {
    if (!isRecord(ai[surface])) {
      ai[surface] = { ...UNKNOWN_AI_READING }
      changed = true
    }
  }
  return { value: ai, changed }
}

function cleanReport(report: unknown): boolean {
  if (!isRecord(report) || !Array.isArray(report.results)) return false
  let changed = false
  for (const row of report.results) {
    if (!isRecord(row) || !isRecord(row.ai)) continue
    const normalized = normalizeAiRecord(row.ai)
    if (normalized.changed) {
      row.ai = normalized.value
      changed = true
    }
  }
  return changed
}

function cleanLatest(record: unknown): boolean {
  if (!isRecord(record) || !isRecord(record.ai) || !isRecord(record.ai.results)) return false
  const normalized = normalizeAiRecord(record.ai.results)
  if (!normalized.changed) return false
  record.ai.results = normalized.value
  return true
}

export function cleanupLegacyQualityData(store: Store): CleanupSummary {
  return store.transaction(() => {
    let updated = 0
    let removed = 0
    for (const [space, key, doc] of store.all()) {
      if (space.startsWith('quality-device/')) {
        if (key === 'registration' || key === 'next') {
          store.remove(space, key)
          removed++
        }
        continue
      }
      if (space.startsWith('quality-reports/')) {
        if (cleanReport(doc)) {
          store.set(space, key, doc)
          updated++
        }
        continue
      }
      if (space.startsWith('quality-latest/')) {
        if (cleanLatest(doc)) {
          store.set(space, key, doc)
          updated++
        }
        continue
      }
      if (space === 'profiles' && isRecord(doc)) {
        let changed = false
        if (Object.hasOwn(doc, 'fixedQualitySnapshot')) {
          delete doc.fixedQualitySnapshot
          changed = true
        }
        if (isRecord(doc.draft)) {
          if (Object.hasOwn(doc.draft, 'qualityBaselinePolicy')) {
            delete doc.draft.qualityBaselinePolicy
            changed = true
          }
          if (cleanGroups(doc.draft.groups)) changed = true
        }
        if (changed) {
          store.set<string, string>(space, key, doc)
          updated++
        }
        continue
      }
      if (space.startsWith('versions/') && isRecord(doc)) {
        let changed = false
        for (const field of ['qualitySnapshot', 'qualityReportId', 'qualityDeviceId'] as const) {
          if (Object.hasOwn(doc, field)) {
            delete doc[field]
            changed = true
          }
        }
        if (isRecord(doc.recipe)) {
          if (Object.hasOwn(doc.recipe, 'qualityBaselinePolicy')) {
            delete doc.recipe.qualityBaselinePolicy
            changed = true
          }
          if (cleanGroups(doc.recipe.groups)) changed = true
        }
        if (changed) {
          store.set<string, string>(space, key, doc)
          updated++
        }
        continue
      }
      if (space === 'system' && key === 'library' && isRecord(doc) && Array.isArray(doc.groups)) {
        let changed = false
        for (const template of doc.groups) {
          if (isRecord(template) && cleanGroups(template.groups)) changed = true
        }
        if (changed) {
          store.set<string, string>(space, key, doc)
          updated++
        }
      }
    }
    return { updated, removed }
  })
}
