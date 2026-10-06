import { SEED_ROWS } from './seed'
import { DRAWING_CHAMBERS, TUNNEL_LIMITS, deriveTunnelStatus } from './tunnel-policy'
import type {
  BackfillReport,
  Database,
  DedupEntry,
  DispatchItem,
  EntryRow,
  TunnelJournal,
} from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2 使用统一根节点，台账、日志、派工清单、去重记录在一次写入里同时落库（原子提交）。
const STORAGE_KEY = 'urban-utility-tunnel:db'
// v1 旧键：首次升级时把旧版纯台账数据迁进来。
const LEGACY_STORAGE_KEY = 'urban-utility-tunnel:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedDatabase(): Database {
  return {
    entries: clone(SEED_ROWS),
    tunnelJournals: [],
    dispatches: [],
    dedup: [],
    backfill: null,
  }
}

function readRaw(): Database {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedDatabase()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Database
      return normalize(parsed)
    } catch {
      // 根节点损坏时回落到种子，避免脏数据卡死页面
      const fresh = seedDatabase()
      writeRaw(fresh)
      return fresh
    }
  }

  // 首次升级：迁移旧键里的纯台账数据（老用户已在浏览器里产生过改动）。
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  const db = seedDatabase()
  if (legacy) {
    try {
      const oldEntries = JSON.parse(legacy) as Record<string, EntryRow[]>
      db.entries = { ...clone(SEED_ROWS), ...oldEntries }
    } catch {
      // 旧数据无法解析则用种子，不阻断启动
    }
  }
  writeRaw(db)
  return db
}

function normalize(parsed: Database): Database {
  const seed = seedDatabase()
  return {
    entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : seed.entries,
    tunnelJournals: Array.isArray(parsed.tunnelJournals) ? parsed.tunnelJournals : [],
    dispatches: Array.isArray(parsed.dispatches) ? parsed.dispatches : [],
    dedup: Array.isArray(parsed.dedup) ? parsed.dedup : [],
    backfill: parsed.backfill ?? null,
  }
}

function writeRaw(db: Database): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    // 台账、日志、派工清单、去重记录同一次写入，两处不会各算各的
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  }
}

let cache: Database | null = null

export function db(): Database {
  if (cache === null) {
    cache = readRaw()
  }
  return cache
}

/**
 * 原子提交：在一个事务里改台账/日志/派工/去重，最后统一落库一次。
 * 中途抛错则整笔回滚，不会出现台账改了清单没改的半成品。
 */
export function commit<T>(mutate: (draft: Database) => T): T {
  const current = db()
  const draft: Database = clone(current)
  const result = mutate(draft)
  cache = draft
  writeRaw(draft)
  return result
}

export function allRows(): Record<string, EntryRow[]> {
  return db().entries
}

export function listRows(key: string): EntryRow[] {
  return db().entries[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit((draft) => {
    draft.entries[key] = rows
  })
}

export function listJournals(): TunnelJournal[] {
  return db().tunnelJournals
}

export function listDispatches(): DispatchItem[] {
  return db().dispatches
}

export function listDedup(): DedupEntry[] {
  return db().dedup
}

export function backfillReport(): BackfillReport | null {
  return db().backfill
}

export function resetRows(key: string): EntryRow[] {
  return commit((draft) => {
    const rows = clone(SEED_ROWS[key] ?? [])
    draft.entries[key] = rows
    // 管廊相关的日志/派工/补录标记随管廊重置一并回到初始
    if (key === 'tunnel') {
      draft.tunnelJournals = []
      draft.dispatches = draft.dispatches.filter((item) => false)
      draft.backfill = null
    }
    return rows
  })
}

export function resetAll(): Database {
  const fresh = seedDatabase()
  cache = fresh
  writeRaw(fresh)
  return clone(fresh)
}

export function storageKey(): string {
  return STORAGE_KEY
}

/**
 * 一次性存量补录（幂等：已补录过直接返回既有报告；按管廊编号+业务发生日去重）。
 *
 * 补录顺序（先建后补，避免引用悬空）：
 *   1. 先整批补录上线前纸质老记录：业务发生日取投运日期，状态沿用纸质原判，
 *      标注来源「纸质台账整批补录」，按 v1 口径冻结；
 *   2. 再回填既有电子记录的缺项：
 *      - 缺舱室数量：先按竣工图纸标准断面舱数（DRAWING_CHAMBERS）补；
 *      - 图纸也没有：临时按默认舱数 1 补，单独标注「图纸缺项·待核定」，不影响在册；
 *      - 缺数据来源/口径版本：补「电子台账」「v1」，状态保留原判。
 */
export function runBackfill(now: Date = new Date()): BackfillReport {
  const existing = db().backfill
  if (existing) {
    return existing
  }

  return commit((draft) => {
    const notes: string[] = []
    let paperBackfilled = 0
    let legacyFilled = 0
    let chambersFromDrawing = 0
    let chambersMissing = 0
    const tunnels = draft.entries.tunnel ?? []

    // —— 第 1 步：上线前纸质老记录整批补录（业务发生日 = 投运日期）——
    for (const row of tunnels) {
      if (row._纸质补录 !== true) {
        continue
      }
      const bizDate = String(row.投运日期 ?? '')
      // 幂等键：同一管廊编号 + 同一业务发生日只补一次
      const already = draft.tunnelJournals.some(
        (item) => item.tunnelNo === row.管廊编号 && item.bizDate === bizDate && item.action === '存量补录',
      )
      if (already) {
        continue
      }

      // 纸质漏登舱室数量：图纸口径优先，图纸缺项则默认 1 并单独标注
      let sourceLabel: EntryRow['数据来源'] = '纸质台账整批补录'
      if (row.舱室数量 === '' || row.舱室数量 === undefined) {
        const fromDrawing = DRAWING_CHAMBERS[String(row.管廊编号)]
        if (fromDrawing !== undefined) {
          row.舱室数量 = fromDrawing
          sourceLabel = '图纸口径补录'
          chambersFromDrawing += 1
          notes.push(`${row.管廊编号} 舱室数量按竣工图纸标准断面补为 ${fromDrawing}`)
        } else {
          row.舱室数量 = TUNNEL_LIMITS.chambers.default
          sourceLabel = '图纸缺项·待核定'
          chambersMissing += 1
          notes.push(`${row.管廊编号} 图纸未标标准断面，舱室数量临时按默认 ${TUNNEL_LIMITS.chambers.default} 补，待图纸核定`)
        }
      }

      row.policy = 'v1'
      row.数据来源 = sourceLabel
      row.补录批次 = '上线前纸质整批补录'
      row.业务发生日 = bizDate
      delete row._纸质补录
      paperBackfilled += 1
      draft.tunnelJournals.push({
        id: `BF-${String(row.id)}`,
        tunnelId: Number(row.id),
        tunnelNo: String(row.管廊编号),
        action: '存量补录',
        bizDate,
        submitNo: `BACKFILL-${String(row.管廊编号)}-${bizDate}`,
        policy: 'v1',
        remark: `上线前纸质台账整批补录，业务发生日 ${bizDate}，状态沿用纸质原判「${row.status}」；来源：${sourceLabel}`,
        at: now.getTime(),
      })
    }

    // —— 第 2 步：既有电子记录缺项回填（不动状态，保留原判）——
    for (const row of tunnels) {
      if (row.policy === 'v1' && row.数据来源) {
        continue
      }
      let touched = false
      if (row.policy !== 'v2') {
        row.policy = 'v1'
        touched = true
      }
      if (!row.数据来源) {
        row.数据来源 = '电子台账'
        touched = true
      }
      if (row.舱室数量 === '' || row.舱室数量 === undefined) {
        const fromDrawing = DRAWING_CHAMBERS[String(row.管廊编号)]
        if (fromDrawing !== undefined) {
          row.舱室数量 = fromDrawing
          row.数据来源 = '图纸口径补录'
          chambersFromDrawing += 1
          notes.push(`${row.管廊编号} 舱室数量按图纸补为 ${fromDrawing}`)
        } else {
          row.舱室数量 = TUNNEL_LIMITS.chambers.default
          row.数据来源 = '图纸缺项·待核定'
          chambersMissing += 1
          notes.push(`${row.管廊编号} 舱室数量按默认 ${TUNNEL_LIMITS.chambers.default} 临时补，待核定`)
        }
        touched = true
      }
      if (touched) {
        legacyFilled += 1
      }
    }

    // 回填后统一过一遍状态口径：v1 保留原判，仅校正 pending/abnormal 标志位
    for (const row of draft.entries.tunnel ?? []) {
      const verdict = deriveTunnelStatus(row, now)
      row.status = verdict.status
      row.pending = verdict.status !== '已停用'
      row.abnormal = false
    }

    const runAt = now.toISOString()
    const report: BackfillReport = {
      runAt,
      paperBackfilled,
      legacyFilled,
      chambersFromDrawing,
      chambersMissing,
      notes: [
        `纸质老记录整批补录 ${paperBackfilled} 条（业务发生日=投运日期，v1 冻结）`,
        `既有电子记录缺项回填 ${legacyFilled} 条`,
        `舱室数量取图纸口径 ${chambersFromDrawing} 条；图纸缺项临时按默认 ${TUNNEL_LIMITS.chambers.default} 补 ${chambersMissing} 条`,
        ...notes,
      ],
    }
    draft.backfill = report
    return report
  })
}
