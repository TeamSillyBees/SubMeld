import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function openStore(directory) {
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
  const listeners = new Set()
  function write(statement, space, ...values) {
    const result = statement.run(space, ...values)
    for (const listener of listeners) listener(space, values[0])
    return result
  }

  return {
    get: (space, key) => JSON.parse(get.get(space, String(key))?.data ?? 'null'),
    set: (space, key, value) => write(set, space, String(key), JSON.stringify(value)),
    list: (space, limit = -1, offset = 0) => list.all(space, limit, offset).map(row => [row.key, JSON.parse(row.data)]),
    history: (space, limit, offset) => versionSummaries.all(space, limit, offset).map(row => JSON.parse(row.data)),
    all: () => all.all().map(({ space, key, data }) => [space, key, JSON.parse(data)]),
    remove: (space, key) => write(remove, space, String(key)),
    clear: space => write(clear, space),
    onWrite(listener) { listeners.add(listener) },
    transaction(change) {
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
