<template>
  <section class="page" data-module="pipeline">
    <header class="page-head">
      <div>
        <h2>入廊管线登记</h2>
        <p class="page-desc">所属管廊停用后，入廊管线统一按停用口径提示：停止接入与运行确认，仅允许办理迁出。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记入廊管线</button>
        <button class="btn" type="button" @click="exportRows">导出入廊管线清单</button>
      </div>
    </header>

    <div v-if="stoppedTunnels.length" class="stop-banner">
      停用口径提示：管廊
      <strong v-for="tunnel in stoppedTunnels" :key="tunnel.管廊编号">
        {{ tunnel.管廊编号 }}（停用日 {{ tunnel.停用日期 }}）
      </strong>
      已停用，其下管线仅可办理迁出，处理意见以派工清单「停用告知单」为准。
    </div>

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
          <th>管廊停用口径</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td><span :class="['badge', row.status === '运行中' ? 'run' : row.status === '已迁出' ? 'idle' : 'repair']">{{ row.status }}</span></td>
          <td>
            <span v-if="hintOf(row)" class="badge stop" :title="hintOf(row)">所属管廊已停用</span>
            <span v-else class="page-desc">—</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in allowedActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!allowedActions(row).length" class="page-desc">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无入廊管线数据，可先登记入廊管线</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条入廊管线记录，停用口径与设备台账、环境监测取同一份</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  guardedRunAction,
  listEntries,
  listTunnels,
  moduleMeta,
  tunnelHintFor,
} from '@/api/local-service'
import { effectiveStatus } from '@/domain/tunnel-rules'
import type { TunnelRow } from '@/domain/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pipeline')
const columns = ['管线编号', '所属管廊', '所属舱室', '管线类型', '权属单位', '入廊日期', '迁出日期', '对接联系人', '管线状态']

const rows = ref<EntryRow[]>([])
const tunnels = ref<TunnelRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stoppedTunnels = computed(() => tunnels.value.filter((row) => effectiveStatus(row) === '已停用'))

const stats = computed(() => [
  { label: '运行中管线', value: rows.value.filter((row) => String(row.status) === '运行中').length },
  { label: '已入廊未运行', value: rows.value.filter((row) => String(row.status) === '已入廊').length },
  { label: '已迁出管线', value: rows.value.filter((row) => String(row.status) === '已迁出').length },
])

const statusSummary = computed(() =>
  ['待登记', '已入廊', '运行中', '已迁出'].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function hintOf(row: EntryRow): string {
  return tunnelHintFor('pipeline', String(row.所属管廊 ?? ''))
}

function isStopped(row: EntryRow): boolean {
  return hintOf(row) !== ''
}

/** 停用口径下只保留「办理迁出」，其余动作不展示；提交时服务端按同一口径再判一次。 */
function allowedActions(row: EntryRow): string[] {
  if (isStopped(row)) {
    return String(row.status) === '已迁出' ? [] : ['办理迁出']
  }
  const status = String(row.status)
  if (status === '待登记') return ['登记入廊']
  if (status === '已入廊') return ['确认运行', '办理迁出']
  if (status === '运行中') return ['办理迁出']
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '入廊管线登记入口尚未接入审批流；新增接入在所属管廊停用后不予受理。'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = guardedRunAction('pipeline', Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    tunnels.value = listTunnels()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入廊管线列表读取失败'
  }
}

onMounted(reload)
</script>
