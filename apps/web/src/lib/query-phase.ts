/**
 * 查询相位判定 —— 「失败」与「失败且无数据可留」是两件事
 *
 * 仓内常见的三态链 `isPending ? 骨架 : isError ? 错误态 : 数据` 在轮询查询上会把一次
 * 网络抖动呈现成整屏故障：数据被换成「加载失败」、滚动位与勾选态随之丢失，而用户看不出
 * 「刚才那些是旧值」。本模块把判定拆成四相，让有旧值可留的失败降级为非阻断提示。
 *
 * `stale` 相之所以真实可达（不是防御性分支）：@tanstack/query-core 5.102 的 error
 * reducer 只做 `{...state, error, status:'error', ...}`，**不清空 data**——refetch 失败后
 * 上一轮数据仍留在 query 里，是调用点的判定链主动丢弃了它。
 */

export type QueryPhase =
  /** 首帧未落定且无数据 → 骨架 */
  | 'loading'
  /** 已失败且无数据可留 → 整块错误态 */
  | 'failed'
  /** 已失败但有上一轮数据 → 保留数据 + 非阻断告警 */
  | 'stale'
  /** 有可用数据（是否空集合由调用点判） */
  | 'ready'

interface PhaseQuery {
  isPending: boolean
  isError: boolean
  errorUpdatedAt: number
  dataUpdatedAt: number
}

/**
 * 查询是否处于「已失败且尚未恢复」：失败过一轮后的重试会把 query 短暂置回 pending
 * （isError 瞬时为 false），只看 isError 会让提示连同重试按钮在整个请求窗口内消失——
 * 端点持续故障时用户点完重试得不到任何反馈。
 * 用两次「落定时间」比较兜住：失败的时间戳晚于成功，说明最近一次落定是失败
 * （fetch 开始时 failureCount 会归零，不能拿它判）。
 */
export function queryFailed(q: PhaseQuery): boolean {
  return q.isError || q.errorUpdatedAt > q.dataUpdatedAt
}

/**
 * 「有旧值可留」取 dataUpdatedAt > 0（至少成功落定过一次），不由调用点猜数据形状：
 * 成功后的空数组是**真实的空**，此后 refetch 失败仍应显示「空 + 更新失败告警」，
 * 而不是退回「无数据可留」的整块错误态。空/非空由调用点自己判。
 */
export function queryPhase(q: PhaseQuery): QueryPhase {
  const settled = q.dataUpdatedAt > 0
  if (queryFailed(q)) return settled ? 'stale' : 'failed'
  if (!settled && q.isPending) return 'loading'
  return 'ready'
}
