import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'
// 读取失败时把损坏内容隔离到这里，原占用记录不会被覆盖丢失。
const QUARANTINE_KEY = `${STORAGE_KEY}:quarantine`

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 历史记录迁移：只补齐系统字段（id/status/pending/abnormal），业务字段一律保留原值。
function migrateRow(key: string, row: EntryRow): EntryRow {
  const meta = MODULE_BY_KEY.get(key)
  const lastStatus = meta ? meta.statuses[meta.statuses.length - 1] : ''
  const migrated: EntryRow = { ...row }
  if (typeof migrated.id !== 'number') {
    migrated.id = Number(migrated.id) || 0
  }
  if (typeof migrated.status !== 'string') {
    migrated.status = String(migrated.status ?? '')
  }
  if (typeof migrated.pending !== 'boolean') {
    migrated.pending = migrated.status !== lastStatus
  }
  if (typeof migrated.abnormal !== 'boolean') {
    migrated.abnormal = false
  }
  return migrated
}

function migrateModuleRows(key: string, value: unknown): EntryRow[] {
  if (!Array.isArray(value)) {
    return clone(SEED_ROWS[key] ?? [])
  }
  return value.map((row) => migrateRow(key, row as EntryRow))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    } catch {
      // 首次播种写不进去不阻塞只读打开，后续保存时再报写入失败
    }
    return fallback
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // 读取失败绝不覆盖原记录：损坏内容隔离到备份键，恢复或修复后可重试
    try {
      window.localStorage.setItem(QUARANTINE_KEY, raw)
    } catch {
      // 隔离备份也写不进去时，原始内容仍留在主键里，不做任何改动
    }
    throw new Error('本地数据读取失败，原占用记录已保留在隔离备份里，可恢复后重试')
  }
  const merged: Record<string, EntryRow[]> = { ...fallback }
  for (const [key, value] of Object.entries(parsed)) {
    merged[key] = migrateModuleRows(key, value)
  }
  return merged
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
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // 写入失败不更新缓存：内存与磁盘保持一致，本次修改视为未保存
      throw new Error('本地存储写入失败，本次修改未保存')
    }
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

export function quarantineKey(): string {
  return QUARANTINE_KEY
}
