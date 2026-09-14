/**
 * OverviewTab 操作按钮组（三组语义分区——状态切换 | 游戏干预 | 危险）
 * 自 detail-overview-tab.tsx 纯搬移（issue 489 治理线延续）：操作域 JSX 与专属图标/菜单收口，
 * 确认弹窗与消息弹窗状态仍由宿主 OverviewTab 持有，经回调上抛
 */
import {
  Ban,
  Gamepad2,
  HeartPulse,
  MessageSquare,
  PackageX,
  ShieldCheck,
  ShieldX,
  UserX,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GAME_MODE_LABELS } from './detail-overview-format'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'

interface OverviewActionsProps {
  player: Player
  running: string | null
  runAction: (key: string, req: PlayerActionRequest, successText?: string) => Promise<void>
  runReversibleAction: (
    key: string,
    req: PlayerActionRequest,
    undoReq: PlayerActionRequest,
    successText: string,
    undoText: string,
  ) => Promise<void>
  onSendMessage: () => void
  onClearInventory: () => void
  onKick: () => void
  onOpenBanDialog: (player: Player) => void
}

export function OverviewActions({
  player,
  running,
  runAction,
  runReversibleAction,
  onSendMessage,
  onClearInventory,
  onKick,
  onOpenBanDialog,
}: OverviewActionsProps) {
  const gamemodeCommand = (mode: string) => ({ kind: 'command', command: `gamemode ${mode} ${player.name}` }) as PlayerActionRequest

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        disabled={running !== null}
        onClick={() =>
          void (player.isOp
            ? runReversibleAction(
                'deop',
                { kind: 'deop', playerName: player.name },
                { kind: 'op', playerName: player.name },
                `已取消 ${player.name} 的 OP`,
                `已恢复 ${player.name} 的 OP`,
              )
            : runReversibleAction(
                'op',
                { kind: 'op', playerName: player.name },
                { kind: 'deop', playerName: player.name },
                `已设置 ${player.name} 为 OP`,
                `已取消 ${player.name} 的 OP`,
              ))
        }
      >
        {player.isOp ? <ShieldX aria-hidden /> : <ShieldCheck aria-hidden />}
        {player.isOp ? '取消OP' : '设为OP'}
      </Button>

      <Button
        variant="outline"
        size="sm"
        disabled={running !== null}
        onClick={() =>
          void (player.isWhitelisted
            ? runReversibleAction(
                'whitelistRemove',
                { kind: 'whitelistRemove', playerName: player.name },
                { kind: 'whitelistAdd', playerName: player.name },
                `已移除 ${player.name} 的白名单`,
                `已恢复 ${player.name} 的白名单`,
              )
            : runReversibleAction(
                'whitelistAdd',
                { kind: 'whitelistAdd', playerName: player.name },
                { kind: 'whitelistRemove', playerName: player.name },
                `已添加 ${player.name} 至白名单`,
                `已移除 ${player.name} 的白名单`,
              ))
        }
      >
        {player.isWhitelisted ? <ShieldX aria-hidden /> : <ShieldCheck aria-hidden />}
        {player.isWhitelisted ? '移除白名单' : '加入白名单'}
      </Button>

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={!player.isOnline}>
            <Gamepad2 aria-hidden />
            游戏模式
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {Object.entries(GAME_MODE_LABELS).map(([value, label]) => (
            <DropdownMenuItem
              key={value}
              disabled={player.gameMode === value}
              onSelect={() =>
                void runAction(`gamemode-${value}`, gamemodeCommand(value), `已切换 ${player.name} 至${label}模式`)
              }
            >
              {label}
              {player.gameMode === value && ' ✓'}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={!player.isOnline}
            onClick={() =>
              void runAction('heal', {
                kind: 'command',
                command: `effect give ${player.name} minecraft:instant_health 1 255`,
              })
            }
          >
            <HeartPulse aria-hidden />
            治疗
          </Button>
        </TooltipTrigger>
        <TooltipContent>立即恢复生命（instant_health 255 级）</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={!player.isOnline}
            onClick={() =>
              void runAction('feed', {
                kind: 'command',
                command: `effect give ${player.name} minecraft:saturation 30 255`,
              })
            }
          >
            <HeartPulse aria-hidden />
            喂饱
          </Button>
        </TooltipTrigger>
        <TooltipContent>恢复饥饿值（saturation 30s 255 级）</TooltipContent>
      </Tooltip>

      <Button
        variant="outline"
        size="sm"
        disabled={!player.isOnline}
        onClick={onSendMessage}
      >
        <MessageSquare aria-hidden />
        发送消息
      </Button>

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      <Button
        variant="outline"
        size="sm"
        className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-state-hover"
        disabled={!player.isOnline}
        onClick={onClearInventory}
      >
        <PackageX aria-hidden />
        清空背包
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-state-hover"
        disabled={!player.isOnline}
        onClick={onKick}
      >
        <UserX aria-hidden />
        踢出
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-state-hover"
        onClick={() => onOpenBanDialog(player)}
      >
        <Ban aria-hidden />
        封禁…
      </Button>
    </div>
  )
}
