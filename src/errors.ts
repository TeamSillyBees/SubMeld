import type { Projection, SourceData } from '../shared/model.ts'

export interface RequestError extends Error {
  status?: number
  detail?: SourceData | Projection | { id: string }
}

export function asError(cause: unknown): RequestError {
  return cause instanceof Error ? cause : new Error(String(cause))
}
