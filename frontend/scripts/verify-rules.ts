/**
 * 统一口径端到端核验（node 脚本，不依赖浏览器）：
 *   npx esbuild scripts/verify-rules.ts --bundle --platform=node --format=cjs | node
 * 覆盖：存量补录顺序/重复挡回/图纸补舱、越界驳回、状态三态一致、停用幂等、并发版本挡回、
 *       停用两侧同口径、台账与清单同事务、在运统计联动。
 */
// localStorage 垫片：local-store 在无浏览器环境下直接走 buildWorld()，这里仍给一个空实现。
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: () => null,
    setItem: () => undefined,
  },
}

import { SEED_ROWS } from '../src/data/seed'
import { migrateTunnels } from '../src/domain/migration'
import {
  FIELD_RULES,
  effectiveStatus,
  tunnelCounts,
  validateTunnelDraft,
  pipelineStopHint,
  deviceStopHint,
  envStopHint,
} from '../src/domain/tunnel-rules'
import {
  createTunnel,
  resetAll,
  tunnelAction,
  tunnelBoard,
  tunnelHintFor,
  guardedRunAction,
  listOrders,
} from '../src/api/local-service'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

console.log('\n① 存量补录：业务发生日排序、首笔先落、重复挡回、图纸口径补缺项')
{
  const related = {
    pipelines: (SEED_ROWS.pipeline ?? []).map((row) => ({
      所属管廊: String(row.所属管廊 ?? ''),
      编号: String(row.管线编号 ?? ''),
      status: String(row.status ?? ''),
      迁出日期: row.status === '已迁出' ? String(row.迁出日期 ?? '') : '',
    })),
    devices: (SEED_ROWS.device ?? []).map((row) => ({
      所属管廊: String(row.所属管廊 ?? ''),
      编号: String(row.设备编号 ?? ''),
      status: String(row.status ?? ''),
    })),
    monitors: (SEED_ROWS.envmonitor ?? []).map((row) => ({
      所属管廊: String(row.所属管廊 ?? ''),
      编号: String(row.监测编号 ?? ''),
      status: String(row.status ?? ''),
    })),
  }
  const result = migrateTunnels(SEED_ROWS.tunnel as never[], related)
  const codes = result.tunnels.map((row) => row.管廊编号)

  check('TUNN-0009 只保留首笔（重复笔不进台账）', codes.filter((code) => code === 'TUNN-0009').length === 1)
  check('TUNN-0009 保留的是早期登记笔', result.tunnels.find((row) => row.管廊编号 === 'TUNN-0009')?.管廊名称.includes('早期登记笔') === true)
  check('重复笔生成「重复提交驳回单」', result.orders.some((order) => order.类型 === '重复提交驳回单' && order.管廊编号 === 'TUNN-0009'))
  check('补录总数 9 条（10 笔种子去掉 1 笔重复被挡）', result.tunnels.length === 9, `实际 ${result.tunnels.length}`)
  check('补录按投运日期升序落账（首笔为 2018 年 TUNN-0001）', result.tunnels[0].管廊编号 === 'TUNN-0001')

  const t1 = result.tunnels.find((row) => row.管廊编号 === 'TUNN-0001')!
  check('停用老记录保留原判（v1、已停用）', t1.version === 1 && t1.status === '已停用')
  check('老停用口径回填停用日=末条管线迁出日 2024-11-20', t1.停用日期 === '2024-11-20', t1.停用日期)
  const legacyStopOrder = result.orders.find((order) => order.idemKey === 'stop-TUNN-0001')
  check('存量停用管廊补「停用告知单」且来源=历史补录', !!legacyStopOrder && legacyStopOrder.来源 === '历史补录')
  check('历史停用告知单三侧口径齐全（管线/设备/监测）', !!legacyStopOrder && legacyStopOrder.处理意见.includes('入廊管线') && legacyStopOrder.处理意见.includes('在册设备') && legacyStopOrder.处理意见.includes('环境监测'))
  check('停用告知单业务发生日按停用口径日（2024-11-20）', legacyStopOrder?.业务发生日 === '2024-11-20')

  const t2 = result.tunnels.find((row) => row.管廊编号 === 'TUNN-0002')!
  check('舱室数量 0 按竣工图纸补为 2', t2.舱室数量 === 2 && t2.舱室数量来源 === '竣工图纸')
  check('图纸补录不开缺项核补单', !result.orders.some((order) => order.管廊编号 === 'TUNN-0002' && order.类型 === '缺项核补单'))

  const t3 = result.tunnels.find((row) => row.管廊编号 === 'TUNN-0003')!
  check('无图纸时按同片区同结构中位数补（中心城区双舱参照 TUNN-0006 的 2）', t3.舱室数量 === 2 && t3.舱室数量来源.includes('同片区同结构'))
  check('推断值开缺项核补单', result.orders.some((order) => order.管廊编号 === 'TUNN-0003' && order.类型 === '缺项核补单'))

  const t4 = result.tunnels.find((row) => row.管廊编号 === 'TUNN-0004')!
  check('无同片区参照时兜底 1 并标注默认值待核实', t4.舱室数量 === 1 && t4.舱室数量来源.includes('默认值'))
  check('兜底值开缺项核补单', result.orders.some((order) => order.管廊编号 === 'TUNN-0004' && order.类型 === '缺项核补单'))

  const t5 = result.tunnels.find((row) => row.管廊编号 === 'TUNN-0005')!
  check('投运日 2026-12-01 在将来：v1 记录保留原「待投运」判', effectiveStatus(t5) === '待投运')
  check('全部存量记录标 v1 老口径原判', result.tunnels.every((row) => row.version === 1 && row.状态依据.includes('老口径')))
}

console.log('\n② 字段允许区间：越界直接驳回并说明理由')
{
  const range = FIELD_RULES.舱室数量
  check('舱室数量下限 1（0 不能保存）', range.min === 1)
  check('舱室数量上限 50', range.max === 50)
  const base = {
    管廊编号: 'TUNN-0099',
    管廊名称: '测试管廊',
    所属片区: '测试片区',
    舱室数量: 1,
    总长度: 1000,
    结构类型: '双舱',
    投运日期: '2026-09-01',
  }
  check('舱室数量 0 驳回', validateTunnelDraft({ ...base, 舱室数量: 0 }, new Set()).ok === false)
  check('舱室数量 51 驳回', validateTunnelDraft({ ...base, 舱室数量: 51 }, new Set()).ok === false)
  check('舱室数量 2.5 驳回', validateTunnelDraft({ ...base, 舱室数量: 2.5 }, new Set()).ok === false)
  check('舱室数量 1 通过', validateTunnelDraft({ ...base, 舱室数量: 1 }, new Set()).ok === true)
  check('登记允许未来投运日（先挂待投运）', validateTunnelDraft({ ...base, 投运日期: '2026-12-31' }, new Set(), '2026-10-07', true).ok === true)
  check('直接投运时未来日期驳回', validateTunnelDraft({ ...base, 投运日期: '2026-12-31' }, new Set(), '2026-10-07', false).ok === false)
  check('编号重复驳回', validateTunnelDraft({ ...base, 管廊编号: 'TUNN-0001' }, new Set(['TUNN-0001'])).ok === false)
  check('编号格式错驳回', validateTunnelDraft({ ...base, 管廊编号: 'GD-1' }, new Set()).ok === false)
}

console.log('\n③ 服务层：登记、三态判定、列表/详情/页脚同源、停用联动与幂等')
{
  resetAll()
  const board0 = tunnelBoard()
  check('迁移后在运管廊 6 条（TUNN-2/3/4/6/8/9；7 检修、1 停用、5 待投运）', board0.counts.运行中 === 6, `实际 ${board0.counts.运行中}`)
  check('检修中 1、已停用 1、待投运 1', board0.counts.检修中 === 1 && board0.counts.已停用 === 1 && board0.counts.待投运 === 1)

  // 登记：舱室 0 被驳回
  const bad = createTunnel({
    管廊编号: 'TUNN-0100',
    管廊名称: '越界测试',
    所属片区: '测试片区',
    舱室数量: 0,
    总长度: 500,
    结构类型: '单舱',
    投运日期: '2026-10-01',
  })
  check('登记时舱室数量 0 被驳回且带理由', !bad.ok && bad.message.includes('舱室数量'))

  const good = createTunnel({
    管廊编号: 'TUNN-0100',
    管廊名称: '新登记管廊',
    所属片区: '测试片区',
    舱室数量: 3,
    总长度: 500,
    结构类型: '三舱',
    投运日期: '2026-10-01',
  })
  check('合规登记成功（先挂待投运，投运由动作单独落账）', good.ok && effectiveStatus(good.row) === '待投运')
  check('新记录挂 v2 统一口径', good.row.version === 2)
  const commission = tunnelAction(good.row.id, '提交投运', { expectedVersion: good.row.rowVersion })
  check('提交投运后转运行中', commission.ok && effectiveStatus(tunnelBoard().tunnels.find((t) => t.id === good.row.id)!) === '运行中')

  // 重复编号登记挡回
  const dup = createTunnel({
    管廊编号: 'TUNN-0100',
    管廊名称: '重复登记',
    所属片区: '测试片区',
    舱室数量: 2,
    总长度: 500,
    结构类型: '双舱',
    投运日期: '2026-10-02',
  })
  check('同一管廊重复登记按重复挡回', !dup.ok && dup.message.includes('重复'))

  // 状态机：检修 → 完工复运；待投运不能停用
  const future = tunnelBoard().tunnels.find((row) => row.管廊编号 === 'TUNN-0005')!
  const stopIdle = tunnelAction(future.id, '停用管廊', { expectedVersion: future.rowVersion })
  check('待投运管廊停用被驳回', !stopIdle.ok && stopIdle.message.includes('待投运'))

  const run = tunnelBoard().tunnels.find((row) => row.管廊编号 === 'TUNN-0006')!
  const repair = tunnelAction(run.id, '安排检修', { expectedVersion: run.rowVersion, 检修工期: 10 })
  check('运行中安排检修成功（工期 10 天）', repair.ok)
  const runAgain = tunnelAction(run.id, '安排检修', { expectedVersion: run.rowVersion + 1, 检修工期: 10 })
  check('检修中再次安排检修被状态机驳回', !runAgain.ok)
  const badDays = tunnelAction(tunnelBoard().tunnels.find((row) => row.管廊编号 === 'TUNN-0008')!.id, '安排检修', { 检修工期: 0 })
  check('检修工期 0 天被驳回', !badDays.ok && badDays.message.includes('1～180'))

  // 停用：一次生效，重复停用挡回（幂等账册 + 终态双保险）
  const target = tunnelBoard().tunnels.find((row) => row.管廊编号 === 'TUNN-0008')!
  const stop1 = tunnelAction(target.id, '停用管廊', { expectedVersion: target.rowVersion, 停用原因: '测试停用' })
  check('首次停用成功并联动派工', stop1.ok)
  const stoppedRow = tunnelBoard().tunnels.find((row) => row.管廊编号 === 'TUNN-0008')!
  check('停用后页脚在运数减少（联动更新，6→5）', tunnelBoard().counts.运行中 === 5)
  const stop2 = tunnelAction(stoppedRow.id, '停用管廊', { expectedVersion: stoppedRow.rowVersion })
  check('重复停用只生效一次，第二笔挡回', !stop2.ok && (stop2.message.includes('终态') || stop2.message.includes('重复')))

  const stopOrder = listOrders().find((order) => order.idemKey === 'stop-TUNN-0008')
  check('停用只生成一张停用告知单（幂等）', listOrders().filter((order) => order.idemKey === 'stop-TUNN-0008').length === 1)
  check('停用告知单含管线/设备/监测三条统一口径', !!stopOrder && stopOrder.处理意见.includes('入廊管线') && stopOrder.处理意见.includes('在册设备') && stopOrder.处理意见.includes('环境监测'))
}

console.log('\n④ 并发：同一行两笔同时提交只认先落账（行版本锁 + 幂等账册）')
{
  resetAll()
  const target = tunnelBoard().tunnels.find((row) => row.管廊编号 === 'TUNN-0003')!
  const first = tunnelAction(target.id, '停用管廊', { expectedVersion: target.rowVersion })
  const secondStaleVersion = tunnelAction(target.id, '停用管廊', { expectedVersion: target.rowVersion })
  check('先落账一笔成功', first.ok)
  check('同版本号并发的第二笔被挡回', !secondStaleVersion.ok && (secondStaleVersion.message.includes('已被先到') || secondStaleVersion.message.includes('终态')))

  // 同一幂等键跨入口只认一笔
  const fresh = tunnelBoard().tunnels.find((row) => row.管廊编号 === 'TUNN-0004')!
  const a = tunnelAction(fresh.id, '停用管廊', { expectedVersion: fresh.rowVersion, idemKey: 'race-TUNN-0004' })
  const b = tunnelAction(fresh.id, '停用管廊', { expectedVersion: fresh.rowVersion + 1, idemKey: 'race-TUNN-0004' })
  check('显式同幂等键：先到成功、后到重复挡回', a.ok && !b.ok)
}

console.log('\n⑤ 停用两侧同口径：管线 / 设备 / 环境监测读到同一句，动作按停用口径守卫')
{
  resetAll()
  // TUNN-0001 存量即停用：其下管线两条已迁出，设备已报废，监测点封存
  check('管线侧读到停用口径', tunnelHintFor('pipeline', 'TUNN-0001').includes('仅允许办理迁出'))
  check('设备侧读到停用口径', tunnelHintFor('device', 'TUNN-0001').includes('仅允许办理报废'))
  check('监测侧读到停用口径', tunnelHintFor('envmonitor', 'TUNN-0001').includes('冻结'))
  check('两侧口径同源（同一条停用事实）', pipelineStopHint({ 管廊编号: 'X', 管廊名称: 'Y', 停用日期: '2026-10-07' }).startsWith('所属管廊 X'))
  check('运行中管廊三侧不提示停用', tunnelHintFor('pipeline', 'TUNN-0002') === '')

  // 停用一个有在廊管线/设备/监测点的管廊 TUNN-0002，验证守卫与台账同步
  const target = tunnelBoard().tunnels.find((row) => row.管廊编号 === 'TUNN-0002')!
  tunnelAction(target.id, '停用管廊', { expectedVersion: target.rowVersion })
  check('停用后管线侧立即读到停用口径', tunnelHintFor('pipeline', 'TUNN-0002').includes('停用'))
  check('停用后设备侧立即读到停用口径', tunnelHintFor('device', 'TUNN-0002').includes('停用'))
  check('停用后监测侧立即读到停用口径', tunnelHintFor('envmonitor', 'TUNN-0002').includes('冻结'))

  const pipe = SEED_ROWS.pipeline.find((row) => String(row.管线编号) === 'PIPE-0003')!
  const denyRun = guardedRunAction('pipeline', Number(pipe.id), '确认运行')
  check('停用管廊下「确认运行」被挡回', !denyRun.ok && denyRun.message.includes('停用'))
  const allowMove = guardedRunAction('pipeline', Number(pipe.id), '办理迁出')
  check('停用管廊下「办理迁出」放行', allowMove.ok)

  const dev = SEED_ROWS.device.find((row) => String(row.设备编号) === 'DEVI-0001')!
  const denyMaint = guardedRunAction('device', Number(dev.id), '完成保养')
  check('停用管廊下设备保养被挡回', !denyMaint.ok && denyMaint.message.includes('停用'))

  const monitor = SEED_ROWS.envmonitor.find((row) => String(row.监测编号) === 'ENVM-0001')!
  const denyCollect = guardedRunAction('envmonitor', Number(monitor.id), '判定正常')
  check('停用管廊下监测判定一律挡回', !denyCollect.ok && denyCollect.message.includes('冻结'))

  // 台账与清单同事务：停用告知单涉及对象与两侧台账一致
  const order = listOrders().find((item) => item.idemKey === 'stop-TUNN-0002')!
  check('停用告知单关联到在廊管线/在册设备/监测点', order.涉及管线.includes('PIPE-0003') && order.涉及设备.includes('DEVI-0001') && order.涉及监测点.includes('ENVM-0001'))

  const counts = tunnelCounts(tunnelBoard().tunnels)
  check('台账更新后统计同步（在运 6→5）', counts.运行中 === 5, `实际 ${counts.运行中}`)
}

console.log(`\n核验结果：${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) {
  process.exit(1)
}
