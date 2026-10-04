/**
 * OverviewTab 操作按钮组（三组语义分区——状态切换 | 游戏干预 | 危险）
 * 自 detail-overview-tab.tsx 纯搬移（issue 489 治理线延续）：操作域 JSX 与专属图标/菜单收口，
 * 确认弹窗与消息弹窗状态仍由宿主 OverviewTab 持有，经回调上抛
 * 交互口径（与行内菜单、批量条共用 reversible-action）：可逆操作直执 + 5s 撤销；
 * 无逆操作的踢出不挂撤销；清空背包超出本组职责，上抛宿主走后果清单确认
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
import { OP_LABELS } from '@/features/players/mutations'
import type { PlayerActionRequest } from '../mutations'

/** 操作收尾规格：成功回执 + 可选逆操作（有逆操作才挂撤销入口） */
export interface ActionOutcome {
  /** 成功回执；缺省则静默成功（治疗/喂饱一类无需回执的直执操作） */
  successText?: string
  /** 逆操作与撤销回执；逆操作语义不可表达时不给此项（不挂做不到的「撤销」） */
  undo?: { req: PlayerActionRequest; text: string }
}

interface OverviewActionsProps {
  player: Player
  running: string | null
  runAction: (key: string, req: PlayerActionRequest, outcome?: ActionOutcome) => Promise<void>
  onSendMessage: () => void
  onClearInventory: () => void
  onOpenBanDialog: (player: Player) => void
}

export function OverviewActions({
  player,
  running,
  runAction,
  onSendMessage,
  onClearInventory,
  onOpenBanDialog,
}: OverviewActionsProps) {
  const gamemodeCommand = (mode: string) =>
    ({ kind: 'command', command: `gamemode ${mode} ${player.name}` }) as PlayerActionRequest
  /** 当前模式＝游戏模式切换的逆操作依据；服务端未采集到模式时无逆操作可用 */
  const previousMode = player.gameMode
  const previousModeLabel = previousMode ? GAME_MODE_LABELS[previousMode] : undefined

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        disabled={running !== null}
        onClick={() =>
          void (player.isOp
            ? runAction(
                'deop',
                { kind: 'deop', playerName: player.name },
                {
                  successText: `已取消 ${player.name} 的 OP`,
                  undo: {
                    req: { kind: 'op', playerName: player.name },
                    text: `已恢复 ${player.name} 的 OP`,
                  },
                },
              )
            : runAction(
                'op',
                { kind: 'op', playerName: player.name },
                {
                  successText: `已设置 ${player.name} 为 OP`,
                  undo: {
                    req: { kind: 'deop', playerName: player.name },
                    text: `已取消 ${player.name} 的 OP`,
                  },
                },
              ))
        }
      >
        {player.isOp ? <ShieldX aria-hidden /> : <ShieldCheck aria-hidden />}
        {player.isOp ? OP_LABELS.revoke : OP_LABELS.grant}
      </Button>

      <Button
        variant="outline"
        size="sm"
        disabled={running !== null}
        onClick={() =>
          void (player.isWhitelisted
            ? runAction(
                'whitelistRemove',
                { kind: 'whitelistRemove', playerName: player.name },
                {
                  successText: `已移除 ${player.name} 的白名单`,
                  undo: {
                    req: { kind: 'whitelistAdd', playerName: player.name },
                    text: `已恢复 ${player.name} 的白名单`,
                  },
                },
              )
            : runAction(
                'whitelistAdd',
                { kind: 'whitelistAdd', playerName: player.name },
                {
                  successText: `已添加 ${player.name} 至白名单`,
                  undo: {
                    req: { kind: 'whitelistRemove', playerName: player.name },
                    text: `已移除 ${player.name} 的白名单`,
                  },
                },
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
                void runAction(`gamemode-${value}`, gamemodeCommand(value), {
                  successText: `已切换 ${player.name} 至${label}模式`,
                  undo:
                    previousMode && previousModeLabel
                      ? {
                          req: gamemodeCommand(previousMode),
                          text: `已切回${previousModeLabel}模式`,
                        }
                      : undefined,
                })
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

      <Button variant="outline" size="sm" disabled={!player.isOnline} onClick={onSendMessage}>
        <MessageSquare aria-hidden />
        发送消息
      </Button>

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      <Button
        variant="destructive-outline"
        size="sm"
        disabled={!player.isOnline}
        onClick={onClearInventory}
      >
        <PackageX aria-hidden />
        清空背包
      </Button>

      {/* 踢出：无逆操作（重新加入由玩家侧发起，命令层回不去）——直执 + 普通回执，不挂假撤销 */}
      <Button
        variant="destructive-outline"
        size="sm"
        disabled={!player.isOnline}
        onClick={() =>
          void runAction(
            'kick',
            { kind: 'kick', playerName: player.name },
            {
              successText: `已成功踢出 ${player.name}`,
            },
          )
        }
      >
        <UserX aria-hidden />
        踢出
      </Button>

      <Button variant="destructive-outline" size="sm" onClick={() => onOpenBanDialog(player)}>
        <Ban aria-hidden />
        封禁…
      </Button>
    </div>
  )
}
