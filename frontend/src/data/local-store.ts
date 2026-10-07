import { SEED_ROWS } from './seed'
import { migrateTunnels } from '@/domain/migration'
import { GO_LIVE_DATE } from '@/domain/tunnel-rules'
import type { ActionReceipt, DispatchOrder, TunnelRow } from '@/domain/types'
import type { EntryRow } from './types'

// 本地持久化：第二版口径使用独立 key。老 key 的数据不会被覆盖；
// 全新打开（或老用户首次打开第二版）时，按存量补录裁决一次性建账。
const STORAGE_KEY = 'urban-utility-tunnel:world:v2'
const LEGACY_STORAGE_KEY = 'urban-utility-tunnel:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 第二版世界：管廊、管线、设备、监测点、派工清单、动作回执放在同一份数据里，更新同进同出。 */
export type World = {
  schema: 2
  migratedAt: string
  rows: Record<string, EntryRow[]>
  tunnels: TunnelRow[]
  orders: DispatchOrder[]
  receipts: ActionReceipt[]
  /** 派工自增序号 */
  orderSeq: number
}

function buildWorld(): World {
  const seed = clone(SEED_ROWS)
  const related = {
    pipelines: (seed.pipeline ?? []).map((row) => ({
      所属管廊: String(row.所属管廊 ?? ''),
      编号: String(row.管线编号 ?? ''),
      status: String(row.status ?? ''),
      迁出日期: row.status === '已迁出' ? String(row.迁出日期 ?? row.入廊日期 ?? '') : '',
    })),
    devices: (seed.device ?? []).map((row) => ({
      所属管廊: String(row.所属管廊 ?? ''),
      编号: String(row.设备编号 ?? ''),
      status: String(row.status ?? ''),
    })),
    monitors: (seed.envmonitor ?? []).map((row) => ({
      所属管廊: String(row.所属管廊 ?? ''),
      编号: String(row.监测编号 ?? ''),
      status: String(row.status ?? ''),
    })),
  }

  // 存量管廊整批补录：按业务发生日排序、首笔先落、重复挡回、图纸口径补缺项。
  const legacyTunnelSeeds = (seed.tunnel ?? []) as unknown as Record<string, string | number | undefined>[]
  const migrated = migrateTunnels(legacyTunnelSeeds, related, GO_LIVE_DATE)

  // 存量停用管廊：把停用口径回写到管线/设备/监测台账，三侧读到的提示与新停用同源。
  const stopHints = new Map(
    migrated.tunnels.filter((row) => row.status === '已停用').map((row) => [row.管廊编号, row]),
  )
  for (const row of seed.pipeline ?? []) {
    const tunnel = stopHints.get(String(row.所属管廊 ?? ''))
    if (tunnel && row.status !== '已迁出') {
      row.停用口径提示 = `所属管廊 ${tunnel.管廊编号} 已于 ${tunnel.停用日期} 停用，按停用口径仅可办理迁出（历史补录）。`
    }
  }
  for (const row of seed.device ?? []) {
    const tunnel = stopHints.get(String(row.所属管廊 ?? ''))
    if (tunnel && row.status !== '已报废') {
      row.停用口径提示 = `所属管廊 ${tunnel.管廊编号} 已于 ${tunnel.停用日期} 停用，按停用口径仅可办理报废（历史补录）。`
    }
  }
  for (const row of seed.envmonitor ?? []) {
    const tunnel = stopHints.get(String(row.所属管廊 ?? ''))
    if (tunnel) {
      row.停用口径提示 = `所属管廊 ${tunnel.管廊编号} 已于 ${tunnel.停用日期} 停用，监测点按停用口径冻结（历史补录）。`
    }
  }

  const world: World = {
    schema: 2,
    migratedAt: GO_LIVE_DATE,
    rows: seed,
    tunnels: migrated.tunnels,
    orders: migrated.orders,
    receipts: migrated.receipts,
    orderSeq: migrated.orders.length + 1,
  }
  // 迁移结论同步回台账列表模块：列表与派工清单取到的是同一份停用口径。
  world.rows.tunnel = clone(migrated.tunnels) as unknown as EntryRow[]
  return world
}

function readStorage(): World {
  if (typeof window === 'undefined' || !window.localStorage) {
    return buildWorld()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as World
      if (parsed.schema === 2) return parsed
    } catch {
      // 损坏数据不使用，落到重建
    }
  }
  const world = buildWorld()
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(world))
  return world
}

let cache: World | null = null

export function world(): World {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 所有写操作都通过 commit：台账（tunnels + rows.tunnel）、清单（orders）、回执一次落账，不允许各算各的。 */
export function commit(mutator: (draft: World) => void): World {
  const next = clone(world())
  mutator(next)
  // 台账镜像始终与 tunnels 同源
  next.rows.tunnel = clone(next.tunnels) as unknown as EntryRow[]
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

export function listRows(key: string): EntryRow[] {
  return world().rows[key] ?? []
}

export function listTunnels(): TunnelRow[] {
  return world().tunnels
}

export function listOrders(): DispatchOrder[] {
  return [...world().orders].sort((a, b) => (a.落单时间 < b.落单时间 ? 1 : a.落单时间 > b.落单时间 ? -1 : b.id - a.id))
}

export function listReceipts(): ActionReceipt[] {
  return world().receipts
}

export function findTunnel(code: string): TunnelRow | undefined {
  return world().tunnels.find((row) => row.管廊编号 === code)
}

/** 按管廊编号取派工清单：管线、设备、环境监测、派工页读同一份。 */
export function ordersOfTunnel(code: string): DispatchOrder[] {
  return listOrders().filter((order) => order.管廊编号 === code)
}

export function nextOrderId(w: World): number {
  return w.orderSeq++
}

export function resetWorld(): World {
  const fresh = buildWorld()
  cache = fresh
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
  }
  return fresh
}

export { LEGACY_STORAGE_KEY }
