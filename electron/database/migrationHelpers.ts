import type Database from 'better-sqlite3'

/**
 * 集中式列存在检查（D-09 / ARCH-01）。
 * 替代散落的 db.prepare("PRAGMA table_info(X)").all().some(c => c.name === Y) 模式。
 * 传入 db（不在内部调 getDatabase）以保持可测试 + 可在事务作用域内组合。
 */
export function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === col)
}
