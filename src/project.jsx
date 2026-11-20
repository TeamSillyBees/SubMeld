import { createContext, useContext } from 'react'
import { draftDataset, evaluate } from '../shared/config.js'

export const ProjectContext = createContext(null)
export const useProject = () => useContext(ProjectContext)

export function useSearchValue(name, fallback = '') {
  const { route, replaceSearch } = useProject()
  return [route.params.get(name) ?? fallback, value => replaceSearch(name, value === fallback ? '' : value)]
}

export function projection(draft, state) {
  const view = evaluate(draft,
    Object.fromEntries(Object.entries(state.sources).map(([id, record]) => [id, draftDataset(record)])),
    Object.fromEntries(Object.entries(state.providers).map(([id, record]) => [id, record.good])))
  return { ...view, originalNodes: view.sources.reduce((total, source) => total + source.original, 0) }
}
