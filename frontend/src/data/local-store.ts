import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'
// 读取失败时原数据的避难所：损坏快照挪到这里，绝不直接覆盖掉原记录。
const BACKUP_KEY = `${STORAGE_KEY}:backup`

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 历史记录迁移：旧版本存进来的记录可能缺字段，按模块元数据补默认值。
// 只补缺失的字段，记录里已有的取值（状态、占用信息、异常标记）一律保留原值。
function migrateRows(key: string, rows: EntryRow[]): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  const lastStatus = meta?.statuses[meta.statuses.length - 1]
  return rows.map((row, index) => ({
    ...row,
    id: typeof row.id === 'number' ? row.id : index + 1,
    status:
      typeof row.status === 'string' && row.status !== ''
        ? row.status
        : (meta?.statuses[0] ?? ''),
    pending:
      typeof row.pending === 'boolean' ? row.pending : String(row.status ?? '') !== lastStatus,
    abnormal: typeof row.abnormal === 'boolean' ? row.abnormal : false,
  }))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged: Record<string, EntryRow[]> = { ...fallback }
    for (const [key, rows] of Object.entries(parsed)) {
      merged[key] = migrateRows(key, Array.isArray(rows) ? rows : [])
    }
    return merged
  } catch {
    // 读取失败不清空原占用记录：损坏快照备份到 BACKUP_KEY 留待恢复，内存里先用示例数据顶着。
    window.localStorage.setItem(BACKUP_KEY, raw)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  // 先落库再换缓存：写入失败时缓存保持原样，记录维持待定位，下次从这里继续。
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
