import type { Diff, Library, Note, Profile, ProviderData, RejectedItem, SourceData, SubscriptionInfo, UpdateLog, Version } from '../shared/model.ts'

import type { QualityNode, QualityReport } from '../shared/quality.ts'
import type { StoredDevice, StoredInvite, StoredQualityJob } from './quality.ts'

export type Dataset = SourceData | ProviderData
export interface StoredRecord<T extends Dataset = Dataset> {
  good?: T | null
  pending?: { accepted: boolean; data: SourceData; reason: string; diff: Diff | null } | null
  lastAttempt?: string
  lastSuccess?: string
  error?: string | null
  lastRejected?: RejectedItem[]
  subscriptionInfo?: SubscriptionInfo | null
}
export type Stored<S extends string, K extends string = string> =
  S extends `quality-device/${string}` ? (K extends 'registration' ? StoredDevice : K extends 'invite' ? StoredInvite : string) :
  S extends `quality-jobs/${string}` ? StoredQualityJob :
  S extends `quality-inputs/${string}` ? QualityNode[] :
  S extends `quality-reports/${string}` ? QualityReport :
  S extends 'profiles' ? Profile :
  S extends 'auth' ? { salt: string; hash: string } :
  S extends 'system' ? (K extends 'library' ? Library : string[]) :
  S extends `versions/${string}` ? Version :
  S extends `notes/${string}` ? Note :
  S extends `updates/${string}` ? UpdateLog :
  S extends `datasets/${string}` ? StoredRecord<K extends `source/${string}` ? SourceData : K extends `provider/${string}` ? ProviderData : Dataset> :
  unknown
export type DocumentRow = [space: string, key: string, value: unknown]
