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
      <span class="legend-item abnormal">异常：{{ abnormalCount }}</span>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="isAbnormal(row)" class="tag-abnormal">异常</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
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
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机位分配数据，可先登记机位分配</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detailVisible" class="detail-panel">
      <header class="detail-head">
        <h3>机位分配详情</h3>
        <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
      </header>
      <p v-if="detailError" class="error-text">
        {{ detailError }}
        <button class="link" type="button" @click="retryDetail">重试</button>
      </p>
      <template v-else-if="detailRow">
        <dl class="detail-grid">
          <div v-for="column in columns" :key="column" class="detail-item">
            <dt>{{ column }}</dt>
            <dd :class="{ 'empty-state': isBlank(detailRow[column]) }">
              {{ isBlank(detailRow[column]) ? `暂无${column}信息` : detailRow[column] }}
            </dd>
          </div>
        </dl>
        <p class="detail-status">
          当前状态：{{ detailRow.status }}
          <span v-if="detailAbnormal" class="tag-abnormal">异常</span>
        </p>
        <p v-if="isBlank(detailRow['所属航站楼'])" class="empty-state">
          该记录缺少所属航站楼归属，已按统一异常判定标记，请补录归属后再流转
        </p>
      </template>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条机位分配记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">
        {{ errorMessage }}
        <button class="link" type="button" @click="retryLast">重试</button>
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  isAbnormalRow,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('stand')
const columns = ["机位编号", "机位类型", "所属航站楼", "匹配航班", "计划占用", "实际占用", "分配状态", "备注说明"]
const actions = ["分配机位", "确认占用", "释放机位"]
const statuses = ["空闲", "已分配", "占用中", "已释放"]
const stats = [{"label": "空闲机位", "value": 0}, {"label": "占用中机位", "value": 0}, {"label": "已分配机位", "value": 0}]

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const abnormalCount = computed(
  () => rows.value.filter((row) => isAbnormalRow(meta.key, row)).length,
)

const detailVisible = ref(false)
const detailRow = ref<EntryRow | null>(null)
const detailError = ref('')
const detailId = ref<number | null>(null)
const detailAbnormal = computed(() =>
  detailRow.value ? isAbnormalRow(meta.key, detailRow.value) : false,
)
// 失败时记下未完成的动作，重试从这条待定位记录继续，而不是从头再来
const lastFailed = ref<{ action: string; id: number } | null>(null)

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

function isAbnormal(row: EntryRow): boolean {
  return isAbnormalRow(meta.key, row)
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

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
  detailVisible.value = true
  loadDetail()
}

function closeDetail() {
  detailVisible.value = false
  detailRow.value = null
  detailError.value = ''
  detailId.value = null
}

function loadDetail() {
  detailError.value = ''
  try {
    detailRow.value = getEntry(meta.key, Number(detailId.value))
  } catch (error) {
    detailRow.value = null
    detailError.value = error instanceof Error ? error.message : '机位分配详情读取失败'
  }
}

function retryDetail() {
  loadDetail()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, session.actionContext)
  if (!result.ok) {
    errorMessage.value = result.message
    lastFailed.value = { action, id: Number(row.id) }
    return
  }
  lastFailed.value = null
  noticeMessage.value = result.message
  reload()
  if (detailVisible.value && detailId.value === Number(row.id)) {
    loadDetail()
  }
}

function retryLast() {
  const pending = lastFailed.value
  if (!pending) {
    reload()
    return
  }
  errorMessage.value = ''
  const result = applyAction(meta.key, pending.id, pending.action, session.actionContext)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  lastFailed.value = null
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 保留原筛选：读取失败只提示，已填的筛选条件不动
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '机位分配列表读取失败'
  }
}

onMounted(reload)
</script>
