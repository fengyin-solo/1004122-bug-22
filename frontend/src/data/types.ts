/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 统一异常判定：必填字段为空即异常（如所属航站楼归属缺失）
  requiredFields?: string[]
  // 统一异常判定：状态越过初始态后，关联字段仍为空即异常（如已分配但没有匹配航班）
  linkFields?: string[]
}

export type ActionContext = {
  operator?: string
  allowedModules?: string[]
  terminalScope?: string
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
