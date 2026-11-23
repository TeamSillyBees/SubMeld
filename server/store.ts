import type { Stored, DocumentRow } from './records.ts'
import type { VersionSummary } from '../shared/model.ts'
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type Store = ReturnType<typeof openStore>

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = join(directory, 'submeld.sqlite')
  const db = new DatabaseSync(filename)
  chmodSync(filename, 0o600)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS documents (
      space TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (space, key)
    ) WITHOUT ROWID;
  `)
  const get = db.prepare('SELECT data FROM documents WHERE space = ? AND key = ?')
  const set = db.prepare('INSERT INTO documents VALUES (?, ?, ?) ON CONFLICT(space,key) DO UPDATE SET data = excluded.data')
  const list = db.prepare('SELECT key, data FROM documents WHERE space = ? ORDER BY key DESC LIMIT ? OFFSET ?')
  const all = db.prepare('SELECT space, key, data FROM documents ORDER BY space, key')
  const remove = db.prepare('DELETE FROM documents WHERE space = ? AND key = ?')
  const clear = db.prepare('DELETE FROM documents WHERE space = ?')
  const versionSummaries = db.prepare(`
    SELECT json_remove(data, '$.yaml', '$.recipe', '$.view') AS data
    FROM documents WHERE space = ? ORDER BY key DESC LIMIT ? OFFSET ?
  `)
  const listeners = new Set<(space?: string, key?: string) => void>()
  function write(statement: StatementSync, space: string, ...values: SQLInputValue[]) {
    const result = statement.run(space, ...values)
    for (const listener of listeners) listener(space, typeof values[0] === 'string' ? values[0] : undefined)
    return result
  }

  return {
    get: <S extends string, K extends string>(space: S, key: K): Stored<S, K> | null => JSON.parse(String(get.get(space, key)?.data ?? 'null')),
    set: <S extends string, K extends string>(space: S, key: K, value: Stored<S, K>) => write(set, space, String(key), JSON.stringify(value)),
    list: <S extends string>(space: S, limit = -1, offset = 0): [string, Stored<S>][] => list.all(space, limit, offset).map(row => [String(row.key), JSON.parse(String(row.data))]),
    history: (space: string, limit: number, offset: number): VersionSummary[] => versionSummaries.all(space, limit, offset).map(row => JSON.parse(String(row.data))),
    all: (): DocumentRow[] => all.all().map(({ space, key, data }) => [String(space), String(key), JSON.parse(String(data))]),
    remove: (space: string, key: string) => write(remove, space, String(key)),
    clear: (space: string) => write(clear, space),
    onWrite(listener: (space?: string, key?: string) => void) { listeners.add(listener) },
    transaction<T>(change: () => T) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = change()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        for (const listener of listeners) listener()
        throw error
      }
    },
    close() {
      listeners.clear()
      db.close()
    },
  }
}
