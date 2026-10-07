<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>设备台账管理</h2>
        <p class="page-desc">所属管廊停用后，在册设备统一按停用口径提示：停止登记与保养排程，仅允许报废或随管线迁出调拨。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管廊设备</button>
        <button class="btn" type="button" @click="exportRows">导出设备台账清单</button>
      </div>
    </header>

    <div v-if="stoppedTunnels.length" class="stop-banner">
      停用口径提示：管廊
      <strong v-for="tunnel in stoppedTunnels" :key="tunnel.管廊编号">
        {{ tunnel.管廊编号 }}（停用日 {{ tunnel.停用日期 }}）
      </strong>
      已停用，其下在册设备仅可办理报废，保养计划自动撤销，停用口径与环境监测两侧同源。
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
          <td><span :class="['badge', row.status === '运行中' ? 'run' : row.status === '已报废' ? 'idle' : 'repair']">{{ row.status }}</span></td>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无设备台账数据，可先登记管廊设备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条在册设备记录，停用口径与管线、环境监测取同一份</span>
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

const meta = moduleMeta('device')
const columns = ['设备编号', '设备名称', '设备型号', '所属管廊', '所属舱室', '投运日期', '保养周期', '上次保养日', '设备状态']

const rows = ref<EntryRow[]>([])
const tunnels = ref<TunnelRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stoppedTunnels = computed(() => tunnels.value.filter((row) => effectiveStatus(row) === '已停用'))

const stats = computed(() => [
  { label: '运行中设备', value: rows.value.filter((row) => String(row.status) === '运行中').length },
  { label: '待保养设备', value: rows.value.filter((row) => String(row.status) === '待保养').length },
  { label: '已报废设备', value: rows.value.filter((row) => String(row.status) === '已报废').length },
])

const statusSummary = computed(() =>
  ['待保养', '运行中', '已保养', '已报废'].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function hintOf(row: EntryRow): string {
  return tunnelHintFor('device', String(row.所属管廊 ?? ''))
}

/** 停用口径下只保留「报废设备」；提交时服务端按同一口径再判一次。 */
function allowedActions(row: EntryRow): string[] {
  const stopped = hintOf(row) !== ''
  if (String(row.status) === '已报废') return []
  if (stopped) return ['报废设备']
  const status = String(row.status)
  if (status === '待保养') return ['登记运行', '报废设备']
  if (status === '运行中') return ['完成保养', '报废设备']
  if (status === '已保养') return ['登记运行', '报废设备']
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
  errorMessage.value = '管廊设备登记入口尚未接入审批流；所属管廊停用后新增登记不予受理。'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = guardedRunAction('device', Number(row.id), action)
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
    errorMessage.value = error instanceof Error ? error.message : '设备台账列表读取失败'
  }
}

onMounted(reload)
</script>
