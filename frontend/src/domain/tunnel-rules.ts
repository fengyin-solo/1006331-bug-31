/**
 * 管廊主体统一判定口径（第二版）
 *
 * 这份文件是全平台唯一的管廊状态判定出口：列表、详情面板、页脚统计、
 * 管线/设备/环境监测读到的停用口径、派工清单文案都从这里取，禁止在页面里另写一套。
 */

import type { FieldSource, RuleVersion, TunnelRow, TunnelStatus } from './types'

export const RULE_VERSION: RuleVersion = 2

/** 改版上线日：此前的记录为存量（老口径），此后的新记录走统一口径。 */
export const GO_LIVE_DATE = '2026-10-07'

export const TUNNEL_STATUSES: TunnelStatus[] = ['待投运', '运行中', '检修中', '已停用']

/** ───────────────────────── 取值允许区间（第二版新增/编辑时强制校验） ───────────────────────── */

type NumericRule = {
  min: number
  max: number
  integer?: boolean
  unit?: string
  backfillDefault?: number
  label: string
  reason: string
}

export const FIELD_RULES: Record<string, NumericRule> = {
  舱室数量: {
    min: 1,
    max: 50,
    integer: true,
    /** 新建登记时不预填业务值；历史缺项补录时的兜底口径（默认值，需核实）。 */
    backfillDefault: 1,
    label: '舱室数量',
    reason: '舱室数量只允许填 1～50 的整数；0、负数、小数、超过 50 一律驳回。新建登记必须手填，不设业务默认值。',
  },
  总长度: {
    min: 0.1,
    max: 200000,
    unit: '米',
    label: '总长度',
    reason: '总长度只允许填 0.1～200000 米之间的正数，越界驳回。',
  },
  检修工期: {
    min: 1,
    max: 180,
    unit: '天',
    label: '检修工期',
    reason: '检修工期只允许填 1～180 天，越界驳回。',
  },
} as const

/** ───────────────────────── 状态判定（唯一口径） ───────────────────────── */

/**
 * 一条管廊当前的有效状态。
 * - 第二版记录：以落账状态为准，停用为终态；检修中只在检修期内成立，超过计划完工日自动回到运行中。
 * - 第一版存量：保留原判，不按新口径重判（改版口径只对新记录生效）。
 */
export function effectiveStatus(row: { version: number | string; status: string; 投运日期?: string; 检修完工日?: string }, today: string = GO_LIVE_DATE): TunnelStatus {
  // 存量记录（v1）：按当时口径保留原判，任何新版推导（含检修超期回运行）都不作用于老记录。
  if (Number(row.version) === 1) {
    return normalizeLegacyStatus(row.status)
  }
  const status = row.status as TunnelStatus
  if (status === '已停用') return '已停用'
  if (status === '检修中') {
    const finishDate = String(row.检修完工日 ?? '')
    if (finishDate && finishDate < today) return '运行中'
    return '检修中'
  }
  // v2 行只认落账状态：投运日期已到但未办「提交投运」，仍是待投运；投运只认投运日期 + 投运落账。
  return status
}

function normalizeLegacyStatus(raw: string): TunnelStatus {
  if ((TUNNEL_STATUSES as string[]).includes(raw)) return raw as TunnelStatus
  return '待投运'
}

/** 在运判定：列表、详情、页脚统计都用它，保证三处数字一致。 */
export function isInService(row: TunnelRow, today: string = GO_LIVE_DATE): boolean {
  return effectiveStatus(row, today) === '运行中'
}

/** ───────────────────────── 动作允许范围（状态机，只有这一张表） ───────────────────────── */

export type TunnelAction = '提交投运' | '安排检修' | '完工复运' | '停用管廊'

type GuardContext = {
  row: TunnelRow
  today?: string
  检修工期?: number
}

type GuardResult = { ok: true; target: TunnelStatus } | { ok: false; reason: string }

export const ACTION_TARGETS: Record<TunnelAction, TunnelStatus> = {
  提交投运: '运行中',
  安排检修: '检修中',
  完工复运: '运行中',
  停用管廊: '已停用',
}

/** 动作前置条件：列表按钮可用性、提交落账、并发挡回都走这里。 */
export function checkAction(action: TunnelAction, ctx: GuardContext): GuardResult {
  const { row } = ctx
  const today = ctx.today ?? GO_LIVE_DATE
  const status = effectiveStatus(row, today)

  if (status === '已停用') {
    // 停用是终态：重复停用只生效一次（由幂等账册先挡一道，这里给出业务理由）。
    if (action === '停用管廊') {
      return { ok: false, reason: `管廊 ${row.管廊编号} 已于 ${row.停用日期 || '此前'} 停用，停用为终态，重复提交停用只生效一次。` }
    }
    return { ok: false, reason: `管廊 ${row.管廊编号} 已停用（终态），不能执行「${action}」；停用口径下仅允许管线办理迁出、设备办理报废。` }
  }

  switch (action) {
    case '提交投运': {
      if (status !== '待投运') return { ok: false, reason: `只有「待投运」管廊可以提交投运，当前为「${status}」。` }
      const date = String(row.投运日期 ?? '')
      if (!date) return { ok: false, reason: '投运日期缺失：投运只认投运日期，请先补登记投运日期。' }
      if (date > today) return { ok: false, reason: `投运日期 ${date} 晚于当天 ${today}，未到投运日，不能提前投运。` }
      return { ok: true, target: '运行中' }
    }
    case '安排检修': {
      if (status !== '运行中') return { ok: false, reason: `只有「运行中」管廊可以安排检修，当前为「${status}」。` }
      const days = ctx.检修工期
      if (days === undefined) return { ok: false, reason: '安排检修必须填写检修工期（1～180 天）。' }
      const range = FIELD_RULES.检修工期
      if (!Number.isInteger(days) || days < range.min || days > range.max) {
        return { ok: false, reason: range.reason }
      }
      return { ok: true, target: '检修中' }
    }
    case '完工复运': {
      if (status !== '检修中') return { ok: false, reason: `只有「检修中」管廊可以完工复运，当前为「${status}」。` }
      return { ok: true, target: '运行中' }
    }
    case '停用管廊': {
      if (status !== '运行中' && status !== '检修中') {
        return { ok: false, reason: `只有「运行中」或「检修中」管廊可以停用，「待投运」未投运不存在停用，当前为「${status}」。` }
      }
      return { ok: true, target: '已停用' }
    }
  }
}

/** ───────────────────────── 字段校验（越界直接驳回并说明理由） ───────────────────────── */

export type FieldIssue = { field: string; reason: string }

export function validateIntField(field: string, raw: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  const rule = FIELD_RULES[field]
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (raw === '' || raw === null || raw === undefined || Number.isNaN(value)) {
    return { ok: false, reason: rule.reason }
  }
  if (rule.integer && !Number.isInteger(value)) return { ok: false, reason: rule.reason }
  if (value < rule.min || value > rule.max) return { ok: false, reason: rule.reason }
  return { ok: true, value }
}

/** 新建/编辑管廊台账的整体校验。
 * 舱室数量 1～50 必填；投运日期允许填未来日期（登记后为待投运，到日经「提交投运」落账），
 * 是否要求投运日期不晚于当天由 allowFutureDate 控制（登记允许、直接投运不允许）。 */
export function validateTunnelDraft(input: {
  管廊编号: unknown
  管廊名称: unknown
  所属片区: unknown
  舱室数量: unknown
  总长度: unknown
  结构类型: unknown
  投运日期: unknown
}, existingCodes: Set<string>, today: string = GO_LIVE_DATE, allowFutureDate = true): { ok: true; issues?: never } | { ok: false; issues: FieldIssue[] } {
  const issues: FieldIssue[] = []
  const code = String(input.管廊编号 ?? '').trim()
  if (!/^TUNN-\d{4,}$/.test(code)) {
    issues.push({ field: '管廊编号', reason: '管廊编号必须形如 TUNN-0008（前缀 TUNN- 加至少 4 位数字），为空或格式不对直接驳回。' })
  } else if (existingCodes.has(code)) {
    issues.push({ field: '管廊编号', reason: `管廊编号 ${code} 已登记：同一管廊重复提交只认先落的一笔，本笔按重复挡回。` })
  }
  if (!String(input.管廊名称 ?? '').trim()) issues.push({ field: '管廊名称', reason: '管廊名称为必填项。' })
  if (!String(input.所属片区 ?? '').trim()) issues.push({ field: '所属片区', reason: '所属片区为必填项。' })
  if (!String(input.结构类型 ?? '').trim()) issues.push({ field: '结构类型', reason: '结构类型为必填项（如 单舱/双舱/三舱/综合舱）。' })

  const cabin = validateIntField('舱室数量', input.舱室数量)
  if (!cabin.ok) issues.push({ field: '舱室数量', reason: cabin.reason })

  const lengthRule = FIELD_RULES.总长度
  const lengthValue = typeof input.总长度 === 'number' ? input.总长度 : Number(input.总长度)
  if (input.总长度 === '' || input.总长度 === null || input.总长度 === undefined || Number.isNaN(lengthValue) || lengthValue < lengthRule.min || lengthValue > lengthRule.max) {
    issues.push({ field: '总长度', reason: lengthRule.reason })
  }

  const date = String(input.投运日期 ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    issues.push({ field: '投运日期', reason: '投运日期必须形如 2026-10-07。投运只认投运日期，不允许用其他日期替代。' })
  } else if (!allowFutureDate && date > today) {
    issues.push({ field: '投运日期', reason: `投运日期 ${date} 晚于当天 ${today}，未到投运日不能登记投运，可先登记为待投运。` })
  }
  return issues.length ? { ok: false, issues } : { ok: true }
}

/** ───────────────────────── 停用统一口径（管线 / 设备 / 环境监测读同一份） ───────────────────────── */

export function tunnelStopNotice(tunnel: Pick<TunnelRow, '管廊编号' | '管廊名称' | '停用日期'>): string {
  return `所属管廊 ${tunnel.管廊编号}（${tunnel.管廊名称}）已于 ${tunnel.停用日期} 停用，本侧按管廊停用口径处置。`
}

/** 停用后入廊管线提示。 */
export function pipelineStopHint(tunnel: Pick<TunnelRow, '管廊编号' | '管廊名称' | '停用日期'>): string {
  return `${tunnelStopNotice(tunnel)}入廊管线停止新增接入、不得再确认运行，仅允许办理迁出；未迁出管线按待迁出挂账，联系权属单位限期迁出。`
}

/** 停用后在册设备提示。 */
export function deviceStopHint(tunnel: Pick<TunnelRow, '管廊编号' | '管廊名称' | '停用日期'>): string {
  return `${tunnelStopNotice(tunnel)}在册设备停止新增登记与运行确认，仅允许办理报废或随管线迁出调拨；停用期内不安排例行保养，已排保养计划自动撤销。`
}

/** 停用后环境监测提示。 */
export function envStopHint(tunnel: Pick<TunnelRow, '管廊编号' | '管廊名称' | '停用日期'>): string {
  return `${tunnelStopNotice(tunnel)}廊内环境监测停止例行采集与正常/超标判定，监测点位按停用管廊冻结；停用期间读数不作为运行考核依据，仅保留封存前最后一次采集。`
}

/** 停用处理意见：派工清单只存这一份文案，各入口取到的完全一致。 */
export function stopDispatchOpinion(params: {
  tunnel: Pick<TunnelRow, '管廊编号' | '管廊名称' | '停用日期'>
  pipelines: string[]
  devices: string[]
  monitors: string[]
}): string {
  const { tunnel, pipelines, devices, monitors } = params
  const lines = [
    `管廊 ${tunnel.管廊编号}（${tunnel.管廊名称}）于 ${tunnel.停用日期} 停用，按统一停用口径处置：`,
    `1. 入廊管线（${pipelines.length ? pipelines.join('、') : '无在廊管线'}）：停止接入与运行确认，通知权属单位限期办理迁出，逾期未迁出按遗留挂账；`,
    `2. 在册设备（${devices.length ? devices.join('、') : '无在册设备'}）：停止登记与保养排程，按报废或随管线迁出调拨处置；`,
    `3. 环境监测点（${monitors.length ? monitors.join('、') : '无监测点位'}）：停止例行采集与指标判定，封存最后一次采集数据，读数不再计入考核。`,
    '设备台账与环境监测两侧均按本停用口径执行，不得各自另算。',
  ]
  return lines.join('\n')
}

/** 缺项核补单的标准处理意见（图纸口径补舱室数量等）。 */
export function missingDispatchOpinion(desc: string): string {
  return `存量补录缺项核补：${desc} 补录值已标注来源，请运维单位 7 个工作日内对照竣工图纸现场核实并回填确认，逾期未核实按图纸口径定案。`
}

/** 来源标记的统一文案。 */
export const SOURCE_LABEL: Record<FieldSource, string> = {
  登记填报: '登记填报',
  竣工图纸: '竣工图纸',
  同片区同结构推断: '同片区同结构推断（待核实）',
  默认值待核实: '默认值（待核实）',
  老口径原判: '老口径原判',
}

/** 页脚/统计卡统一口径：在运管廊数。 */
export function tunnelCounts(rows: TunnelRow[], today: string = GO_LIVE_DATE) {
  const counts: Record<TunnelStatus, number> = { 待投运: 0, 运行中: 0, 检修中: 0, 已停用: 0 }
  for (const row of rows) counts[effectiveStatus(row, today)] += 1
  return counts
}
