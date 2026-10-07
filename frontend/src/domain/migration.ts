/**
 * 存量数据整批补录（一次性迁移）
 *
 * 裁决口径（自洽、可复算）：
 * 1. 改版上线日（GO_LIVE_DATE）之前的老记录一律按「业务发生日」（管廊取投运日期）整批补录，
 *    补录顺序：投运日期升序 → 管廊编号升序（早发生先落账，保证同一批数据任何时候重跑结果一致）。
 * 2. 同一管廊编号出现两笔：只认先落账的一笔，另一笔不进台账，开「重复提交驳回单」写明理由。
 * 3. 存量记录保留原判（version=1，状态依据=老口径原判），新版统一口径不重判老记录。
 * 4. 舱室数量缺项（0/空/早年没登记）按图纸口径补，取值优先级：
 *    a. 竣工图纸标注值（来源：竣工图纸）；
 *    b. 图纸也缺失时，取同片区、同结构类型、已登记舱室数量的中位数（来源：同片区同结构推断，待核实）；
 *    c. 同片区同结构也没有参照时，补 1（默认值，待核实），并开「缺项核补单」限期对照图纸核实。
 *    总长度缺项同口径处理；推断值、默认值都不静默采用，逐字段标注来源。
 * 5. 停用老记录沿用老停用口径（最后一条管线迁出日），只用于回填停用日期，不改变其「已停用」原判。
 */

import { FIELD_RULES, GO_LIVE_DATE, missingDispatchOpinion, stopDispatchOpinion } from './tunnel-rules'
import type { ActionReceipt, DispatchOrder, TunnelRow } from './types'

const MIGRATION_BATCH = `存量补录@${GO_LIVE_DATE}`

type LegacySeed = Record<string, string | number | undefined>

type RelatedSeed = { 所属管廊: string; 编号: string; status?: string }

export type MigrationResult = {
  tunnels: TunnelRow[]
  orders: DispatchOrder[]
  receipts: ActionReceipt[]
  rejected: { 管廊编号: string; reason: string }[]
}

export function migrateTunnels(
  rawSeeds: LegacySeed[],
  related: {
    pipelines: (RelatedSeed & { 迁出日期?: string })[]
    devices: RelatedSeed[]
    monitors: RelatedSeed[]
  },
  today: string = GO_LIVE_DATE,
): MigrationResult {
  // ① 按业务发生日（投运日期）升序、编号升序整批排队，顺序即落账顺序。
  const queued = [...rawSeeds].sort((a, b) => {
    const da = String(a.投运日期 ?? '')
    const db = String(b.投运日期 ?? '')
    if (da !== db) return da < db ? -1 : 1
    return String(a.管廊编号 ?? '') < String(b.管廊编号 ?? '') ? -1 : 1
  })

  const accepted = new Map<string, TunnelRow>()
  const rejected: { 管廊编号: string; reason: string }[] = []
  const orders: DispatchOrder[] = []
  const receipts: ActionReceipt[] = []
  let orderSeq = 1
  const nextOrderId = () => orderSeq++

  // 老口径停用日：最后一条管线迁出日（只在补录时用于回填该字段，不参与新版判定）。
  const stopDateByTunnel = new Map<string, string>()
  for (const pipe of related.pipelines) {
    if (!pipe.迁出日期) continue
    const prev = stopDateByTunnel.get(pipe.所属管廊)
    if (!prev || pipe.迁出日期 > prev) stopDateByTunnel.set(pipe.所属管廊, pipe.迁出日期)
  }

  for (const seed of queued) {
    const code = String(seed.管廊编号 ?? '').trim()

    // ② 同一管廊编号只认先落账的一笔，后到的按重复挡回，台账与派工清单同时留痕。
    if (accepted.has(code)) {
      const reason = `同一管廊 ${code} 在存量补录批次中出现两笔提交，按「先落账为准」只认投运日期更早的首笔，本笔按重复挡回，不进入台账。`
      rejected.push({ 管廊编号: code, reason })
      orders.push({
        id: nextOrderId(),
        idemKey: `backfill-dup-${code}`,
        管廊编号: code,
        管廊名称: String(seed.管廊名称 ?? code),
        类型: '重复提交驳回单',
        来源: '历史补录',
        处理意见: reason,
        涉及管线: [],
        涉及设备: [],
        涉及监测点: [],
        状态: '待处理',
        业务发生日: String(seed.投运日期 ?? today),
        落单时间: GO_LIVE_DATE,
      })
      continue
    }

    // ④ 舱室数量图纸口径补录
    const cabin = fillCabinCount(seed, accepted)
    // 总长度缺项补录
    const length = fillLength(seed, accepted)

    const status = normalizeLegacyStatus(String(seed.status ?? seed.管廊状态 ?? ''))
    const stopDate = status === '已停用'
      ? String(seed.停用日期 ?? stopDateByTunnel.get(code) ?? seed.投运日期 ?? '')
      : ''

    const row: TunnelRow = {
      id: Number(seed.id ?? accepted.size + 1),
      status,
      pending: status !== '已停用',
      abnormal: false,
      version: 1,
      管廊编号: code,
      管廊名称: String(seed.管廊名称 ?? ''),
      所属片区: String(seed.所属片区 ?? ''),
      舱室数量: cabin.value,
      舱室数量来源: cabin.source,
      总长度: length.value,
      总长度来源: length.source,
      结构类型: String(seed.结构类型 ?? ''),
      投运日期: String(seed.投运日期 ?? ''),
      投运日期来源: seed.投运日期 ? '登记填报' : '默认值待核实',
      停用日期: stopDate,
      停用原因: status === '已停用' ? String(seed.停用原因 ?? '存量补录：老口径停用（末条管线迁出）') : '',
      状态依据: '老口径原判（投运按投运日期、停用按末条管线迁出日期的双口径时期判定，改版后保留原判）',
      补录批次: MIGRATION_BATCH,
      管廊状态: status,
      rowVersion: 1,
      检修完工日: String(seed.检修完工日 ?? ''),
    }
    accepted.set(code, row)

    // 存量已停用管廊：补录时同步补一张停用告知单（来源=历史补录），
    // 设备台账与环境监测两侧读到的停用口径与新停用完全一致，只是来源标记不同。
    if (status === '已停用') {
      const pipes = related.pipelines
        .filter((item) => item.所属管廊 === code && item.status !== '已迁出')
        .map((item) => item.编号)
      const devices = related.devices
        .filter((item) => item.所属管廊 === code && item.status !== '已报废')
        .map((item) => item.编号)
      const monitors = related.monitors
        .filter((item) => item.所属管廊 === code)
        .map((item) => item.编号)
      orders.push({
        id: nextOrderId(),
        idemKey: `stop-${code}`,
        管廊编号: code,
        管廊名称: row.管廊名称,
        类型: '停用告知单',
        来源: '历史补录',
        处理意见: stopDispatchOpinion({ tunnel: row, pipelines: pipes, devices, monitors }),
        涉及管线: pipes,
        涉及设备: devices,
        涉及监测点: monitors,
        状态: '待处理',
        业务发生日: stopDate || row.投运日期 || today,
        落单时间: GO_LIVE_DATE,
      })
    }

    // 缺项单独标注来源，并开缺项核补单（推断值、默认值必须限期核实）。
    const missingDesc: string[] = []
    if (cabin.needVerify) {
      missingDesc.push(`舱室数量原值缺失，按${cabin.source}补录为 ${cabin.value}`)
    }
    if (length.needVerify) {
      missingDesc.push(`总长度原值缺失，按${length.source}补录为 ${length.value} 米`)
    }
    if (!seed.投运日期) {
      missingDesc.push('投运日期原始登记缺失')
    }
    if (missingDesc.length) {
      orders.push({
        id: nextOrderId(),
        idemKey: `backfill-missing-${code}`,
        管廊编号: code,
        管廊名称: row.管廊名称,
        类型: '缺项核补单',
        来源: '历史补录',
        处理意见: missingDispatchOpinion(`管廊 ${code}：${missingDesc.join('；')}。`),
        涉及管线: [],
        涉及设备: [],
        涉及监测点: [],
        状态: '待处理',
        业务发生日: row.投运日期 || today,
        落单时间: GO_LIVE_DATE,
      })
    }

    receipts.push({
      idemKey: `backfill-${code}`,
      module: 'tunnel',
      rowId: row.id,
      action: '存量补录',
      at: GO_LIVE_DATE,
    })
  }

  return {
    tunnels: [...accepted.values()].sort((a, b) => a.id - b.id),
    orders,
    receipts,
    rejected,
  }
}

type FillResult = { value: number; source: string; needVerify: boolean }

/** 舱室数量图纸口径：图纸值 → 同片区同结构中位数 → 默认 1（待核实）。 */
function fillCabinCount(seed: LegacySeed, accepted: Map<string, TunnelRow>): FillResult {
  const raw = seed.舱室数量
  const rawNum = typeof raw === 'number' ? raw : Number(raw)
  if (raw !== undefined && raw !== '' && !Number.isNaN(rawNum)) {
    if (Number.isInteger(rawNum) && rawNum >= FIELD_RULES.舱室数量.min && rawNum <= FIELD_RULES.舱室数量.max) {
      return { value: rawNum, source: '登记填报', needVerify: false }
    }
  }
  // a. 竣工图纸
  const drawing = Number(seed.图纸舱室数量)
  if (seed.图纸舱室数量 !== undefined && Number.isInteger(drawing) && drawing >= 1) {
    return { value: drawing, source: '竣工图纸', needVerify: false }
  }
  // b. 同片区同结构中位数
  const median = medianOfPeers(String(seed.所属片区 ?? ''), String(seed.结构类型 ?? ''), accepted)
  if (median !== null) {
    return { value: median, source: '同片区同结构推断（待核实）', needVerify: true }
  }
  // c. 默认值兜底
  return { value: FIELD_RULES.舱室数量.backfillDefault ?? 1, source: '默认值（待核实）', needVerify: true }
}

function fillLength(seed: LegacySeed, accepted: Map<string, TunnelRow>): FillResult {
  const raw = seed.总长度
  const rawNum = typeof raw === 'number' ? raw : Number(raw)
  if (typeof raw === 'number' && rawNum >= FIELD_RULES.总长度.min && rawNum <= FIELD_RULES.总长度.max) {
    return { value: rawNum, source: '登记填报', needVerify: false }
  }
  const drawing = Number(seed.图纸总长度)
  if (seed.图纸总长度 !== undefined && drawing >= FIELD_RULES.总长度.min) {
    return { value: Math.round(drawing * 10) / 10, source: '竣工图纸', needVerify: false }
  }
  const peers = [...accepted.values()]
    .filter((row) => row.所属片区 === String(seed.所属片区 ?? '') && row.结构类型 === String(seed.结构类型 ?? '') && row.总长度来源 === '登记填报')
    .map((row) => row.总长度)
    .sort((a, b) => a - b)
  if (peers.length) {
    const mid = peers[Math.floor(peers.length / 2)]
    return { value: Math.round(mid * 10) / 10, source: '同片区同结构推断（待核实）', needVerify: true }
  }
  return { value: 100, source: '默认值（待核实）', needVerify: true }
}

function medianOfPeers(area: string, structure: string, accepted: Map<string, TunnelRow>): number | null {
  const values = [...accepted.values()]
    .filter((row) => row.所属片区 === area && row.结构类型 === structure)
    .map((row) => row.舱室数量)
    .sort((a, b) => a - b)
  if (!values.length) return null
  return values[Math.floor(values.length / 2)]
}

function normalizeLegacyStatus(raw: string): TunnelRow['status'] {
  const allowed = ['待投运', '运行中', '检修中', '已停用']
  if (allowed.includes(raw)) return raw as TunnelRow['status']
  return '待投运'
}
