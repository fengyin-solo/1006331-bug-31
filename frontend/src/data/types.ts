/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 口径版本：v1=改版前既有记录（保留原判），v2=本次改版后的统一口径（仅对新记录生效）。 */
export type PolicyVersion = 'v1' | 'v2'

/** 数据来源标注：缺项补录时单独标注来源，便于追溯。 */
export type DataSource = '电子台账' | '纸质台账整批补录' | '图纸口径补录' | '图纸缺项·待核定'

/** 管廊主体业务操作日志（投运/检修/停用各一条，停用每座管廊全局只落一条）。 */
export type TunnelJournal = {
  id: string
  tunnelId: number
  tunnelNo: string
  action: string
  bizDate: string
  submitNo: string
  policy: PolicyVersion
  remark: string
  at: number
}

/** 停用处理意见：同一份口径写入派工清单，检修管理与入廊作业审批两个入口读到同一份。 */
export type DispatchItem = {
  id: string
  tunnelId: number
  tunnelNo: string
  tunnelName: string
  target: 'maintenance' | 'entryapprove'
  title: string
  opinion: string
  bizDate: string
  source: string
  createdAt: number
}

/** 并发/重复提交挡回记录：先落库的一笔生效，后到的同键请求按重复挡回。 */
export type DedupEntry = {
  key: string
  submitNo: string
  at: number
}

/** 一次性存量补录的执行报告（按管廊编号+业务发生日幂等，可重复执行不会重复补）。 */
export type BackfillReport = {
  runAt: string
  paperBackfilled: number
  legacyFilled: number
  chambersFromDrawing: number
  chambersMissing: number
  notes: string[]
}

export type Database = {
  entries: Record<string, EntryRow[]>
  tunnelJournals: TunnelJournal[]
  dispatches: DispatchItem[]
  dedup: DedupEntry[]
  backfill: BackfillReport | null
}
