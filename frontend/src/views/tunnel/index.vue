<template>
  <section class="page" data-module="tunnel">
    <header class="page-head">
      <div>
        <h2>管廊主体台账管理</h2>
        <p class="page-desc">统一口径 v2：投运按投运日期判定，检修按检修区间判定，停用按停用生效日判定（终态，与管线迁出无关）；列表、详情、页脚统计同取一份结论。新口径仅对新记录生效，既有记录保留原判。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记综合管廊</button>
        <button class="btn" type="button" @click="exportRows">导出管廊主体台账清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <details class="policy-box" open>
      <summary>管廊主体判定标准与允许区间（唯一口径，越界统一驳回）</summary>
      <ul class="policy-list">
        <li><b>运行中</b>：投运日期 ≤ 今日（投运时间只按投运日期算，停用不再按管线迁出算）。</li>
        <li><b>检修中</b>：检修起始日 ≤ 今日 ≤ 检修截止日（默认工期 7 天，允许 1–180 天）。</li>
        <li><b>已停用</b>：停用生效日 ≤ 今日，终态、优先级最高；同一管廊重复停用只生效一次。</li>
        <li><b>待投运</b>：未登记投运日期，或投运日期在未来。</li>
        <li><b>舱室数量</b>：整数 {{ limits.chambers.min }}–{{ limits.chambers.max }}，默认 {{ limits.chambers.default }}；填 0 或越界直接驳回。总长度 {{ limits.lengthMeters.min }}–{{ limits.lengthMeters.max }} 米，最多 {{ limits.lengthMeters.decimals }} 位小数。</li>
        <li>停用后入廊管线 / 在册设备 / 环境监测读到同一份停用口径，处理意见同时回写「设施检修管理」与「入廊作业审批」派工清单。</li>
      </ul>
    </details>

    <p v-if="backfill" class="backfill-box">
      存量补录已于 {{ backfill.runAt.slice(0, 10) }} 执行：纸质老记录整批补录 {{ backfill.paperBackfilled }} 条，
      电子记录缺项回填 {{ backfill.legacyFilled }} 条；图纸口径补舱数 {{ backfill.chambersFromDrawing }} 条，
      图纸缺项临时按默认 {{ limits.chambers.default }} 补 {{ backfill.chambersMissing }} 条（已单独标来源，待核定）。
      <button class="link" type="button" @click="showReport = !showReport">{{ showReport ? '收起明细' : '展开明细' }}</button>
    </p>
    <ul v-if="showReport && backfill" class="backfill-detail">
      <li v-for="(note, i) in backfill.notes" :key="i">{{ note }}</li>
    </ul>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="onSearch">
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
          <th>当前状态（统一口径）</th>
          <th>判定依据</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="['status-tag', `st-${row.verdict.status}`]">{{ row.verdict.status }}</span>
            <span class="version-tag">{{ row.verdict.policy === 'v1' ? 'v1 原判' : 'v2' }}</span>
          </td>
          <td class="reason-cell">{{ row.verdict.reason }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button class="link" type="button" @click="runAction('提交投运', row)">提交投运</button>
            <button class="link" type="button" @click="openRepair(row)">安排检修</button>
            <button class="link" type="button" @click="openStop(row)">停用管廊</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无管廊主体台账数据，可先登记综合管廊</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管廊记录 · 在运管廊 {{ stats[TUNNEL_STATUS.running] ?? 0 }} 座 · 检修中 {{ stats[TUNNEL_STATUS.repairing] ?? 0 }} 座 · 已停用 {{ stats[TUNNEL_STATUS.stopped] ?? 0 }} 座（按统一口径实算）</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记表单 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <form class="modal" @submit.prevent="submitCreate">
        <h3>登记综合管廊（v2 口径）</h3>
        <p class="modal-hint">舱室数量默认 {{ limits.chambers.default }}，允许整数 {{ limits.chambers.min }}–{{ limits.chambers.max }}；超范围整单驳回。</p>
        <label class="modal-field"><span>管廊编号 *</span><input v-model="form.tunnelNo" placeholder="如 TUNN-1001" /></label>
        <label class="modal-field"><span>管廊名称 *</span><input v-model="form.tunnelName" /></label>
        <label class="modal-field"><span>所属片区 *</span><input v-model="form.district" /></label>
        <label class="modal-field">
          <span>舱室数量 *（{{ limits.chambers.min }}–{{ limits.chambers.max }} 整数）</span>
          <input v-model="form.chambers" type="number" :min="limits.chambers.min" :max="limits.chambers.max" :placeholder="`默认 ${limits.chambers.default}`" />
        </label>
        <label class="modal-field">
          <span>总长度（米，{{ limits.lengthMeters.min }}–{{ limits.lengthMeters.max }}）</span>
          <input v-model="form.lengthMeters" type="number" step="0.01" placeholder="如 1280.50" />
        </label>
        <label class="modal-field"><span>结构类型</span><input v-model="form.structure" placeholder="如 钢筋混凝土结构" /></label>
        <label class="modal-field"><span>投运日期 *</span><input v-model="form.commissionDate" type="date" /></label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">提交登记</button>
          <button class="btn ghost" type="button" @click="creating = false">取消</button>
        </div>
      </form>
    </div>

    <!-- 停用确认 -->
    <div v-if="stopping" class="modal-mask" @click.self="stopping = null">
      <form class="modal" @submit.prevent="submitStop">
        <h3>停用管廊：{{ stopping.管廊名称 }}（{{ stopping.管廊编号 }}）</h3>
        <p class="modal-hint">停用为终态，生效后入廊管线/在册设备/环境监测统一按停用口径提示，处理意见同步两处派工清单。同一管廊重复停用只生效一次。</p>
        <label class="modal-field">
          <span>停用生效日 *（不得晚于今日 {{ today }}）</span>
          <input v-model="stopDateInput" type="date" :max="today" />
        </label>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">确认停用</button>
          <button class="btn ghost" type="button" @click="stopping = null">取消</button>
        </div>
      </form>
    </div>

    <!-- 安排检修 -->
    <div v-if="repairing" class="modal-mask" @click.self="repairing = null">
      <form class="modal" @submit.prevent="submitRepair">
        <h3>安排检修：{{ repairing.管廊名称 }}（{{ repairing.管廊编号 }}）</h3>
        <label class="modal-field"><span>检修起始日 *</span><input v-model="repairStartInput" type="date" :min="today" /></label>
        <label class="modal-field"><span>检修截止日 *（工期允许 {{ limits.repairDays.min }}–{{ limits.repairDays.max }} 天）</span><input v-model="repairEndInput" type="date" /></label>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">确认安排</button>
          <button class="btn ghost" type="button" @click="repairing = null">取消</button>
        </div>
      </form>
    </div>

    <!-- 详情面板 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal modal-wide">
        <h3>管廊详情：{{ detail.row.管廊名称 }}（{{ detail.row.管廊编号 }}）</h3>
        <table class="detail-grid">
          <tr><th>所属片区</th><td>{{ detail.row.所属片区 }}</td><th>舱室数量</th><td>{{ detail.row.舱室数量 }}</td></tr>
          <tr><th>总长度（米）</th><td>{{ detail.row.总长度 }}</td><th>结构类型</th><td>{{ detail.row.结构类型 }}</td></tr>
          <tr><th>投运日期</th><td>{{ detail.row.投运日期 ?? '—' }}</td><th>停用生效日</th><td>{{ detail.row.停用生效日 ?? '—' }}</td></tr>
          <tr><th>检修区间</th><td>{{ detail.row.检修起始日 ?? '—' }} 至 {{ detail.row.检修截止日 ?? '—' }}</td><th>数据来源</th><td>{{ detail.row.数据来源 ?? '—' }}</td></tr>
        </table>
        <p class="verdict-box">
          <span :class="['status-tag', `st-${detail.row.verdict.status}`]">{{ detail.row.verdict.status }}</span>
          <span class="version-tag">{{ detail.row.verdict.policy === 'v1' ? '既有记录·v1 保留原判' : '新口径 v2' }}</span>
          {{ detail.row.verdict.reason }}
        </p>
        <div class="detail-actions">
          <button class="btn" type="button" :disabled="detail.row.verdict.status === '已停用'" @click="closeDetailAndRun('提交投运')">提交投运</button>
          <button class="btn" type="button" :disabled="detail.row.verdict.status === '已停用'" @click="closeDetailAndRepair">安排检修</button>
          <button class="btn" type="button" :disabled="detail.row.verdict.status !== '检修中'" @click="closeDetailAndRun('完成检修')">完成检修</button>
          <button class="btn primary" type="button" :disabled="detail.row.verdict.status === '已停用'" @click="closeDetailAndStop">停用管廊</button>
        </div>
        <h4>状态流转与补录日志</h4>
        <table class="data-table journal-table">
          <thead><tr><th>业务日期</th><th>动作</th><th>口径</th><th>说明</th><th>提交流水</th></tr></thead>
          <tbody>
            <tr v-for="item in detail.journals" :key="item.id">
              <td>{{ item.bizDate }}</td><td>{{ item.action }}</td><td>{{ item.policy }}</td><td>{{ item.remark }}</td><td>{{ item.submitNo }}</td>
            </tr>
            <tr v-if="!detail.journals.length"><td colspan="5" class="empty-state">暂无流转日志</td></tr>
          </tbody>
        </table>
        <div class="modal-actions"><button class="btn ghost" type="button" @click="detail = null">关闭</button></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createTunnel,
  downloadEntries,
  getBackfillReport,
  listTunnels,
  moduleMeta,
  newSubmitNo,
  runAction as applyAction,
  tunnelDetail,
  tunnelStats,
  type TunnelView,
} from '@/api/local-service'
import { TUNNEL_LIMITS, TUNNEL_STATUS, todayISO } from '@/data/tunnel-policy'
import type { BackfillReport } from '@/data/types'

type TunnelRow = TunnelView

const meta = moduleMeta('tunnel')
const columns = ["管廊编号", "管廊名称", "所属片区", "舱室数量", "总长度", "结构类型", "投运日期", "停用生效日", "数据来源"]
const statuses = [TUNNEL_STATUS.pending, TUNNEL_STATUS.running, TUNNEL_STATUS.repairing, TUNNEL_STATUS.stopped]
const limits = TUNNEL_LIMITS

const rows = ref<TunnelRow[]>([])
const total = ref(0)
const stats = ref<Record<string, number>>({})
const backfill = ref<BackfillReport | null>(null)
const showReport = ref(false)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["管廊编号", "管廊名称", "所属片区"]
const today = todayISO()

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: stats.value[status] ?? 0 })),
)
const statCards = computed(() => [
  { label: '在运管廊（运行中）', value: stats.value[TUNNEL_STATUS.running] ?? 0 },
  { label: '检修中管廊', value: stats.value[TUNNEL_STATUS.repairing] ?? 0 },
  { label: '待投运管廊', value: stats.value[TUNNEL_STATUS.pending] ?? 0 },
  { label: '已停用管廊', value: stats.value[TUNNEL_STATUS.stopped] ?? 0 },
])

// —— 登记表单 ——
const creating = ref(false)
const formError = ref('')
const form = reactive({
  tunnelNo: '',
  tunnelName: '',
  district: '',
  chambers: String(TUNNEL_LIMITS.chambers.default),
  lengthMeters: '',
  structure: '',
  commissionDate: '',
})

// —— 停用 / 检修 / 详情弹层 ——
const stopping = ref<TunnelRow | null>(null)
const stopDateInput = ref(today)
const repairing = ref<TunnelRow | null>(null)
const repairStartInput = ref(today)
const repairEndInput = ref(addDays(today, TUNNEL_LIMITS.repairDays.default - 1))
const detail = ref<ReturnType<typeof tunnelDetail> | null>(null)

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function onSearch() {
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  formError.value = ''
  Object.assign(form, {
    tunnelNo: '', tunnelName: '', district: '',
    chambers: String(TUNNEL_LIMITS.chambers.default),
    lengthMeters: '', structure: '', commissionDate: '',
  })
  creating.value = true
}

function submitCreate() {
  const result = createTunnel({ ...form, submitNo: newSubmitNo('CREATE') })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  creating.value = false
  reload(result.message)
}

function openStop(row: TunnelRow) {
  errorMessage.value = ''
  stopping.value = row
  stopDateInput.value = today
}

function submitStop() {
  if (!stopping.value) {
    return
  }
  const result = applyAction('tunnel', Number(stopping.value.id), '停用管廊', {
    stopDate: stopDateInput.value,
    submitNo: newSubmitNo('STOP'),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  stopping.value = null
  reload(result.message)
}

function openRepair(row: TunnelRow) {
  errorMessage.value = ''
  repairing.value = row
  repairStartInput.value = today
  repairEndInput.value = addDays(today, TUNNEL_LIMITS.repairDays.default - 1)
}

function submitRepair() {
  if (!repairing.value) {
    return
  }
  const result = applyAction('tunnel', Number(repairing.value.id), '安排检修', {
    repairStart: repairStartInput.value,
    repairEnd: repairEndInput.value,
    submitNo: newSubmitNo('REPAIR'),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  repairing.value = null
  reload(result.message)
}

function runAction(action: string, row: TunnelRow) {
  const result = applyAction(meta.key, Number(row.id), action, { submitNo: newSubmitNo('ACT') })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload(result.message)
}

function openDetail(row: TunnelRow) {
  detail.value = tunnelDetail(Number(row.id))
}

function closeDetailAndRun(action: string) {
  if (!detail.value) {
    return
  }
  const id = Number(detail.value.row.id)
  detail.value = null
  const result = applyAction(meta.key, id, action, { submitNo: newSubmitNo('ACT') })
  reload(result.ok ? result.message : '', result.ok ? '' : result.message)
}

function closeDetailAndRepair() {
  if (!detail.value) {
    return
  }
  const row = detail.value.row
  detail.value = null
  openRepair(row)
}

function closeDetailAndStop() {
  if (!detail.value) {
    return
  }
  const row = detail.value.row
  detail.value = null
  openStop(row)
}

function reload(okMsg = '', failMessage = '') {
  errorMessage.value = failMessage
  okMessage.value = okMsg
  try {
    const payload = listTunnels(filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = tunnelStats()
    backfill.value = getBackfillReport()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管廊主体台账列表读取失败'
  }
}

onMounted(() => reload())
</script>
