/**
 * 管廊主体统一判定口径（v2）——全系统唯一一份。
 *
 * 列表状态、详情结论、页脚统计、停用联动提示、派工清单全部只能调用本文件的函数，
 * 任何页面不得自行再判一遍，避免「列表运行中、详情对不上、页脚不跟着变」。
 *
 * 适用范围：本口径仅对改版后的新记录（policy='v2'）生效；
 * 既有记录（policy='v1'）按当时口径保留原判，状态冻结为其历史结论。
 */
import type { EntryRow, PolicyVersion } from './types'

/** 三种业务状态（待投运为登记后、投运前的初始态，不计入三态判定结论）。 */
export const TUNNEL_STATUS = {
  pending: '待投运',
  running: '运行中',
  repairing: '检修中',
  stopped: '已停用',
} as const

export type TunnelStatus = (typeof TUNNEL_STATUS)[keyof typeof TUNNEL_STATUS]

/** 管廊主体字段允许区间与默认口径（越界一律驳回，理由由 validateTunnelDraft 给出）。 */
export const TUNNEL_LIMITS = {
  /** 舱室数量：整数，最小 1（0 舱不构成综合管廊，禁止保存），最大 20。 */
  chambers: { min: 1, max: 20, integer: true, default: 1 },
  /** 总长度：米，最小 0.1，最大 100000，最多 2 位小数。 */
  lengthMeters: { min: 0.1, max: 100000, decimals: 2 },
  /** 检修计划工期（天）：1–180。 */
  repairDays: { min: 1, max: 180, default: 7 },
} as const

/** 图纸口径：早期未登记舱室数量的存量管廊，按竣工图纸的标准断面舱数补齐。 */
export const DRAWING_CHAMBERS: Record<string, number> = {
  'TUNN-L02': 3,
}

/** 并发窗口（毫秒）：同一行同一动作 5 秒内到的第二笔按重复挡回，只认先落库的一笔。 */
export const DEDUP_WINDOW_MS = 5_000

export type TunnelVerdict = {
  status: TunnelStatus
  /** 判定依据的人话结论，列表/详情/停用联动共用这一份文案。 */
  reason: string
  policy: PolicyVersion
}

/** 日期是否为合法 YYYY-MM-DD（含真实日历校验，2026-02-31 这类直接不合法）。 */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return (
    date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
  )
}

function dayDiff(fromISO: string, toISO: string): number {
  const a = new Date(`${fromISO}T00:00:00`).getTime()
  const b = new Date(`${toISO}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 管廊状态唯一判定入口（v2）。
 *
 * 判定优先级（自上而下，命中即定）：
 *   1. 已停用：停用生效日 ≤ 判定基准日 —— 终态，最高优先，与管线是否迁完无关；
 *   2. 检修中：检修起始日 ≤ 基准日 ≤ 检修截止日；
 *   3. 运行中：投运日期 ≤ 基准日（投运时间一律按投运日期算，口径只有这一个）；
 *   4. 其余：待投运。
 */
export function deriveTunnelStatus(row: EntryRow, now: Date = new Date()): TunnelVerdict {
  const policy = (String(row.policy ?? 'v1') as PolicyVersion)
  const today = todayISO(now)
  const commissionDate = String(row.投运日期 ?? '')
  const stopDate = String(row.停用生效日 ?? '')
  const repairStart = String(row.检修起始日 ?? '')
  const repairEnd = String(row.检修截止日 ?? '')

  // v1 既有记录：按当时口径保留原判，不重算、不追溯。
  if (policy === 'v1') {
    return {
      status: String(row.status) as TunnelStatus,
      reason: `改版前既有记录，按当时口径保留原判「${row.status}」`,
      policy: 'v1',
    }
  }

  if (stopDate && isValidDate(stopDate) && stopDate <= today) {
    return {
      status: TUNNEL_STATUS.stopped,
      reason: `停用生效日 ${stopDate} 已到，按停用口径判为「已停用」（终态，与管线迁出进度无关）`,
      policy: 'v2',
    }
  }
  if (
    repairStart && repairEnd && isValidDate(repairStart) && isValidDate(repairEnd)
    && repairStart <= today && today <= repairEnd
  ) {
    return {
      status: TUNNEL_STATUS.repairing,
      reason: `处于检修计划区间 ${repairStart} 至 ${repairEnd} 内，判为「检修中」`,
      policy: 'v2',
    }
  }
  if (commissionDate && isValidDate(commissionDate) && commissionDate <= today) {
    return {
      status: TUNNEL_STATUS.running,
      reason: `投运日期 ${commissionDate} 已到，按投运日期口径判为「运行中」`,
      policy: 'v2',
    }
  }
  return {
    status: TUNNEL_STATUS.pending,
    reason: commissionDate
      ? `投运日期 ${commissionDate} 未到，判为「待投运」`
      : '尚未登记投运日期，判为「待投运」',
    policy: 'v2',
  }
}

export type TunnelDraft = {
  tunnelNo: string
  tunnelName: string
  district: string
  chambers: number | string
  lengthMeters: number | string
  structure: string
  commissionDate: string
}

export type ValidationResult = { ok: true } | { ok: false; reasons: string[] }

/** 新登记/新提交的统一校验：舱室数量等取值超范围直接驳回并逐条说明理由。 */
export function validateTunnelDraft(draft: TunnelDraft): ValidationResult {
  const reasons: string[] = []

  if (!String(draft.tunnelNo ?? '').trim()) {
    reasons.push('管廊编号不能为空')
  } else if (!/^[A-Za-z0-9-]{3,20}$/.test(String(draft.tunnelNo).trim())) {
    reasons.push('管廊编号需为 3–20 位字母、数字或连字符')
  }
  if (!String(draft.tunnelName ?? '').trim()) {
    reasons.push('管廊名称不能为空')
  }
  if (!String(draft.district ?? '').trim()) {
    reasons.push('所属片区不能为空')
  }

  const chambers = Number(draft.chambers)
  const { min, max } = TUNNEL_LIMITS.chambers
  if (draft.chambers === '' || Number.isNaN(chambers)) {
    reasons.push(`舱室数量不能为空，需为 ${min}–${max} 的整数（默认 ${TUNNEL_LIMITS.chambers.default}）`)
  } else if (!Number.isInteger(chambers)) {
    reasons.push(`舱室数量必须是整数（允许区间 ${min}–${max}），收到 ${draft.chambers}`)
  } else if (chambers < min || chambers > max) {
    reasons.push(
      chambers === 0
        ? `舱室数量不能为 0：0 舱不构成综合管廊，允许区间 ${min}–${max}`
        : `舱室数量 ${chambers} 超出允许区间 ${min}–${max}，已驳回`,
    )
  }

  const lengthMeters = Number(draft.lengthMeters)
  const len = TUNNEL_LIMITS.lengthMeters
  if (draft.lengthMeters === '' || Number.isNaN(lengthMeters)) {
    reasons.push(`总长度不能为空，单位米，允许区间 ${len.min}–${len.max}`)
  } else if (lengthMeters < len.min || lengthMeters > len.max) {
    reasons.push(`总长度 ${draft.lengthMeters} 米超出允许区间 ${len.min}–${len.max} 米，已驳回`)
  } else if (!new RegExp(`^\\d+(\\.\\d{1,${len.decimals}})?$`).test(String(draft.lengthMeters))) {
    reasons.push(`总长度最多保留 ${len.decimals} 位小数`)
  }

  if (!draft.commissionDate) {
    reasons.push('投运日期不能为空（投运时间一律按投运日期判定）')
  } else if (!isValidDate(draft.commissionDate)) {
    reasons.push(`投运日期 ${draft.commissionDate} 不是合法日期`)
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

/** 停用动作的业务日期校验：停用生效日必须合法且不得晚于今日（不许预定未来停用）。 */
export function validateStopDate(stopDate: string, now: Date = new Date()): ValidationResult {
  const today = todayISO(now)
  if (!stopDate) {
    return { ok: false, reasons: ['停用生效日不能为空'] }
  }
  if (!isValidDate(stopDate)) {
    return { ok: false, reasons: [`停用生效日 ${stopDate} 不是合法日期`] }
  }
  if (stopDate > today) {
    return { ok: false, reasons: [`停用生效日 ${stopDate} 晚于今日 ${today}，不能预定未来停用，已驳回`] }
  }
  return { ok: true }
}

/** 检修区间校验：起止日期合法、起≤止、工期在 1–180 天内。 */
export function validateRepairRange(
  start: string,
  end: string,
  now: Date = new Date(),
): ValidationResult {
  const reasons: string[] = []
  if (!isValidDate(start)) {
    reasons.push(`检修起始日 ${start || '(空)'} 不是合法日期`)
  }
  if (!isValidDate(end)) {
    reasons.push(`检修截止日 ${end || '(空)'} 不是合法日期`)
  }
  if (reasons.length === 0) {
    if (start > end) {
      reasons.push(`检修起始日 ${start} 晚于截止日 ${end}`)
    } else {
      const days = dayDiff(start, end) + 1
      if (days < TUNNEL_LIMITS.repairDays.min || days > TUNNEL_LIMITS.repairDays.max) {
        reasons.push(
          `检修工期 ${days} 天超出允许区间 ${TUNNEL_LIMITS.repairDays.min}–${TUNNEL_LIMITS.repairDays.max} 天`,
        )
      }
    }
    if (start < todayISO(now) && start !== todayISO(now)) {
      // 允许补录今日开工，但不允许把检修起期登记到过去更早的日期
      reasons.push(`检修起始日 ${start} 早于今日，检修只能自当日起登记`)
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

/**
 * 停用后下游提示的唯一生成处。
 * 入廊管线、在册设备、环境监测记录只要所属管廊命中停用清单，读到的都是这一份口径。
 */
export function stoppedTunnelNotice(tunnel: EntryRow): string {
  const stopDate = String(tunnel.停用生效日 ?? '')
  return `所属管廊「${tunnel.管廊名称}」(${tunnel.管廊编号}) 已于 ${stopDate} 停用：按停用口径，廊体停止接入与运行类作业，在册设备转停用监护，环境监测保留采集、数据按停用廊段归档`
}

/** 停用处理意见：同一份文案回写到各入口的派工清单。 */
export function stoppedDispatchOpinion(tunnel: EntryRow, target: 'maintenance' | 'entryapprove'): string {
  const stopDate = String(tunnel.停用生效日 ?? '')
  if (target === 'maintenance') {
    return `「${tunnel.管廊名称}」(${tunnel.管廊编号}) 已于 ${stopDate} 停用。请安排：1）在册设备断电封存与停用监护，保养计划挂起；2）入廊管线限期迁出并核对在册清单；3）停用廊段环境监测保留采集、数据归档备查。处理结果回记本清单。`
  }
  return `「${tunnel.管廊名称}」(${tunnel.管廊编号}) 已于 ${stopDate} 停用。停用口径下：停止受理该廊段新的入廊运行类作业，已批未完工的作业申请限期收尾或迁出，应急、监测类作业经审批后可入廊。`
}
