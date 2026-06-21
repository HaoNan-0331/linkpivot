import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function initDatabase(): Database.Database {
  const dbPath = path.join(app.getPath('userData'), 'topology.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 1000')
  return db
}

export function closeDatabase() {
  if (db) { db.close(); db = null }
}
