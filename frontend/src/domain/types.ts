/** 管廊主体统一口径（第二版，RULE_VERSION = 2）涉及的领域类型。 */

/** 管廊三态 + 投运前的登记态。判定口径全平台只有这一份。 */
export type TunnelStatus = '待投运' | '运行中' | '检修中' | '已停用'

/** 判定口径版本：既有记录挂 1（老口径保留原判），改版后新记录挂 2（统一口径）。 */
export type RuleVersion = 1 | 2

/** 补录/登记时每一个补出来的字段都要带来源，缺项单独标注。 */
export type FieldSource =
  | '登记填报'
  | '竣工图纸'
  | '同片区同结构推断'
  | '默认值待核实'
  | '老口径原判'

/** 派工清单条目：处理意见只写这一份，管线、设备、环境监测、派工页读同一张表。 */
export type DispatchOrder = {
  id: number
  /** 业务幂等键：同一管廊同一类型只允许一笔先落单，重复提交直接挡回。 */
  idemKey: string
  管廊编号: string
  管廊名称: string
  类型: '停用告知单' | '缺项核补单' | '重复提交驳回单'
  来源: '停用操作' | '历史补录'
  处理意见: string
  涉及管线: string[]
  涉及设备: string[]
  涉及监测点: string[]
  状态: '待处理' | '已处理'
  业务发生日: string
  落单时间: string
}

/** 动作回执：幂等账册，同一行（或同一补录业务键）两笔并发时只认先落账的一笔。 */
export type ActionReceipt = {
  idemKey: string
  module: string
  rowId: number
  action: string
  at: string
}

/** 带版本与来源标记的管廊台账行。 */
export type TunnelRow = {
  id: number
  status: TunnelStatus
  pending: boolean
  abnormal: boolean
  version: RuleVersion
  管廊编号: string
  管廊名称: string
  所属片区: string
  舱室数量: number
  舱室数量来源: string
  总长度: number
  总长度来源: string
  结构类型: string
  投运日期: string
  投运日期来源: string
  停用日期: string
  停用原因: string
  状态依据: string
  补录批次: string
  管廊状态: string
  检修完工日: string
  rowVersion: number
  [field: string]: string | number | boolean | string[]
}
