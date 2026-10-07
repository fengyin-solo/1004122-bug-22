import { defineStore } from 'pinia'

import type { ActionContext } from '@/data/types'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '机场地面保障调度管理系统',
    // 授权范围：空数组 = 不限模块，空串 = 不限航站楼；一旦配置，写操作越权即被拦截
    allowedModules: [] as string[],
    terminalScope: '',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    actionContext: (state): ActionContext => ({
      operator: state.operator,
      allowedModules: state.allowedModules.length ? [...state.allowedModules] : undefined,
      terminalScope: state.terminalScope || undefined,
    }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
