/**
 * 批量操作执行器
 * 语义：
 * - 目标列表逐个顺序执行（服务端 RCON 路径 await 串行化，顺序调用安全）
 * - requireOnline 时离线目标跳过计 skipped（需在线动作：踢出/清空背包/切换游戏模式/传送/给予）
 * - 名单类动作（白名单/OP）对离线玩家仍有效 → requireOnline=false
 * - 全部目标（过滤后）为空 → allOffline，调用方提示「所选玩家均已离线，无法执行」且不执行任何命令
 * - 汇总：成功 S，失败 F（跳过离线 K）
 */

/** 批量目标（含在线状态快照） */
export interface BatchTarget {
  name: string
  isOnline: boolean
}

/** 批量执行结果汇总 */
export interface BatchResult {
  /** 成功数 */
  successCount: number
  /** 失败数 */
  failCount: number
  /** 跳过离线数 */
  skippedCount: number
  /** 过滤后无任何可执行目标（全部离线） */
  allOffline: boolean
}

export interface RunBatchOptions {
  /** 目标玩家列表 */
  targets: BatchTarget[]
  /** 是否要求在线（离线目标跳过） */
  requireOnline: boolean
  /**
   * 对单个目标执行动作；抛错计失败。
   * 调用方负责拼装命令（buildGiveCommand/buildTeleportToCoordsCommand 等）并发送。
   */
  execute: (target: BatchTarget) => Promise<void>
}

/**
 * 批量执行：在线过滤 → 逐条执行 → 汇总。
 * 全部离线时不执行任何命令并返回 allOffline。
 */
export async function runBatchForTargets(options: RunBatchOptions): Promise<BatchResult> {
  const { targets, requireOnline, execute } = options

  let successCount = 0
  let failCount = 0
  let skippedCount = 0

  const actionable = targets.filter((t) => {
    if (requireOnline && !t.isOnline) {
      skippedCount++
      return false
    }
    return true
  })

  if (actionable.length === 0) {
    return { successCount: 0, failCount: 0, skippedCount, allOffline: true }
  }

  for (const target of actionable) {
    try {
      await execute(target)
      successCount++
    } catch {
      failCount++
    }
  }

  return { successCount, failCount, skippedCount, allOffline: false }
}

/** 汇总文案（Toast：「批量<动作>完成：成功 N，失败 N，跳过离线 N」） */
export function formatBatchSummary(actionLabel: string, result: BatchResult): string {
  if (result.allOffline) return '所选玩家均已离线，无法执行'
  const parts = [`成功 ${result.successCount}`, `失败 ${result.failCount}`]
  if (result.skippedCount > 0) parts.push(`跳过离线 ${result.skippedCount}`)
  return `批量${actionLabel}完成：${parts.join('，')}`
}
