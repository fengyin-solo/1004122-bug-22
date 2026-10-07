import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import { useSessionStore } from '@/stores/session'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 统一异常判定：除了动作打标（abnormal），业务一致性规则命中也算异常。
// 列表、看板、状态流转共用这一个入口，不再各页面各算各的。
const INTEGRITY_RULES: Record<string, (row: EntryRow) => boolean> = {
  stand: (row) => {
    if (!String(row['所属航站楼'] ?? '').trim()) {
      return true // 缺所属航站楼归属
    }
    const status = String(row.status)
    const flight = String(row['匹配航班'] ?? '').trim()
    // 没有匹配航班，状态却挂在已分配/占用中
    return (status === '已分配' || status === '占用中') && !flight
  },
}

export function isRowAbnormal(key: string, row: EntryRow): boolean {
  if (row.abnormal) {
    return true
  }
  const rule = INTEGRITY_RULES[key]
  return rule ? rule(row) : false
}

// 越权拦截：写操作只认当前值班会话的权限；拿不到会话（离线脚本等场景）不拦。
function operateAllowed(): boolean {
  try {
    return useSessionStore().canOperate
  } catch {
    return true
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
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

type SyncOutcome = { synced: number; pending: number }

type SyncHandler = {
  label: string
  run: (row: EntryRow) => SyncOutcome
}

// 跨模块联动：「模块 → 动作」生效后，把结论同步到别的模块。
// 逐条定位、逐条落库：已带过结论的跳过（重复动作只生效一次），
// 写失败的留作待定位记录，下次同一动作从待定位记录继续处理。
const ACTION_SYNC: Record<string, Record<string, SyncHandler>> = {
  stand: {
    释放机位: { label: '航班保障清单', run: syncStandReleaseToFlightOps },
  },
}

function runSync(key: string, action: string, row: EntryRow): (SyncOutcome & { label: string }) | null {
  const handler = ACTION_SYNC[key]?.[action]
  if (!handler) {
    return null
  }
  return { ...handler.run(row), label: handler.label }
}

function syncStandReleaseToFlightOps(stand: EntryRow): SyncOutcome {
  const flightNo = String(stand['匹配航班'] ?? '').trim()
  if (!flightNo) {
    return { synced: 0, pending: 0 }
  }
  const standNo = String(stand['机位编号'] ?? '').trim() || `#${stand.id}`
  const conclusion = `机位${standNo}已释放`
  const targets = listRows('flight_ops').filter(
    (row) => String(row['航班号'] ?? '').trim() === flightNo,
  )
  let synced = 0
  let pending = 0
  for (const target of targets) {
    const rows = listRows('flight_ops')
    const index = rows.findIndex((row) => Number(row.id) === Number(target.id))
    if (index < 0) {
      pending += 1
      continue
    }
    const node = String(rows[index]['保障节点'] ?? '').trim()
    if (node.includes(conclusion)) {
      continue // 这条已同步过，跳过
    }
    const next = [...rows]
    next[index] = {
      ...rows[index],
      保障节点: node ? `${node}；${conclusion}` : conclusion,
      pending: true,
      abnormal: true,
    }
    try {
      saveRows('flight_ops', next)
      synced += 1
    } catch {
      pending += 1 // 写失败：保持待定位，下次从这里继续
    }
  }
  return { synced, pending }
}

function describeSync(sync: SyncOutcome & { label: string }): string {
  const parts: string[] = []
  if (sync.synced > 0) {
    parts.push(`已同步${sync.label} ${sync.synced} 条`)
  }
  if (sync.pending > 0) {
    parts.push(`${sync.pending} 条待定位记录留待继续处理`)
  }
  return parts.length ? `；${parts.join('，')}` : ''
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  if (!operateAllowed()) {
    return { ok: false, message: `当前值班会话无权修改${meta.entity}，操作已被拦截` }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    // 重复动作只生效一次：记录不再改；若联动同步有遗留，从待定位记录继续处理。
    const resumed = runSync(key, action, rows[index])
    if (resumed && (resumed.synced > 0 || resumed.pending > 0)) {
      return {
        ok: resumed.pending === 0,
        message: `${meta.entity}已经是「${target}」，不重复流转${describeSync(resumed)}`,
      }
    }
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    // 异常标记保留原值：历史打标不被后续动作冲掉，只增不减
    abnormal:
      Boolean(rows[index].abnormal) || NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch {
    return {
      ok: false,
      message: `${meta.entity}${action}写入失败，记录保持「${current}」待定位，可继续处理`,
    }
  }
  const sync = runSync(key, action, updated)
  const suffix = sync ? describeSync(sync) : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
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
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

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
      abnormal: entries.filter((row) => isRowAbnormal(meta.key, row)).length,
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
