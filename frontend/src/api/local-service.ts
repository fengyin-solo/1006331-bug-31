import { MODULE_BY_KEY } from '@/data/modules'
import {
  commit,
  listOrders,
  listRows,
  listTunnels,
  nextOrderId,
  ordersOfTunnel,
  resetWorld,
  world,
} from '@/data/local-store'
import {
  ACTION_TARGETS,
  GO_LIVE_DATE,
  checkAction,
  deviceStopHint,
  effectiveStatus,
  envStopHint,
  isInService,
  pipelineStopHint,
  stopDispatchOpinion,
  tunnelCounts,
  validateTunnelDraft,
  type TunnelAction,
} from '@/domain/tunnel-rules'
import type { ActionReceipt, DispatchOrder, TunnelRow } from '@/domain/types'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

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

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** ───────────────────────── 管廊主体：登记（越界直接驳回并说明理由） ───────────────────────── */

export type TunnelDraft = {
  管廊编号: string
  管廊名称: string
  所属片区: string
  舱室数量: number | string
  总长度: number | string
  结构类型: string
  投运日期: string
}

export type CreateTunnelResult =
  | { ok: true; message: string; row: TunnelRow }
  | { ok: false; message: string; issues: { field: string; reason: string }[] }

/** 新建登记：改版后的新记录一律挂第二版口径；编号重复按重复提交挡回（先落账为准）。 */
export function createTunnel(input: TunnelDraft, today: string = GO_LIVE_DATE): CreateTunnelResult {
  const codes = new Set(listTunnels().map((row) => row.管廊编号))
  // 登记允许把投运日期填在将来（先挂待投运，到日再「提交投运」）；其余区间越界仍直接驳回。
  const verdict = validateTunnelDraft(input, codes, today, true)
  if (!verdict.ok) {
    return { ok: false, message: verdict.issues.map((item) => `${item.field}：${item.reason}`).join('；'), issues: verdict.issues }
  }

  const cabin = Number(input.舱室数量)
  const length = Math.round(Number(input.总长度) * 10) / 10
  // 新登记统一先挂「待投运」，投运由「提交投运」动作按投运日期单独落账。
  const initial: TunnelRow = {
    id: Math.max(0, ...listTunnels().map((row) => row.id)) + 1,
    status: '待投运',
    pending: true,
    abnormal: false,
    version: 2,
    管廊编号: input.管廊编号.trim(),
    管廊名称: input.管廊名称.trim(),
    所属片区: input.所属片区.trim(),
    舱室数量: cabin,
    舱室数量来源: '登记填报',
    总长度: length,
    总长度来源: '登记填报',
    结构类型: input.结构类型.trim(),
    投运日期: input.投运日期,
    投运日期来源: '登记填报',
    停用日期: '',
    停用原因: '',
    状态依据: '第二版统一口径：投运只认投运日期，停用为终态。',
    补录批次: '',
    管廊状态: '待投运',
    rowVersion: 1,
    检修完工日: '',
  }
  commit((draft) => {
    draft.tunnels.push(initial)
    draft.receipts.push({
      idemKey: `create-${initial.管廊编号}`,
      module: 'tunnel',
      rowId: initial.id,
      action: '登记综合管廊',
      at: today,
    })
  })
  // 投运动作一律走「提交投运」单独落账（即使投运日期已到）：
  // 登记与投运不耦合，动作回执完整可追溯，也避免自动动作顶掉手动提交。
  const saved = listTunnels().find((row) => row.id === initial.id) ?? initial
  return {
    ok: true,
    message: `管廊 ${saved.管廊编号} 登记成功，当前状态「${effectiveStatus(saved, today)}」（第二版统一口径）。`,
    row: saved,
  }
}

/** ───────────────────────── 管廊主体：动作落账（幂等 + 行版本 + 台账清单同事务） ───────────────────────── */

export type TunnelActionOptions = {
  today?: string
  /** 页面打开该行时的行版本号：两笔并发提交时后提交者版本对不上，按冲突挡回。 */
  expectedVersion?: number
  检修工期?: number
  停用原因?: string
  idemKey?: string
}

export function tunnelAction(id: number, action: TunnelAction, options: TunnelActionOptions = {}): ActionResult {
  return submitTunnelAction(id, action, options)
}

function submitTunnelAction(id: number, action: TunnelAction, options: TunnelActionOptions): ActionResult {
  const today = options.today ?? GO_LIVE_DATE
  const idemKey = options.idemKey ?? `tunnel:${id}:${action}`

  const index = world().tunnels.findIndex((row) => row.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的综合管廊` }
  }
  const row = world().tunnels[index]

  // 第一道：动作回执幂等账册——同一行同一动作两笔同时进来，只认先落账的一笔。
  // 放在状态机之前：终态动作的重复提交必须得到「重复/只生效一次」口径，而不是被状态判定换个理由挡回。
  if (world().receipts.some((receipt) => receipt.idemKey === idemKey)) {
    return { ok: false, message: `管廊 ${row.管廊编号} 的「${action}」已被先到的一笔落账（重复提交只生效一次），本笔按重复挡回。` }
  }

  // 第二道：行版本乐观锁——先落的一笔已把行版本顶上去，持旧版本的后到一笔直接挡回。
  if (options.expectedVersion !== undefined && options.expectedVersion !== row.rowVersion) {
    return {
      ok: false,
      message: `管廊 ${row.管廊编号} 的数据已被先提交的一笔更新（行版本 ${options.expectedVersion} → ${row.rowVersion}），本笔按并发重复挡回，请刷新后以最新状态重办。`,
    }
  }

  const guard = checkAction(action, { row, today, 检修工期: options.检修工期 })
  if (!guard.ok) {
    return { ok: false, message: guard.reason }
  }

  const target = ACTION_TARGETS[action]
  const result = applyTunnelChange(row, action, target, { today, idemKey, 检修工期: options.检修工期, 停用原因: options.停用原因 })
  return result.ok
    ? { ok: true, message: `管廊 ${row.管廊编号} 已${action}，当前状态「${target}」。` }
    : result
}

/** 单个 commit 内完成：台账状态、行版本、动作回执、停用派工单一次落账，台账与清单不可能各算各的。 */
function applyTunnelChange(
  row: TunnelRow,
  action: TunnelAction,
  target: TunnelRow['status'],
  ctx: { today: string; idemKey: string; 检修工期?: number; 停用原因?: string },
): ActionResult {
  let outcome: ActionResult = { ok: true, message: '' }
  commit((draft) => {
    const target2 = draft.tunnels.find((item) => item.id === row.id)
    if (!target2) {
      outcome = { ok: false, message: `管廊 ${row.管廊编号} 在落账时已不存在` }
      return
    }
    const receipt: ActionReceipt = { idemKey: ctx.idemKey, module: 'tunnel', rowId: row.id, action, at: ctx.today }
    // commit 是基于快照 clone 的，这里再查一次回执，保证「同一笔只落一次」。
    if (draft.receipts.some((item) => item.idemKey === ctx.idemKey)) {
      outcome = { ok: false, message: `管廊 ${row.管廊编号} 的「${action}」已被先到的一笔落账，本笔按重复挡回。` }
      return
    }

    target2.status = target
    target2.管廊状态 = target
    target2.pending = target !== '已停用'
    target2.abnormal = NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
    target2.rowVersion += 1

    if (action === '提交投运') {
      target2.状态依据 = `第二版口径：投运只认投运日期（${target2.投运日期}），已于 ${ctx.today} 落账投运。`
    }
    if (action === '安排检修') {
      const finish = addDays(ctx.today, ctx.检修工期 ?? 1)
      target2.检修完工日 = finish
      target2.状态依据 = `第二版口径：${ctx.today} 起检修，计划 ${ctx.today} ～ ${finish}，超期未复运自动按运行中统计。`
    }
    if (action === '完工复运') {
      target2.检修完工日 = ctx.today
      target2.状态依据 = `第二版口径：检修已于 ${ctx.today} 完工复运。`
    }
    if (action === '停用管廊') {
      target2.停用日期 = ctx.today
      target2.停用原因 = ctx.停用原因 ?? '例行停用'
      target2.状态依据 = `第二版口径：${ctx.today} 停用，停用为终态；管线/设备/监测统一按停用口径处置。`

      // 停用联动：入廊管线、在册设备、环境监测点取同一份停用口径，落同一张派工清单。
      const pipelines = draft.rows.pipeline ?? []
      const devices = draft.rows.device ?? []
      const monitors = draft.rows.envmonitor ?? []
      const activePipes = pipelines
        .filter((item) => String(item.所属管廊) === target2.管廊编号 && item.status !== '已迁出')
        .map((item) => String(item.管线编号))
      const activeDevices = devices
        .filter((item) => String(item.所属管廊) === target2.管廊编号 && item.status !== '已报废')
        .map((item) => String(item.设备编号))
      const activeMonitors = monitors
        .filter((item) => String(item.所属管廊) === target2.管廊编号)
        .map((item) => String(item.监测编号))

      const order: DispatchOrder = {
        id: nextOrderId(draft),
        idemKey: `stop-${target2.管廊编号}`,
        管廊编号: target2.管廊编号,
        管廊名称: target2.管廊名称,
        类型: '停用告知单',
        来源: '停用操作',
        处理意见: stopDispatchOpinion({
          tunnel: target2,
          pipelines: activePipes,
          devices: activeDevices,
          monitors: activeMonitors,
        }),
        涉及管线: activePipes,
        涉及设备: activeDevices,
        涉及监测点: activeMonitors,
        状态: '待处理',
        业务发生日: ctx.today,
        落单时间: ctx.today,
      }
      draft.orders.push(order)

      // 两侧台账同步打上停用口径标记，设备台账与环境监测读到的是同一句口径。
      for (const item of pipelines) {
        if (String(item.所属管廊) === target2.管廊编号 && item.status !== '已迁出') {
          item.停用口径提示 = pipelineStopHint(target2)
        }
      }
      for (const item of devices) {
        if (String(item.所属管廊) === target2.管廊编号 && item.status !== '已报废') {
          item.停用口径提示 = deviceStopHint(target2)
        }
      }
      for (const item of monitors) {
        if (String(item.所属管廊) === target2.管廊编号) {
          item.停用口径提示 = envStopHint(target2)
        }
      }
    }

    draft.receipts.push(receipt)
  })
  return outcome
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

/** ───────────────────────── 跨模块停用守卫：管线/设备/环境监测读到的都是停用口径 ───────────────────────── */

export function stopContext(code: string): { stopped: boolean; tunnel?: TunnelRow } {
  const tunnel = listTunnels().find((item) => item.管廊编号 === code)
  if (!tunnel) return { stopped: false }
  return { stopped: effectiveStatus(tunnel) === '已停用', tunnel }
}

/** 跨模块动作前置校验：停用管廊下，管线只准迁出、设备只准报废、环境监测一律不收。 */
export function guardedRunAction(moduleKey: 'pipeline' | 'device' | 'envmonitor', id: number, action: string): ActionResult {
  const rows = listRows(moduleKey)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) return { ok: false, message: '没有找到对应记录' }
  const code = String(row.所属管廊 ?? '')
  const ctx = stopContext(code)
  if (ctx.stopped && ctx.tunnel) {
    if (moduleKey === 'pipeline' && action === '办理迁出') {
      return genericRunAction(moduleKey, id, action, { 迁出日期: GO_LIVE_DATE })
    }
    if (moduleKey === 'device' && action === '报废设备') {
      return genericRunAction(moduleKey, id, action)
    }
    const side = moduleKey === 'pipeline' ? '入廊管线' : moduleKey === 'device' ? '在册设备' : '环境监测'
    return {
      ok: false,
      message: `${side}所属管廊 ${code} 已停用（${ctx.tunnel.停用日期}），按停用口径「${action}」不予受理；`
        + (moduleKey === 'pipeline' ? '仅允许办理迁出。' : moduleKey === 'device' ? '仅允许办理报废。' : '监测点冻结，仅保留封存前最后一次采集。'),
    }
  }
  return genericRunAction(moduleKey, id, action)
}

function genericRunAction(key: string, id: number, action: string, patch: Record<string, string> = {}): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  let result: ActionResult = { ok: true, message: '' }
  commit((draft) => {
    const rows = draft.rows[key] ?? []
    const index = rows.findIndex((item) => Number(item.id) === id)
    if (index < 0) {
      result = { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
      return
    }
    const current = String(rows[index].status)
    if (current === target) {
      result = { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
      return
    }
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    rows[index] = {
      ...rows[index],
      ...patch,
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    result = { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  })
  return result
}

/** ───────────────────────── 管廊统一视图出口：列表/详情/页脚统计同一份 ───────────────────────── */

export function tunnelBoard(today: string = GO_LIVE_DATE) {
  const tunnels = listTunnels()
  const counts = tunnelCounts(tunnels, today)
  return {
    tunnels,
    counts,
    inService: counts.运行中,
    orders: listOrders(),
  }
}

export function tunnelDetail(id: number, today: string = GO_LIVE_DATE) {
  const row = listTunnels().find((item) => item.id === id)
  if (!row) return null
  const status = effectiveStatus(row, today)
  return {
    row,
    effectiveStatus: status,
    inService: isInService(row, today),
    orders: ordersOfTunnel(row.管廊编号),
  }
}

export function tunnelHintFor(moduleKey: 'pipeline' | 'device' | 'envmonitor', code: string): string {
  const tunnel = listTunnels().find((item) => item.管廊编号 === code)
  if (!tunnel || effectiveStatus(tunnel) !== '已停用') return ''
  if (moduleKey === 'pipeline') return pipelineStopHint(tunnel)
  if (moduleKey === 'device') return deviceStopHint(tunnel)
  return envStopHint(tunnel)
}

export { listOrders, listTunnels, ordersOfTunnel }

/** 派工单处理：各入口处理完后回写清单，清单状态只存这一份。 */
export function resolveOrder(orderId: number): ActionResult {
  let result: ActionResult = { ok: true, message: '' }
  commit((draft) => {
    const order = draft.orders.find((item) => item.id === orderId)
    if (!order) {
      result = { ok: false, message: `派工单 ${orderId} 不存在` }
      return
    }
    if (order.状态 === '已处理') {
      result = { ok: false, message: `派工单 ${orderId} 已处理，重复回写只认第一次` }
      return
    }
    order.状态 = '已处理'
    result = { ok: true, message: `派工单 ${orderId}（${order.类型}）已回写处理结果` }
  })
  return result
}

/** 通用动作入口：其他 14 个业务模块沿用原流转方式；管廊/管线/设备/环境监测有各自的统一口径入口。 */
export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === 'pipeline' || key === 'device' || key === 'envmonitor') {
    return guardedRunAction(key, id, action)
  }
  return genericRunAction(key, id, action)
}

export function resetModule(key: string): PageResult {
  resetWorld()
  return listEntries(key)
}

export function resetAll(): void {
  resetWorld()
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
  const data = world()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = data.rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const tunnelCount = tunnelCounts(data.tunnels)
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '在运管廊', value: tunnelCount.运行中 },
    { label: '已停用管廊', value: tunnelCount.已停用 },
    { label: '待处理派工', value: data.orders.filter((order) => order.状态 === '待处理').length },
  ]
  return { cards, modules }
}
