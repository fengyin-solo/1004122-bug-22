import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionContext,
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 机位释放后要同步的航班保障清单：按「匹配航班 = 航班号」对齐，把释放结论写进保障节点。
const RELEASE_SYNC = {
  sourceKey: 'stand',
  action: '释放机位',
  targetKey: 'flight_ops',
  sourceField: '匹配航班',
  targetField: '航班号',
  conclusionField: '保障节点',
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 统一异常判定：列表、详情、概览共用这一套——
// 动作标记过异常、必填归属字段缺失、或状态越过初始态但关联航班仍为空，命中其一即异常。
export function isAbnormalRow(key: string, row: EntryRow): boolean {
  if (row.abnormal) {
    return true
  }
  const meta = moduleMeta(key)
  if ((meta.requiredFields ?? []).some((field) => isBlank(row[field]))) {
    return true
  }
  const pastInitial = String(row.status) !== meta.statuses[0]
  if (pastInitial && (meta.linkFields ?? []).some((field) => isBlank(row[field]))) {
    return true
  }
  return false
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow {
  const meta = moduleMeta(key)
  const row = listRows(key).find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`没有读到编号为 ${id} 的${meta.entity}，可稍后重试`)
  }
  return row
}

// 释放机位 → 航班保障清单同步计划：命中同一航班号的保障记录写入释放结论，
// 结论已存在的记录原样跳过，重复释放只生效一次。
function planReleaseSync(
  key: string,
  action: string,
  updated: EntryRow,
): { key: string; rows: EntryRow[]; changed: number } | null {
  if (key !== RELEASE_SYNC.sourceKey || action !== RELEASE_SYNC.action) {
    return null
  }
  const flightNo = String(updated[RELEASE_SYNC.sourceField] ?? '').trim()
  if (!flightNo) {
    return null
  }
  const conclusion = `机位已释放（${String(updated['机位编号'] ?? updated.id)}）`
  const rows = listRows(RELEASE_SYNC.targetKey)
  let changed = 0
  const nextRows = rows.map((row) => {
    if (String(row[RELEASE_SYNC.targetField] ?? '').trim() !== flightNo) {
      return row
    }
    if (row[RELEASE_SYNC.conclusionField] === conclusion) {
      return row
    }
    changed += 1
    return { ...row, [RELEASE_SYNC.conclusionField]: conclusion }
  })
  return { key: RELEASE_SYNC.targetKey, rows: nextRows, changed }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  context: ActionContext = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 越权拦截：值班人未登记、模块不在授权范围内，一律不允许写
  if (context.operator !== undefined && context.operator.trim() === '') {
    return { ok: false, message: `越权修改已拦截：未登记值班人，不能操作${meta.name}` }
  }
  if (context.allowedModules && !context.allowedModules.includes(key)) {
    return { ok: false, message: `越权修改已拦截：当前值班人没有${meta.name}的操作权限` }
  }
  let rows: EntryRow[]
  try {
    rows = listRows(key)
  } catch (error) {
    return {
      ok: false,
      message: `${meta.entity}读取失败：${messageOf(error)}，原记录未改动，可从待定位记录继续`,
    }
  }
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const record = rows[index]
  // 越权拦截：机位归属的航站楼不在当前值班范围内时不允许改
  if (
    context.terminalScope &&
    meta.fields.includes('所属航站楼') &&
    !String(record['所属航站楼'] ?? '').includes(context.terminalScope)
  ) {
    return {
      ok: false,
      message: `越权修改已拦截：该${meta.entity}归属「${String(record['所属航站楼'] ?? '') || '未登记'}」，不在当前值班范围「${context.terminalScope}」内`,
    }
  }
  const current = String(record.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...record,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  let syncNote = ''
  try {
    const syncPlan = planReleaseSync(key, action, updated)
    saveRows(key, next)
    if (syncPlan && syncPlan.changed > 0) {
      saveRows(syncPlan.key, syncPlan.rows)
      syncNote = `，已同步${syncPlan.changed}条航班保障记录`
    }
  } catch (error) {
    // 写入或同步失败：回滚到原记录，保持待处理状态，重试可从这条待定位记录继续
    try {
      saveRows(key, rows)
    } catch {
      // 回滚也失败时原始内容仍在隔离备份里，不重复抛错盖住原因
    }
    return {
      ok: false,
      message: `${meta.entity}${action}失败：${messageOf(error)}，记录保持待处理，可从待定位记录继续`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${syncNote}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => isAbnormalRow(meta.key, row)).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
