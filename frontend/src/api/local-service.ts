import { MODULE_BY_KEY } from '@/data/modules'
import {
  backfillReport,
  commit,
  db,
  listDispatches,
  listJournals,
  listRows,
  resetAll,
  resetRows,
  runBackfill,
} from '@/data/local-store'
import {
  DEDUP_WINDOW_MS,
  TUNNEL_LIMITS,
  TUNNEL_STATUS,
  deriveTunnelStatus,
  stoppedDispatchOpinion,
  stoppedTunnelNotice,
  todayISO,
  validateRepairRange,
  validateStopDate,
  validateTunnelDraft,
} from '@/data/tunnel-policy'
import type { TunnelVerdict } from '@/data/tunnel-policy'
import type {
  ActionResult,
  BackfillReport,
  DispatchItem,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/** 确保一次性存量补录已执行：所有读入口启动时都过这里，保证打开即看到补齐结果。 */
export function ensureBackfill(): BackfillReport | null {
  return backfillReport() ?? runBackfill()
}

export function getBackfillReport(): BackfillReport | null {
  return ensureBackfill()
}

/** 给每次点击生成提交流水号：同一行两笔并发各有流水，先落库的占用去重键。 */
export function newSubmitNo(prefix = 'SUB'): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

/** 列表里管廊行的统一视图：状态、判定理由全部来自唯一口径函数。 */
export type TunnelView = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  verdict: TunnelVerdict
  [field: string]: string | number | boolean | TunnelVerdict
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  ensureBackfill()
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 管廊列表专用：每行附带统一判定结论，列表、详情、页脚取的是同一份。 */
export function listTunnels(filters: Record<string, string> = {}): {
  items: TunnelView[]
  total: number
} {
  ensureBackfill()
  const matched = filterRows(listRows('tunnel'), filters)
  const items = matched.map((row) => ({ ...row, verdict: deriveTunnelStatus(row) }))
  return { items, total: items.length }
}

/** 页脚/卡片统计专用：在运管廊数以统一口径实算，不再写死。 */
export function tunnelStats(): Record<string, number> {
  ensureBackfill()
  const stats: Record<string, number> = {
    [TUNNEL_STATUS.running]: 0,
    [TUNNEL_STATUS.repairing]: 0,
    [TUNNEL_STATUS.pending]: 0,
    [TUNNEL_STATUS.stopped]: 0,
  }
  for (const row of listRows('tunnel')) {
    stats[deriveTunnelStatus(row).status] += 1
  }
  return stats
}

export function tunnelDetail(id: number): { row: TunnelView; journals: ReturnType<typeof listJournals> } | null {
  ensureBackfill()
  const row = listRows('tunnel').find((item) => Number(item.id) === Number(id))
  if (!row) {
    return null
  }
  return {
    row: { ...row, verdict: deriveTunnelStatus(row) },
    journals: listJournals()
      .filter((item) => item.tunnelId === Number(id))
      .sort((a, b) => (a.bizDate < b.bizDate ? 1 : -1)),
  }
}

export function tunnelJournals() {
  ensureBackfill()
  return listJournals().slice().sort((a, b) => (a.bizDate < b.bizDate ? 1 : -1))
}

export type TunnelCreateInput = {
  tunnelNo: string
  tunnelName: string
  district: string
  chambers: number | string
  lengthMeters: number | string
  structure: string
  commissionDate: string
  submitNo?: string
}

/** 登记新综合管廊：校验区间、管廊编号唯一；新记录一律 v2 口径。 */
export function createTunnel(input: TunnelCreateInput): ActionResult {
  ensureBackfill()
  const validation = validateTunnelDraft({
    tunnelNo: input.tunnelNo,
    tunnelName: input.tunnelName,
    district: input.district,
    chambers: input.chambers === '' ? TUNNEL_LIMITS.chambers.default : input.chambers,
    lengthMeters: input.lengthMeters,
    structure: input.structure,
    commissionDate: input.commissionDate,
  })
  if (!validation.ok) {
    return { ok: false, message: `登记驳回：${validation.reasons.join('；')}` }
  }

  const submitNo = input.submitNo || newSubmitNo('CREATE')
  const tunnelNo = input.tunnelNo.trim()

  return commit((draft) => {
    // 同一管廊编号永久去重：重复登记直接挡回
    const dupKey = `tunnel:create:${tunnelNo}`
    const duplicate = draft.dedup.find((item) => item.key === dupKey)
    if (duplicate) {
      return { ok: false, message: `管廊编号 ${tunnelNo} 已登记（流水 ${duplicate.submitNo}），重复登记已挡回` }
    }
    if (draft.entries.tunnel.some((row) => String(row.管廊编号) === tunnelNo)) {
      return { ok: false, message: `管廊编号 ${tunnelNo} 已存在，不能重复登记` }
    }

    const nextId = draft.entries.tunnel.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    const row: EntryRow = {
      id: nextId,
      status: TUNNEL_STATUS.pending,
      pending: true,
      abnormal: false,
      管廊编号: tunnelNo,
      管廊名称: input.tunnelName.trim(),
      所属片区: input.district.trim(),
      舱室数量: Number(input.chambers === '' ? TUNNEL_LIMITS.chambers.default : input.chambers),
      总长度: String(input.lengthMeters),
      结构类型: input.structure.trim() || '未填报',
      投运日期: input.commissionDate,
      数据来源: '电子台账',
      policy: 'v2',
      管廊状态: '',
    }
    row.status = deriveTunnelStatus(row).status
    row.pending = row.status !== TUNNEL_STATUS.stopped
    draft.entries.tunnel.push(row)
    draft.dedup.push({ key: dupKey, submitNo, at: Date.now() })
    draft.tunnelJournals.push({
      id: `JN-${nextId}-CREATE`,
      tunnelId: nextId,
      tunnelNo,
      action: '登记建账',
      bizDate: todayISO(),
      submitNo,
      policy: 'v2',
      remark: `按 v2 口径登记，投运日期 ${input.commissionDate}，判定「${row.status}」`,
      at: Date.now(),
    })
    return { ok: true, message: `综合管廊 ${tunnelNo} 已登记，当前判定「${row.status}」` }
  })
}

type RunOptions = {
  submitNo?: string
  stopDate?: string
  repairStart?: string
  repairEnd?: string
}

/** 管廊动作统一入口：状态流转、幂等、并发挡回、停用联动全部在这里，一次原子提交。 */
function runTunnelAction(id: number, action: string, options: RunOptions): ActionResult {
  ensureBackfill()
  const now = new Date()
  const submitNo = options.submitNo || newSubmitNo('ACT')

  return commit((draft) => {
    const rows = draft.entries.tunnel
    const index = rows.findIndex((row) => Number(row.id) === Number(id))
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的综合管廊` }
    }
    const row = rows[index]
    const tunnelNo = String(row.管廊编号)
    const before = deriveTunnelStatus(row, now)

    // 停用为终态：已停用管廊的任何后续动作一律驳回
    if (before.status === TUNNEL_STATUS.stopped && action !== '停用管廊') {
      return {
        ok: false,
        message: `综合管廊 ${tunnelNo} 已停用（停用生效日 ${row.停用生效日}），停用为终态，不能再执行「${action}」`,
      }
    }

    // —— 停用管廊：全局只生效一次 ——
    if (action === '停用管廊') {
      if (before.status === TUNNEL_STATUS.stopped) {
        // 幂等：同一管廊重复提交停用，只认第一笔，不重复落账、不重复派工
        const first = draft.tunnelJournals.find(
          (item) => item.tunnelId === Number(id) && item.action === '停用管廊',
        )
        return {
          ok: false,
          message: `综合管廊 ${tunnelNo} 已于 ${row.停用生效日} 停用（首次流水 ${first?.submitNo ?? '—'}），停用只生效一次，本次重复提交已挡回`,
        }
      }
      const stopDate = options.stopDate || todayISO(now)
      const check = validateStopDate(stopDate, now)
      if (!check.ok) {
        return { ok: false, message: `停用驳回：${check.reasons.join('；')}` }
      }
      // 并发挡回：同一管廊停用的永久去重键
      const stopKey = `tunnel:stop:${tunnelNo}`
      if (draft.dedup.some((item) => item.key === stopKey)) {
        return { ok: false, message: `综合管廊 ${tunnelNo} 的停用已有一笔在处理，重复提交已挡回` }
      }

      row.停用生效日 = stopDate
      // v1 既有记录一旦在新版发生业务动作，自动作生效日起按 v2 口径管理，原判留在日志里
      if (row.policy !== 'v2') {
        row.policy = 'v2'
      }
      const after = deriveTunnelStatus(row, now)
      row.status = after.status
      row.pending = false

      // 台账 + 日志 + 两处派工清单同一次提交落库
      draft.dedup.push({ key: stopKey, submitNo, at: Date.now() })
      draft.tunnelJournals.push({
        id: `JN-${id}-STOP`,
        tunnelId: Number(id),
        tunnelNo,
        action: '停用管廊',
        bizDate: stopDate,
        submitNo,
        policy: 'v2',
        remark: `${after.reason}；停用口径同步至入廊管线、在册设备与环境监测`,
        at: Date.now(),
      })
      for (const target of ['maintenance', 'entryapprove'] as const) {
        draft.dispatches.push({
          id: `DSP-${id}-${target}`,
          tunnelId: Number(id),
          tunnelNo,
          tunnelName: String(row.管廊名称),
          target,
          title: `【管廊停用】${row.管廊名称}（${tunnelNo}）停用处理`,
          opinion: stoppedDispatchOpinion(row, target),
          bizDate: stopDate,
          source: `管廊主体台账停用单（流水 ${submitNo}）`,
          createdAt: Date.now(),
        })
      }
      return {
        ok: true,
        message: `综合管廊 ${tunnelNo} 已停用（生效日 ${stopDate}）；停用口径已同步入廊管线/在册设备/环境监测，处理意见已回写检修管理与入廊作业审批派工清单`,
      }
    }

    // —— 以下动作走「同行同动作 5 秒窗口」并发挡回 ——
    const windowKey = `tunnel:${action}:${tunnelNo}`
    const recent = draft.dedup.find(
      (item) => item.key === windowKey && Date.now() - item.at < DEDUP_WINDOW_MS,
    )
    if (recent) {
      return {
        ok: false,
        message: `综合管廊 ${tunnelNo} 的「${action}」已有一笔先落库（流水 ${recent.submitNo}），本次重复提交按并发挡回`,
      }
    }

    if (action === '提交投运') {
      if (before.status === TUNNEL_STATUS.running) {
        return { ok: false, message: `综合管廊 ${tunnelNo} 按投运日期口径已判定「运行中」，无需重复投运` }
      }
      if (!row.投运日期 || String(row.投运日期) > todayISO(now)) {
        return { ok: false, message: `综合管廊 ${tunnelNo} 投运日期未到或缺失，不能提交投运` }
      }
      if (row.policy !== 'v2') {
        row.policy = 'v2'
      }
      const after = deriveTunnelStatus(row, now)
      row.status = after.status
      row.pending = row.status !== TUNNEL_STATUS.stopped
      draft.dedup.push({ key: windowKey, submitNo, at: Date.now() })
      draft.tunnelJournals.push({
        id: `JN-${id}-RUN`,
        tunnelId: Number(id),
        tunnelNo,
        action: '提交投运',
        bizDate: String(row.投运日期),
        submitNo,
        policy: 'v2',
        remark: after.reason,
        at: Date.now(),
      })
      return { ok: true, message: `综合管廊 ${tunnelNo} 已投运，按投运日期 ${row.投运日期} 判定「运行中」` }
    }

    if (action === '安排检修') {
      const repairStart = options.repairStart || todayISO(now)
      const days = TUNNEL_LIMITS.repairDays.default
      const end = options.repairEnd || addDaysISO(repairStart, days - 1)
      const check = validateRepairRange(repairStart, end, now)
      if (!check.ok) {
        return { ok: false, message: `检修安排驳回：${check.reasons.join('；')}` }
      }
      row.检修起始日 = repairStart
      row.检修截止日 = end
      if (row.policy !== 'v2') {
        row.policy = 'v2'
      }
      const after = deriveTunnelStatus(row, now)
      row.status = after.status
      row.pending = row.status !== TUNNEL_STATUS.stopped
      draft.dedup.push({ key: windowKey, submitNo, at: Date.now() })
      draft.tunnelJournals.push({
        id: `JN-${id}-REPAIR`,
        tunnelId: Number(id),
        tunnelNo,
        action: '安排检修',
        bizDate: repairStart,
        submitNo,
        policy: 'v2',
        remark: `检修区间 ${repairStart} 至 ${end}（默认工期 ${days} 天，允许 ${TUNNEL_LIMITS.repairDays.min}–${TUNNEL_LIMITS.repairDays.max} 天）`,
        at: Date.now(),
      })
      return { ok: true, message: `综合管廊 ${tunnelNo} 已安排检修（${repairStart} 至 ${end}），当前判定「${after.status}」` }
    }

    if (action === '完成检修') {
      if (before.status !== TUNNEL_STATUS.repairing) {
        return { ok: false, message: `综合管廊 ${tunnelNo} 当前为「${before.status}」，不在检修区间内，不能完成检修` }
      }
      // 提前结束检修：截止日收成今日，次日起自动恢复运行口径
      row.检修截止日 = todayISO(now)
      const after = deriveTunnelStatus(row, now)
      row.status = after.status
      row.pending = row.status !== TUNNEL_STATUS.stopped
      draft.dedup.push({ key: windowKey, submitNo, at: Date.now() })
      draft.tunnelJournals.push({
        id: `JN-${id}-REPAIR-DONE`,
        tunnelId: Number(id),
        tunnelNo,
        action: '完成检修',
        bizDate: todayISO(now),
        submitNo,
        policy: 'v2',
        remark: `检修于 ${todayISO(now)} 完工，检修区间截止日同步收至今日`,
        at: Date.now(),
      })
      return { ok: true, message: `综合管廊 ${tunnelNo} 检修已完工，当前判定「${after.status}」` }
    }

    return { ok: false, message: `综合管廊没有登记「${action}」这个动作` }
  })
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d + days)
  const yy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: RunOptions = {},
): ActionResult {
  if (key === 'tunnel') {
    return runTunnelAction(id, action, options)
  }

  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const submitNo = options.submitNo || newSubmitNo('ACT')

  return commit((draft) => {
    const rows = draft.entries[key]
    const index = rows.findIndex((row) => Number(row.id) === Number(id))
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    // 通用并发挡回：同一模块同一行同一动作，5 秒窗口内只认先落库的一笔
    const windowKey = `${key}:${action}:${id}`
    const recent = draft.dedup.find(
      (item) => item.key === windowKey && Date.now() - item.at < DEDUP_WINDOW_MS,
    )
    if (recent) {
      return {
        ok: false,
        message: `编号 ${id} 的${meta.entity}「${action}」已有一笔先落库（流水 ${recent.submitNo}），本次重复提交按并发挡回`,
      }
    }

    const current = String(rows[index].status)
    if (current === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    rows[index] = {
      ...rows[index],
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    draft.dedup.push({ key: windowKey, submitNo, at: Date.now() })
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  })
}

/** 停用口径解析：管线/设备/环境监测按所属管廊编号拿到同一份停用提示。 */
const STOP_NOTICE_MODULES = new Set(['pipeline', 'device', 'envmonitor'])

export function stoppedNoticeForRow(key: string, row: EntryRow): string {
  if (!STOP_NOTICE_MODULES.has(key)) {
    return ''
  }
  const tunnelNo = String(row.所属管廊 ?? '')
  if (!tunnelNo) {
    return ''
  }
  const tunnel = listRows('tunnel').find((item) => String(item.管廊编号) === tunnelNo)
  if (!tunnel || deriveTunnelStatus(tunnel).status !== TUNNEL_STATUS.stopped) {
    return ''
  }
  return stoppedTunnelNotice(tunnel)
}

/** 派工清单：检修管理 / 入廊作业审批两个入口读到的是同一份记录（按入口过滤）。 */
export function dispatchList(target: 'maintenance' | 'entryapprove'): DispatchItem[] {
  ensureBackfill()
  return listDispatches()
    .filter((item) => item.target === target)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** 清掉全部数据并回到种子，再重新执行一次补录（供调试/演示）。 */
export function resetAllData(): void {
  resetAll()
  runBackfill()
}

export function exportEntries(key: string): { filename: string; content: string } {
  ensureBackfill()
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    const status = key === 'tunnel' ? deriveTunnelStatus(row).status : row.status
    lines.push([row.id, ...meta.fields.map((field) => csvCell(row[field])), status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  ensureBackfill()
  const rows = db().entries
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
