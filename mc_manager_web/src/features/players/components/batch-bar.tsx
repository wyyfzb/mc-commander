/**
 * BatchBar —— 批量操作条（底部浮动）
 * 9 动作：传送/给予物品（复用详情批量模式）/ 白名单±/OP±/清空背包/切换游戏模式/踢出
 * 离线策略：踢出/清空背包/切换游戏模式需在线（离线跳过）；
 * 名单类（白名单/OP）对离线仍有效。
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

type BatchActionKey = 'whitelistAdd' | 'whitelistRemove' | 'op' | 'deop' | 'clearinv' | 'kick' | 'gamemode'

export function BatchBar({ selectedPlayers, onOpenBatchDetail, onAction }: BatchBarProps) {
  const clearSelection = usePlayersUiStore((s) => s.clearSelection)
  const [confirmKey, setConfirmKey] = useState<BatchActionKey | null>(null)
  const [running, setRunning] = useState(false)

  const count = selectedPlayers.length

  /** 通用批量执行（名单类动作 requireOnline=false；在线类 true） */
  const runBatch = async (actionLabel: string, requireOnline: boolean, execute: (t: Player) => Promise<void>) => {
    setRunning(true)
    try {
      const result = await runBatchForTargets({
        targets: selectedPlayers.map((p) => ({ name: p.name, isOnline: p.isOnline })),
        requireOnline,
        execute: (target) => execute(selectedPlayers.find((p) => p.name === target.name)!),
      })
      const summary = formatBatchSummary(actionLabel, result)
      const details = formatFailureDetails(result)
      if (result.allOffline) {
        toast.warning(summary)
      } else if (result.failCount > 0) {
        toast.warning(summary, { description: details })
      } else {
        toast.success(summary)
      }
    } catch (e) {
      toast.error(`批量操作失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const executeConfirmed = async () => {
    if (!confirmKey) return
    const key = confirmKey
    setConfirmKey(null)
    switch (key) {
      case 'whitelistAdd':
      case 'whitelistRemove':
      case 'op':
      case 'deop':
        await runBatch(key === 'whitelistAdd' ? '添加白名单' : key === 'whitelistRemove' ? '移除白名单' : key === 'op' ? '设置OP' : '取消OP', false, (p) =>
          onAction({ kind: key, playerName: p.name }),
        )
        break
      case 'kick':
        await runBatch('踢出', true, (p) => onAction({ kind: 'kick', playerName: p.name }))
        break
      case 'clearinv':
        await runBatch('清空背包', true, (p) => onAction({ kind: 'command', command: `clear ${p.name}` }))
        break
    }
  }

  /** 切换游戏模式：先选模式 → 确认 → 逐名执行（离线跳过） */
  const [pendingGamemode, setPendingGamemode] = useState<string | null>(null)
  const executeGamemode = async () => {
    if (!pendingGamemode) return
    const mode = pendingGamemode
    setPendingGamemode(null)
    await runBatch('切换游戏模式', true, (p) =>
      onAction({ kind: 'command', command: `gamemode ${mode} ${p.name}` }),
    )
  }

  return (
    // 内联出现在表格上方（accent 激活语言呼应「选择生效中」）；flex-wrap 防窄视口溢出
    <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-mcs-md border border-mcs-accent-border bg-mcs-accent-bg-subtle px-3 py-2">
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

        {/* 名单类（添加=ShieldCheck 正向，移除=ShieldX 禁止） */}
        <Button variant="outline" size="sm" onClick={() => setConfirmKey('whitelistAdd')} disabled={running}>
          <ShieldCheck aria-hidden />
          白名单
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirmKey('whitelistRemove')} disabled={running}>
          <ShieldX aria-hidden />
          移除白名单
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirmKey('op')} disabled={running}>
          <ShieldCheck aria-hidden />
          OP
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirmKey('deop')} disabled={running}>
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
              <DropdownMenuItem key={label} onClick={() => setPendingGamemode(GAME_MODE_VALUE[label] ?? null)}>
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

        {/* 危险类 */}
        <Button
          variant="outline"
          size="sm"
          className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-bg-hover"
          onClick={() => setConfirmKey('clearinv')}
          disabled={running}
        >
          <PackageX aria-hidden />
          清空背包
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-bg-hover"
          onClick={() => setConfirmKey('kick')}
          disabled={running}
        >
          <UserX aria-hidden />
          踢出
        </Button>

        <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label="清除选择">
          <X aria-hidden />
        </Button>

        {/* 确认对话框（6 项非传送/给予动作） */}
        <ConfirmDialog
          open={confirmKey !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmKey(null)
          }}
          title={`批量${confirmKey === 'whitelistAdd' ? '添加白名单' : confirmKey === 'whitelistRemove' ? '移除白名单' : confirmKey === 'op' ? '设置OP' : confirmKey === 'deop' ? '取消OP' : confirmKey === 'clearinv' ? '清空背包' : '踢出'}`}
          description={`即将对 ${count} 名玩家执行${confirmKey === 'whitelistAdd' ? '：添加白名单' : confirmKey === 'whitelistRemove' ? '：移除白名单' : confirmKey === 'op' ? '：设置OP' : confirmKey === 'deop' ? '：取消OP' : confirmKey === 'clearinv' ? '：清空背包' : '：踢出'}`}
          warning={
            confirmKey === 'clearinv'
              ? '此操作不可撤销，所有物品将被永久删除；离线玩家将跳过'
              : '离线玩家将跳过（名单类操作除外）'
          }
          confirmText="确认操作"
          danger
          loading={running}
          onConfirm={() => void executeConfirmed()}
        />

        {/* 游戏模式确认 */}
        <ConfirmDialog
          open={pendingGamemode !== null}
          onOpenChange={(open) => {
            if (!open) setPendingGamemode(null)
          }}
          title="批量切换游戏模式"
          description={`即将对 ${count} 名玩家执行：切换游戏模式`}
          confirmText="确认操作"
          loading={running}
          onConfirm={() => void executeGamemode()}
        />
    </div>
  )
}
