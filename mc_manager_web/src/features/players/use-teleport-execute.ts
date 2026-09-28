/**
 * 传送执行 hook：
 * - 单个模式直接 onAction + 成功 toast（错误走友好文案）
 * - 批量模式 runBatchForTargets 跳过离线目标 + formatBatchSummary 汇总 toast
 * running 供全部触发按钮共享禁用态，避免并发命令交错。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { buildSetWorldSpawnCommand, type TeleportPoint } from '@/lib/mc-teleport'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '@/lib/mc-batch'
import { copyText } from '@/lib/clipboard'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from './mutations'

interface UseTeleportExecuteParams {
  /** 单个模式目标玩家；批量模式为 null */
  player: Player | null
  /** 批量目标（单个模式为 [player]） */
  batchTargets: Player[]
  isBatchMode: boolean
  onAction: (req: PlayerActionRequest) => Promise<void>
}

export function useTeleportExecute({
  player,
  batchTargets,
  isBatchMode,
  onAction,
}: UseTeleportExecuteParams) {
  const [running, setRunning] = useState(false)

  /**
   * 执行传送动作：
   * - 单个模式：直接 onAction，成功 toast（错误走 getFriendlyErrorText）
   * - 批量模式：runBatchForTargets 跳过离线目标 + formatBatchSummary 汇总 toast
   */
  const execute = async (
    label: string,
    buildCommand: (name: string) => string,
    successText?: string,
  ) => {
    setRunning(true)
    try {
      if (!isBatchMode && player !== null) {
        await onAction({ kind: 'command', command: buildCommand(player.name) })
        toast.success(successText ?? `${label}完成`)
      } else {
        const result = await runBatchForTargets({
          targets: batchTargets.map((t) => ({ name: t.name, isOnline: t.isOnline })),
          requireOnline: true,
          execute: async (t) => {
            await onAction({ kind: 'command', command: buildCommand(t.name) })
          },
        })
        const summary = formatBatchSummary(label, result)
        // 逐名失败原因不能只报计数（与批量条同口径）：无失败时返回 undefined，成功态不多出节点
        const description = formatFailureDetails(result)
        if (result.allOffline) toast.warning(summary)
        else if (description) toast.success(summary, { description })
        else toast.success(summary)
      }
    } catch (e) {
      toast.error(`传送失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(false)
    }
  }

  /** setworldspawn 是服务器全局命令：无论单/批量只执行一次；成功后回调（上层用于关闭确认弹窗） */
  const saveWorldSpawn = async (point: TeleportPoint, onSuccess: () => void) => {
    setRunning(true)
    try {
      await onAction({ kind: 'command', command: buildSetWorldSpawnCommand(point) })
      toast.success('世界出生点已修改')
      onSuccess()
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const copyCoords = async (text: string) => {
    // copyText 内部降级 execCommand（HTTP 非安全上下文可用）且绝不抛异常
    const ok = await copyText(text)
    if (ok) toast.success('已复制坐标', { duration: 1500 })
    else toast.error('复制失败，请手动复制')
  }

  return { running, execute, saveWorldSpawn, copyCoords }
}
