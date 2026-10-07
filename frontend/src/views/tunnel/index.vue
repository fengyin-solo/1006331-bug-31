<template>
  <section class="page" data-module="tunnel">
    <header class="page-head">
      <div>
        <h2>管廊主体台账管理</h2>
        <p class="page-desc">统一口径（第二版）：投运只认投运日期，检修只在检修期内成立，停用为终态；列表、详情、页脚统计同源。</p>
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

    <details class="rule-panel">
      <summary>管廊主体统一判定口径与允许区间（第二版，2026-10-07 起对新记录生效）</summary>
      <div class="rule-body">
        <p>
          <strong>状态判定（全平台唯一口径）：</strong><br />
          ① 待投运：新登记统一先挂待投运（投运日期可填过去或将来）；② 运行中：经「提交投运」落账（动作校验投运日期不晚于当天）；
          ③ 检修中：运行中管廊经「安排检修」落账，且未超过计划完工日，超期自动按运行中统计；
          ④ 已停用：运行中/检修中管廊经「停用管廊」落账，<strong>停用是终态</strong>，重复停用只生效一次。
          存量记录（口径标记 v1）保留原判，不按新口径重判。
        </p>
        <p>
          <strong>允许区间（越界直接驳回并说明理由）：</strong><br />
          舱室数量：1～50 的整数，<strong>0 不允许保存</strong>，新建必须手填、不设业务默认值；
          总长度：0.1～200000 米；检修工期：1～180 天；投运日期：合法日期且不晚于当天；管廊编号：TUNN-#### 格式且全库唯一。<br />
          存量缺项补录口径：竣工图纸标注值 → 同片区同结构已登记值的中位数（标注待核实）→ 兜底 1（默认值，待核实），并开缺项核补单。
        </p>
        <p>
          <strong>停用联动：</strong>停用后入廊管线仅可迁出、在册设备仅可报废、环境监测冻结采集，
          设备台账与环境监测读到同一份停用口径，处理意见回写同一张派工清单。
        </p>
      </div>
    </details>

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
          <th>口径</th>
          <th>可执行动作</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            {{ row[column] ?? '—' }}
            <span v-if="column === '舱室数量' && String(row.舱室数量来源) !== '登记填报'" class="badge idle" :title="String(row.舱室数量来源)">*</span>
          </td>
          <td><span :class="['badge', badgeClass(row)]">{{ statusOf(row) }}</span></td>
          <td>
            <span :class="['badge', Number(row.version) === 1 ? 'v1' : 'run']">
              {{ Number(row.version) === 1 ? 'v1 老口径原判' : 'v2 统一口径' }}
            </span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action.name"
              class="link"
              type="button"
              @click="runAction(action.name, row)"
            >
              {{ action.name }}
            </button>
            <span v-if="!availableActions(row).length" class="page-desc">—</span>
          </td>
          <td><button class="link" type="button" @click="openDetail(row)">查看</button></td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无管廊主体台账数据，可先登记综合管廊</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管廊主体台账记录，其中在运管廊 <strong>{{ counts.运行中 }}</strong> 条（页脚与列表、详情同一口径）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记弹窗 -->
    <div v-if="creating" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3>登记综合管廊（第二版统一口径）</h3>
        <div class="form-grid">
          <label>管廊编号</label>
          <div>
            <input v-model="form.管廊编号" placeholder="TUNN-0010" />
            <p v-if="issueOf('管廊编号')" class="field-error">{{ issueOf('管廊编号') }}</p>
          </div>
          <label>管廊名称</label>
          <div>
            <input v-model="form.管廊名称" placeholder="如：中央大道综合管廊" />
            <p v-if="issueOf('管廊名称')" class="field-error">{{ issueOf('管廊名称') }}</p>
          </div>
          <label>所属片区</label>
          <div>
            <input v-model="form.所属片区" placeholder="如：中心城区" />
            <p v-if="issueOf('所属片区')" class="field-error">{{ issueOf('所属片区') }}</p>
          </div>
          <label>结构类型</label>
          <div>
            <input v-model="form.结构类型" placeholder="单舱 / 双舱 / 三舱 / 四舱" />
            <p v-if="issueOf('结构类型')" class="field-error">{{ issueOf('结构类型') }}</p>
          </div>
          <label>舱室数量</label>
          <div>
            <input v-model="form.舱室数量" type="number" min="1" max="50" step="1" placeholder="1～50 的整数；0 不能保存" />
            <p v-if="issueOf('舱室数量')" class="field-error">{{ issueOf('舱室数量') }}</p>
          </div>
          <label>总长度（米）</label>
          <div>
            <input v-model="form.总长度" type="number" min="0.1" max="200000" step="0.1" placeholder="0.1～200000" />
            <p v-if="issueOf('总长度')" class="field-error">{{ issueOf('总长度') }}</p>
          </div>
          <label>投运日期</label>
          <div>
            <input v-model="form.投运日期" type="date" />
            <p v-if="issueOf('投运日期')" class="field-error">{{ issueOf('投运日期') }}</p>
            <p v-else class="page-desc">投运只认投运日期；登记先挂待投运，到日后由「提交投运」落账转运行中。</p>
          </div>
        </div>
        <footer class="modal-foot">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交登记</button>
        </footer>
      </div>
    </div>

    <!-- 动作参数弹窗 -->
    <div v-if="actionDialog" class="modal-mask" @click.self="actionDialog = null">
      <div class="modal" style="width: 460px">
        <h3>{{ actionDialog.action }}｜{{ actionDialog.row.管廊编号 }}</h3>
        <p class="page-desc">{{ actionDialog.row.管廊名称 }}，当前状态「{{ statusOf(actionDialog.row) }}」</p>
        <div v-if="actionDialog.action === '安排检修'" class="form-grid">
          <label>检修工期（天）</label>
          <div>
            <input v-model="repairDays" type="number" min="1" max="180" step="1" placeholder="1～180" />
            <p class="page-desc">超出 1～180 天直接驳回。</p>
          </div>
        </div>
        <div v-if="actionDialog.action === '停用管廊'" class="form-grid">
          <label>停用原因</label>
          <div><input v-model="stopReason" placeholder="如：沿线改造整体停用" /></div>
        </div>
        <p v-if="actionDialog.action === '停用管廊'" class="page-desc">
          停用为终态：同一管廊重复提交停用只生效一次；停用后将向入廊管线、在册设备、环境监测三侧按同一口径出具停用告知单。
        </p>
        <footer class="modal-foot">
          <button class="btn ghost" type="button" @click="actionDialog = null">取消</button>
          <button class="btn primary" type="button" @click="confirmAction">确认</button>
        </footer>
      </div>
    </div>

    <!-- 详情弹窗：结论与列表同源 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal">
        <h3>管廊详情｜{{ detail.row.管廊编号 }}</h3>
        <dl class="detail-list">
          <dt>管廊名称</dt><dd>{{ detail.row.管廊名称 }}</dd>
          <dt>所属片区</dt><dd>{{ detail.row.所属片区 }}</dd>
          <dt>结构类型</dt><dd>{{ detail.row.结构类型 }}</dd>
          <dt>舱室数量</dt><dd>{{ detail.row.舱室数量 }}（来源：{{ detail.row.舱室数量来源 }}）</dd>
          <dt>总长度</dt><dd>{{ detail.row.总长度 }} 米（来源：{{ detail.row.总长度来源 }}）</dd>
          <dt>投运日期</dt><dd>{{ detail.row.投运日期 }}（来源：{{ detail.row.投运日期来源 }}）</dd>
          <dt>台账状态</dt><dd>{{ detail.row.status }}</dd>
          <dt>统一判定结论</dt>
          <dd><span :class="['badge', badgeClass(detail.row)]">{{ detail.effectiveStatus }}</span>
            <span :class="['badge', detail.inService ? 'run' : 'idle']">{{ detail.inService ? '计入在运管廊' : '不计入在运管廊' }}</span>
          </dd>
          <dt>判定依据</dt><dd>{{ detail.row.状态依据 }}</dd>
          <dt>停用日期</dt><dd>{{ detail.row.停用日期 || '—' }}</dd>
          <dt>口径版本</dt><dd>{{ Number(detail.row.version) === 1 ? 'v1 存量记录：按当时口径保留原判' : 'v2 统一口径' }}</dd>
          <dt v-if="detail.row.补录批次">补录批次</dt><dd v-if="detail.row.补录批次">{{ detail.row.补录批次 }}</dd>
        </dl>

        <p class="section-title">关联派工清单（与管线、设备、环境监测入口同一份）</p>
        <div v-if="!detail.orders.length" class="page-desc">暂无关联派工单。</div>
        <div v-for="order in detail.orders" :key="order.id">
          <p class="page-desc">#{{ order.id }} {{ order.类型 }}｜{{ order.状态 }}｜业务发生日 {{ order.业务发生日 }}</p>
          <div class="opinion-box">{{ order.处理意见 }}</div>
        </div>

        <footer class="modal-foot">
          <button class="btn primary" type="button" @click="detail = null">关闭</button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createTunnel,
  downloadEntries,
  listEntries,
  moduleMeta,
  tunnelAction,
  tunnelBoard,
  tunnelDetail,
} from '@/api/local-service'
import { GO_LIVE_DATE, effectiveStatus, type TunnelAction } from '@/domain/tunnel-rules'
import type { TunnelRow } from '@/domain/types'

const meta = moduleMeta('tunnel')
const columns = ['管廊编号', '管廊名称', '所属片区', '舱室数量', '总长度', '结构类型', '投运日期', '管廊状态']
const today = GO_LIVE_DATE

const rows = ref<TunnelRow[]>([])
const total = ref(0)
const counts = ref<Record<string, number>>({ 待投运: 0, 运行中: 0, 检修中: 0, 已停用: 0 })
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const statCards = computed(() => [
  { label: '在运管廊（页脚同源）', value: counts.value.运行中 },
  { label: '检修中管廊', value: counts.value.检修中 },
  { label: '待投运管廊', value: counts.value.待投运 },
  { label: '已停用管廊', value: counts.value.已停用 },
])

const statusSummary = computed(() =>
  ['待投运', '运行中', '检修中', '已停用'].map((status) => ({
    status,
    count: rows.value.filter((row) => statusOf(row) === status).length,
  })),
)

function statusOf(row: { version: number | string; status: string; 投运日期?: string; 检修完工日?: string }): string {
  return effectiveStatus(row, today)
}

function badgeClass(row: TunnelRow): string {
  const status = effectiveStatus(row, today)
  return status === '运行中' ? 'run' : status === '检修中' ? 'repair' : status === '已停用' ? 'stop' : 'idle'
}

/** 动作可用性也走统一状态机：不满足前置条件的按钮不展示，提交时服务端再判一次（双保险）。 */
function availableActions(row: TunnelRow): { name: TunnelAction }[] {
  const status = effectiveStatus(row, today)
  if (Number(row.version) === 1 && status === '已停用') return []
  switch (status) {
    case '待投运':
      return [{ name: '提交投运' }]
    case '运行中':
      return [{ name: '安排检修' }, { name: '停用管廊' }]
    case '检修中':
      return [{ name: '完工复运' }, { name: '停用管廊' }]
    case '已停用':
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// ── 登记 ──
const creating = ref(false)
const form = reactive({ 管廊编号: '', 管廊名称: '', 所属片区: '', 舱室数量: '', 总长度: '', 结构类型: '', 投运日期: '' })
const issues = ref<{ field: string; reason: string }[]>([])

function openCreate() {
  Object.assign(form, { 管廊编号: '', 管廊名称: '', 所属片区: '', 舱室数量: '', 总长度: '', 结构类型: '', 投运日期: '' })
  issues.value = []
  creating.value = true
}
function closeCreate() {
  creating.value = false
}
function issueOf(field: string): string {
  return issues.value.find((item) => item.field === field)?.reason ?? ''
}
function submitCreate() {
  issues.value = []
  const result = createTunnel({ ...form }, today)
  if (!result.ok) {
    issues.value = result.issues
    errorMessage.value = result.message
    return
  }
  creating.value = false
  errorMessage.value = result.message
  reload()
}

// ── 动作 ──
const actionDialog = ref<{ action: TunnelAction; row: TunnelRow } | null>(null)
const repairDays = ref(7)
const stopReason = ref('')

function runAction(action: TunnelAction, row: TunnelRow) {
  errorMessage.value = ''
  if (action === '安排检修' || action === '停用管廊') {
    repairDays.value = 7
    stopReason.value = ''
    actionDialog.value = { action, row }
    return
  }
  applyAction(action, row)
}

function confirmAction() {
  if (!actionDialog.value) return
  const { action, row } = actionDialog.value
  applyAction(action, row)
  actionDialog.value = null
}

function applyAction(action: TunnelAction, row: TunnelRow) {
  const result = tunnelAction(row.id, action, {
    today,
    expectedVersion: row.rowVersion,
    检修工期: action === '安排检修' ? Number(repairDays.value) : undefined,
    停用原因: stopReason.value || undefined,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

// ── 详情 ──
const detail = ref<ReturnType<typeof tunnelDetail> | null>(null)
function openDetail(row: TunnelRow) {
  detail.value = tunnelDetail(Number(row.id), today)
}

function reload() {
  errorMessage.value = ''
  try {
    const board = tunnelBoard(today)
    const payload = listEntries(meta.key, filters.value)
    // 列表行与统一台账按 id 对齐：列表展示的就是统一判定后的数据，不会再出现两处结论不一致。
    rows.value = board.tunnels.filter((row) =>
      payload.items.some((item) => Number(item.id) === Number(row.id)),
    )
    total.value = payload.total
    counts.value = board.counts
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管廊主体台账列表读取失败'
  }
}

onMounted(reload)
</script>
