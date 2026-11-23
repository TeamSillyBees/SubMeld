import type { SourceRecord, WorkspaceState } from '../shared/model.ts'
import type { ResponseFor } from './api.ts'
import { asError } from './errors.ts'

type SyncPath = 'status' | 'state?nodes=0' | `source-nodes?id=${string}`
export type ReadWorkspace = <P extends SyncPath>(path: P) => Promise<ResponseFor<P>>

export async function refreshWorkspace(previous: WorkspaceState, get: ReadWorkspace): Promise<WorkspaceState> {
  const status = await get('status')
  if (status.statusVersion === previous.statusVersion) return previous

  const next = status.metadataVersion === previous.metadataVersion
    ? status
    : await get('state?nodes=0')
  const sources = await Promise.all(Object.entries(next.sources).map(async ([id, record]): Promise<[string, SourceRecord] | null> => {
    const existing = previous.sources[id]
    let good = null
    let candidate = null
    if (record.nodesVersion && record.nodesVersion === existing?.nodesVersion) {
      good = existing.good
      candidate = existing.pending?.data
    } else if (record.nodesVersion) {
      let data
      try { data = await get(`source-nodes?id=${encodeURIComponent(id)}`) }
      catch (error) {
        if (asError(error).status === 404) return null
        throw error
      }
      // A refresh, source edit or restore can land between the two requests.
      if (data.nodesVersion !== record.nodesVersion) return null
      good = data.good
      candidate = data.candidate
    }
    const pending = record.pending?.accepted ? { ...record.pending, data: candidate } : record.pending
    return [id, { ...record, good, pending }]
  }))
  if (sources.includes(null)) return previous
  return { ...previous, ...next, sources: Object.fromEntries(sources.filter(entry => entry !== null)) }
}
