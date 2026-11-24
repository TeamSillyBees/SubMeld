import { createContext, useContext } from 'react'
import { draftDataset, evaluate } from '../shared/config.ts'
import type { Draft, Issue, Projection, WorkspaceState } from '../shared/model.ts'
import type { ProbeDevice } from '../shared/quality.ts'
import type { LatestQualityMap, QualitySnapshot } from '../shared/quality-snapshot.ts'
import type { Call, LocalInput } from './api.ts'

export interface Route { page: string; id?: string; detail?: string; path: string; params: URLSearchParams }
export type View = Projection & { originalNodes: number }
export type Destination = [page: string, id?: string | null, detail?: string | null]
export type NavigationGuard = () => boolean | Promise<boolean>
export type Feedback = 'success' | 'warning' | 'danger' | 'info'
export type ProfileAction = 'switch' | 'rename' | 'delete' | 'create' | 'clone'
export type ChangeProfile = (action: ProfileAction, value?: string) => Promise<boolean>

export interface ProjectQuality {
  latest: LatestQualityMap
  devices: ProbeDevice[]
  deviceNames: Map<string, string>
  hasData: boolean
  ready: boolean
  error: string
  refresh: () => void
  snapshotFor: (deviceId?: string | null) => QualitySnapshot | null
}

export interface Project {
  quality: ProjectQuality
  state: WorkspaceState
  view: View
  route: Route
  running: boolean
  call: Call
  pathFor: (path: string, id?: string) => string
  hrefFor: (...destination: Destination) => string
  replaceSearch: (name: string, value: string) => void
  save: (draft: Draft, revision?: number, message?: string, localInputs?: Record<string, LocalInput>) => Promise<WorkspaceState>
  reload: (id?: string, background?: boolean) => Promise<void>
  applyState: (next: WorkspaceState, options?: { allowProfileSwitch?: boolean }) => boolean
  notify: (message: string, tone?: Feedback) => void
  navigate: (...destination: Destination) => Promise<boolean>
  jump: (issue: Pick<Issue, 'pane' | 'id' | 'relatedId'>) => Promise<boolean>
  setNavigationGuard: (handler: NavigationGuard | null) => () => void
}
export const ProjectContext = createContext<Project | null>(null)
export function useProject() {
  const project = useContext(ProjectContext)
  if (!project) throw new Error('A workspace must be open.')
  return project
}

export function useSearchValue(name: string, fallback = ''): [string, (value: string) => void] {
  const { route, replaceSearch } = useProject()
  return [route.params.get(name) ?? fallback, value => replaceSearch(name, value === fallback ? '' : value)]
}

export function projection(draft: Draft, state: WorkspaceState, quality: LatestQualityMap | null = null): View {
  const view = evaluate(draft,
    Object.fromEntries(Object.entries(state.sources).map(([id, record]) => [id, draftDataset(record)])),
    Object.fromEntries(Object.entries(state.providers).map(([id, record]) => [id, record.good])), false, quality)
  return { ...view, originalNodes: view.sources.reduce((total, source) => total + source.original, 0) }
}
