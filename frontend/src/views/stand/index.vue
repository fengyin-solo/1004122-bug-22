<template>
  <section class="page" data-module="stand">
    <header class="page-head">
      <div>
        <h2>机位分配管理</h2>
        <p class="page-desc">维护机位分配，围绕机位编号、机位类型、所属航站楼、匹配航班做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记机位分配</button>
        <button class="btn" type="button" @click="exportRows">导出机位分配清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ cellText(row, column) }}</td>
          <td>
            {{ row.status }}
            <span v-if="isAbnormal(row)" class="abnormal-tag">异常</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length && loadFailed">
          <td :colspan="columns.length + 2" class="empty-state">
            机位分配列表读取失败，筛选条件已保留
            <button class="link" type="button" @click="reload">重试</button>
          </td>
        </tr>
        <tr v-else-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机位分配数据，可先登记机位分配</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条机位分配记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  isRowAbnormal,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('stand')
const columns = ["机位编号", "机位类型", "所属航站楼", "匹配航班", "计划占用", "实际占用", "分配状态", "备注说明"]
const actions = ["分配机位", "确认占用", "释放机位"]
const statuses = ["空闲", "已分配", "占用中", "已释放"]
const stats = [{"label": "空闲机位", "value": 0}, {"label": "占用中机位", "value": 0}, {"label": "已分配机位", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const loadFailed = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function cellText(row: EntryRow, column: string): string {
  const value = row[column]
  // 缺归属等空值统一给占位，不留空白
  return value === undefined || value === null || String(value).trim() === '' ? '—' : String(value)
}

function isAbnormal(row: EntryRow): boolean {
  return isRowAbnormal(meta.key, row)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '机位分配登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadFailed.value = false
  } catch (error) {
    // 读取失败保留已加载的记录和当前筛选，只标记失败，允许重试
    loadFailed.value = true
    errorMessage.value = error instanceof Error ? error.message : '机位分配列表读取失败'
  }
}

onMounted(reload)
</script>
