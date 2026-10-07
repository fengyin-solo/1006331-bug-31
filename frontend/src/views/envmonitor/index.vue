<template>
  <section class="page" data-module="envmonitor">
    <header class="page-head">
      <div>
        <h2>廊内环境监测</h2>
        <p class="page-desc">所属管廊停用后，监测点位统一按停用口径冻结：停止例行采集与正常/超标判定，仅保留封存前最后一次采集。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记环境监测记录</button>
        <button class="btn" type="button" @click="exportRows">导出廊内环境监测清单</button>
      </div>
    </header>

    <div v-if="stoppedTunnels.length" class="stop-banner">
      停用口径提示：管廊
      <strong v-for="tunnel in stoppedTunnels" :key="tunnel.管廊编号">
        {{ tunnel.管廊编号 }}（停用日 {{ tunnel.停用日期 }}）
      </strong>
      已停用，其下监测点冻结采集与指标判定，停用读数不计入考核；本侧与设备台账读到同一份停用口径。
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
          <td><span :class="['badge', row.status === '指标正常' ? 'run' : row.status === '指标超标' ? 'stop' : 'repair']">{{ row.status }}</span></td>
          <td>
            <span v-if="hintOf(row)" class="badge stop" :title="hintOf(row)">监测点已冻结</span>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无廊内环境监测数据，可先登记环境监测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条环境监测记录，停用口径与入廊管线、设备台账取同一份</span>
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

const meta = moduleMeta('envmonitor')
const columns = ['监测编号', '所属管廊', '监测点位', '环境温度', '空气湿度', '氧气浓度', '有害气体浓度', '采集时间', '监测状态']

const rows = ref<EntryRow[]>([])
const tunnels = ref<TunnelRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stoppedTunnels = computed(() => tunnels.value.filter((row) => effectiveStatus(row) === '已停用'))

const stats = computed(() => [
  { label: '指标正常点位', value: rows.value.filter((row) => String(row.status) === '指标正常' && !tunnelHintFor('envmonitor', String(row.所属管廊))).length },
  { label: '指标超标点位', value: rows.value.filter((row) => String(row.status) === '指标超标').length },
  { label: '停用冻结点位', value: rows.value.filter((row) => tunnelHintFor('envmonitor', String(row.所属管廊))).length },
])

const statusSummary = computed(() =>
  ['待采集', '已采集', '指标正常', '指标超标'].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function hintOf(row: EntryRow): string {
  return tunnelHintFor('envmonitor', String(row.所属管廊 ?? ''))
}

/** 停用口径下监测点冻结：任何采集/判定动作都不展示，提交时服务端也会按同一口径驳回。 */
function allowedActions(row: EntryRow): string[] {
  if (hintOf(row)) return []
  const status = String(row.status)
  if (status === '待采集') return ['提交采集']
  if (status === '已采集') return ['判定正常', '标记超标']
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
  errorMessage.value = '环境监测记录登记入口尚未接入审批流；所属管廊停用后监测点冻结，不予登记。'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = guardedRunAction('envmonitor', Number(row.id), action)
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
    errorMessage.value = error instanceof Error ? error.message : '廊内环境监测列表读取失败'
  }
}

onMounted(reload)
</script>
