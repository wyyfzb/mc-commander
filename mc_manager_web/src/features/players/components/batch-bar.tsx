/**
 * BatchBar —— 批量操作条（底部浮动）
 * 9 动作：传送/给予物品（复用详情批量模式）/ 白名单±/OP±/清空背包/切换游戏模式/踢出
 * 离线策略：踢出/清空背包/切换游戏模式需在线（离线跳过）；
 * 名单类（白名单/OP）对离线仍有效。
 * 交互口径（与详情面板/行内菜单同源）：可逆动作（名单类/游戏模式）直执 + 5s 撤销，
 * 且只回滚真正下发成功的目标；无逆操作的踢出直执；不可逆的清空背包走后果清单确认。
 * 汇总 toast「批量<动作>完成：成功 N，失败 N，跳过离线 N」（formatBatchSummary）
 */
import { useState } from 'react'
import { Gamepad2, Gift, PackageX, Send, ShieldCheck, ShieldX, UserX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '@/lib/mc-batch'
import { GAME_MODE_OPTIONS, usePlayersUiStore } from '../store'
import { toastWithUndo } from '../reversible-action'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'

const GAME_MODE_VALUE: Record<string, string> = {
  生存: 'survival',
  创造: 'creative',
  冒险: 'adventure',
  旁观: 'spectator',
}

interface BatchBarProps {
  /** 选中玩家对象（按选中顺序） */
  selectedPlayers: Player[]
  onOpenBatchDetail: (tab: 'teleport' | 'give') => void
  onAction: (req: PlayerActionRequest) => Promise<void>
}

/**
 * 撤销规格：由成功目标推出回执文案与逆操作。
 * - `{ text, run }`：挂 5s 撤销入口；`note` 用于「撤销只覆盖一部分目标」时在回执里讲明
 * - `{ unavailable }`：有成功目标但完全无法撤销 —— 回执必须说明原因，静默少给入口
 *   会让用户以为撤销漏了
 * - `null`：本动作没有撤销语义（如踢出），回执照常
 */
type BatchUndo = (
  succeeded: Player[],
) => { text: string; run: () => Promise<void>; note?: string } | { unavailable: string } | null

export function BatchBar({ selectedPlayers, onOpenBatchDetail, onAction }: BatchBarProps) {
  const clearSelection = usePlayersUiStore((s) => s.clearSelection)
  const [clearinvOpen, setClearinvOpen] = useState(false)
  const [running, setRunning] = useState(false)

  const count = selectedPlayers.length

  /** 逐名回滚（顺序执行：RCON 路径本就串行，中断即失败，由撤销回执说明） */
  const undoEach = async (targets: Player[], build: (p: Player) => PlayerActionRequest) => {
    for (const p of targets) await onAction(build(p))
  }

  /**
   * 通用批量执行（名单类动作 requireOnline=false；在线类 true）+ 汇总回执。
   * undo 存在时在回执上挂 5s 撤销入口，且只覆盖真正下发成功的目标（失败与跳过不可回滚）。
   */
  const runBatch = async (
    actionLabel: string,
    requireOnline: boolean,
    execute: (t: Player) => Promise<void>,
    undo?: BatchUndo,
  ) => {
    setRunning(true)
    const succeeded: Player[] = []
    try {
      const result = await runBatchForTargets({
        targets: selectedPlayers.map((p) => ({ name: p.name, isOnline: p.isOnline })),
        requireOnline,
        execute: async (target) => {
          const player = selectedPlayers.find((p) => p.name === target.name)!
          await execute(player)
          succeeded.push(player)
        },
      })
      const summary = formatBatchSummary(actionLabel, result)
      const details = formatFailureDetails(result)
      if (result.allOffline) {
        toast.warning(summary)
        return
      }
      const undoSpec = undo?.(succeeded) ?? null
      // 「可撤销但只覆盖一部分」与「有成功目标却完全不可撤销」都要在回执里讲明
      const undoNote =
        undoSpec && 'unavailable' in undoSpec
          ? undoSpec.unavailable
          : undoSpec && 'note' in undoSpec
            ? undoSpec.note
            : null
      const description = [details, undoNote].filter(Boolean).join('\n') || undefined
      if (undoSpec && 'text' in undoSpec) {
        toastWithUndo({
          text: summary,
          description,
          variant: result.failCount > 0 ? 'warning' : 'success',
          undoText: undoSpec.text,
          undo: undoSpec.run,
        })
      } else if (result.failCount > 0) {
        toast.warning(summary, { description })
      } else if (description) {
        toast.success(summary, { description })
      } else {
        toast.success(summary)
      }
    } catch (e) {
      toast.error(`批量操作失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(false)
    }
  }

  /** 名单类切换：逆操作即对偶动作 */
  const runListToggle = (add: boolean) =>
    void runBatch(
      add ? '添加白名单' : '移除白名单',
      false,
      (p) => onAction({ kind: add ? 'whitelistAdd' : 'whitelistRemove', playerName: p.name }),
      (succeeded) => ({
        text: add ? '已移除白名单' : '已恢复白名单',
        run: () =>
          undoEach(succeeded, (p) => ({
            kind: add ? 'whitelistRemove' : 'whitelistAdd',
            playerName: p.name,
          })),
      }),
    )

  const runOpToggle = (grant: boolean) =>
    void runBatch(
      grant ? '设置OP' : '取消OP',
      false,
      (p) => onAction({ kind: grant ? 'op' : 'deop', playerName: p.name }),
      (succeeded) => ({
        text: grant ? '已取消OP' : '已设置OP',
        run: () =>
          undoEach(succeeded, (p) => ({ kind: grant ? 'deop' : 'op', playerName: p.name })),
      }),
    )

  /** 游戏模式：逆操作＝切回各目标原模式。原模式未知的目标（服务端未采集到）无法回滚——
   *  既不猜默认档，也不静默排除：完全无法撤销时说清原因，只覆盖一部分时说明覆盖面 */
  const runGamemode = (mode: string) =>
    void runBatch(
      '切换游戏模式',
      true,
      (p) => onAction({ kind: 'command', command: `gamemode ${mode} ${p.name}` }),
      (succeeded) => {
        const known = succeeded.filter((p) => p.gameMode)
        const unknownCount = succeeded.length - known.length
        if (known.length === 0) {
          return unknownCount > 0
            ? { unavailable: `${unknownCount} 名玩家的原游戏模式未知，本次不提供撤销（不猜默认档）` }
            : null
        }
        return {
          text: '已切回原游戏模式',
          run: () =>
            undoEach(known, (p) => ({ kind: 'command', command: `gamemode ${p.gameMode} ${p.name}` })),
          note:
            unknownCount > 0
              ? `撤销只覆盖原模式已知的 ${known.length} 名，另有 ${unknownCount} 名原模式未知`
              : undefined,
        }
      },
    )

  return (
    // 内联出现在表格上方（accent 激活语言呼应「选择生效中」）；flex-wrap 防窄视口溢出。
    // aria-busy：批量执行期间按钮只是变灰（视觉线索），读屏需要 busy 信号感知「操作进行中」
    <div
      aria-busy={running}
      className="mb-3 flex flex-wrap items-center gap-1.5 rounded-mcs-md border border-mcs-accent-border bg-mcs-accent-bg-subtle px-3 py-2"
    >
      <span className="mr-1 whitespace-nowrap text-mcs-sm font-medium text-mcs-accent-fg">
        已选择 {count} 名玩家
      </span>

        {/* 导航类 */}
        <Button variant="outline" size="sm" onClick={() => onOpenBatchDetail('teleport')} disabled={running}>
          <Send aria-hidden />
          传送
        </Button>
        <Button variant="outline" size="sm" onClick={() => onOpenBatchDetail('give')} disabled={running}>
          <Gift aria-hidden />
          给予物品
        </Button>

        <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

        {/* 名单类（添加=ShieldCheck 正向，移除=ShieldX 禁止）——可逆，直执 + 5s 撤销 */}
        <Button variant="outline" size="sm" onClick={() => runListToggle(true)} disabled={running}>
          <ShieldCheck aria-hidden />
          白名单
        </Button>
        <Button variant="outline" size="sm" onClick={() => runListToggle(false)} disabled={running}>
          <ShieldX aria-hidden />
          移除白名单
        </Button>
        <Button variant="outline" size="sm" onClick={() => runOpToggle(true)} disabled={running}>
          <ShieldCheck aria-hidden />
          OP
        </Button>
        <Button variant="outline" size="sm" onClick={() => runOpToggle(false)} disabled={running}>
          <ShieldX aria-hidden />
          取消OP
        </Button>

        <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="border-mcs-purple-border text-mcs-purple-fg hover:bg-mcs-purple-bg-subtle" disabled={running}>
              <Gamepad2 aria-hidden />
              游戏模式
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {GAME_MODE_OPTIONS.map((label) => (
              <DropdownMenuItem
                key={label}
                onClick={() => {
                  const mode = GAME_MODE_VALUE[label]
                  if (mode) runGamemode(mode)
                }}
              >
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

        {/* 危险类：清空背包不可逆 → 确认；踢出无逆操作但可自愈（玩家可重连）→ 直执 */}
        <Button
          variant="destructive-outline"
          size="sm"
          onClick={() => setClearinvOpen(true)}
          disabled={running}
        >
          <PackageX aria-hidden />
          清空背包
        </Button>
        <Button
          variant="destructive-outline"
          size="sm"
          onClick={() => void runBatch('踢出', true, (p) => onAction({ kind: 'kick', playerName: p.name }))}
          disabled={running}
        >
          <UserX aria-hidden />
          踢出
        </Button>

        {/* 执行中禁用：清空选择不能中止已下发的命令，只会让在途执行失去可见面 */}
        <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label="清除选择" disabled={running}>
          <X aria-hidden />
        </Button>

        {/* 确认对话框（仅清空背包：不可逆，需后果清单） */}
        <ConfirmDialog
          open={clearinvOpen}
          onOpenChange={setClearinvOpen}
          title="批量清空背包"
          description={`即将对 ${count} 名玩家执行：清空背包`}
          warning="此操作不可撤销，所有物品将被永久删除；离线玩家将跳过"
          confirmText="确认操作"
          danger
          loading={running}
          onConfirm={() => {
            setClearinvOpen(false)
            void runBatch('清空背包', true, (p) => onAction({ kind: 'command', command: `clear ${p.name}` }))
          }}
        />
    </div>
  )
}
