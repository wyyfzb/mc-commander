/**
 * OverviewTab —— 详情概览 Tab
 * 分区顺序：操作按钮组 → 状态条 → 药水效果 → 基本信息 → 封禁记录 → 行为状态 → 统计 → IP 登录历史
 * 破坏性操作分级确认（P2 Tasteful Friction）；操作错误 toast 走 getFriendlyErrorMessage
 */
import { useState, type ReactNode } from 'react'
import {
  Ban,
  Feather,
  Flame,
  Gamepad2,
  HeartPulse,
  MessageSquare,
  MoveDown,
  PackageX,
  ShieldCheck,
  ShieldX,
  Snowflake,
  UserX,
  Wind,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { formatBanRemaining } from '@/lib/mc-ban'
import { formatRelativeTime } from '@/lib/format'
import type { BanRecord, Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'

const GAME_MODE_LABELS: Record<string, string> = {
  survival: '生存',
  creative: '创造',
  adventure: '冒险',
  spectator: '旁观',
}

const DIMENSION_LABELS: Record<string, string> = {
  overworld: '主世界',
  nether: '下界',
  end: '末地',
}

interface OverviewTabProps {
  instanceId: string
  player: Player
  isRconConnected: boolean
  bans: BanRecord[]
  onAction: (req: PlayerActionRequest) => Promise<void>
  onOpenBanDialog: (player: Player) => void
}

export function OverviewTab({ player, isRconConnected, bans, onAction, onOpenBanDialog }: OverviewTabProps) {
  const [confirmAction, setConfirmAction] = useState<string | null>(null)
  const [confirmToggle, setConfirmToggle] = useState<'op' | 'whitelist' | null>(null)
  const [messageText, setMessageText] = useState('')
  const [messageOpen, setMessageOpen] = useState(false)
  const [running, setRunning] = useState<string | null>(null)

  /** 执行带确认的操作（统一错误 toast） */
  const runAction = async (key: string, req: PlayerActionRequest, successText?: string) => {
    setRunning(key)
    try {
      await onAction(req)
      if (successText) toast.success(successText)
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(null)
    }
  }

  const gamemodeCommand = (mode: string) => ({ kind: 'command', command: `gamemode ${mode} ${player.name}` }) as PlayerActionRequest

  const playerBans = bans.filter(
    (b) => b.targetType === 'player' && b.target === player.name,
  )
  const ipBans = player.ip ? bans.filter((b) => b.targetType === 'ip' && b.target === player.ip) : []
  const relatedBans = [...playerBans, ...ipBans]
  // 渲染期取当前时间为可接受权衡：封禁剩余时间随详情数据刷新更新，非实时倒计时
  // eslint-disable-next-line react/purity
  const nowMs = Date.now()

  const behaviorBadges: Array<{ active: boolean; label: string; icon: ReactNode }> = [
    { active: player.isAfk, label: 'AFK', icon: <Zap aria-hidden /> },
    { active: player.isFlying, label: '飞行', icon: <Feather aria-hidden /> },
    { active: player.isSprinting, label: '疾跑', icon: <Wind aria-hidden /> },
    { active: player.isSneaking, label: '潜行', icon: <MoveDown aria-hidden /> },
    { active: player.isBurning, label: '燃烧', icon: <Flame aria-hidden /> },
    { active: player.isFrozen, label: '冻结', icon: <Snowflake aria-hidden /> },
  ]
  const activeBehaviors = behaviorBadges.filter((b) => b.active)

  return (
    <div className="flex flex-col gap-4">
      {/* ── 操作按钮组（三组语义分区——状态切换 | 游戏干预 | 危险）── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={running !== null}
          onClick={() => setConfirmToggle('op')}
        >
          {player.isOp ? <ShieldX aria-hidden /> : <ShieldCheck aria-hidden />}
          {player.isOp ? '取消OP' : '设为OP'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={running !== null}
          onClick={() => setConfirmToggle('whitelist')}
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
                onClick={() =>
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
          onClick={() => setMessageOpen(true)}
        >
          <MessageSquare aria-hidden />
          发送消息
        </Button>

        <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

        <Button
          variant="outline"
          size="sm"
          className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-bg-hover"
          disabled={!player.isOnline}
          onClick={() => setConfirmAction('clearinv')}
        >
          <PackageX aria-hidden />
          清空背包
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-bg-hover"
          disabled={!player.isOnline}
          onClick={() => setConfirmAction('kick')}
        >
          <UserX aria-hidden />
          踢出
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-bg-hover"
          onClick={() => onOpenBanDialog(player)}
        >
          <Ban aria-hidden />
          封禁…
        </Button>
      </div>

      {/* ── 状态条（仅在线）── */}
      {player.isOnline && (
        <div className="grid grid-cols-4 gap-2 rounded-mcs-sm border border-mcs-border-muted p-3">
          <StatCell label="生命" value={player.health !== null ? `${player.health}/${player.maxHealth}` : '--'} />
          <StatCell label="饥饿" value={player.hunger !== null ? String(player.hunger) : '--'} />
          <StatCell label="护甲" value={player.armor != null ? String(player.armor) : '--'} />
          <StatCell label="经验" value={player.xpLevel !== null ? `Lv.${player.xpLevel}` : '--'} />
        </div>
      )}

      {/* ── 药水效果（在线且非空；服务端可能不提供该字段）── */}
      {player.isOnline && (player.potionEffects?.length ?? 0) > 0 && (
        <Section title="药水效果">
          <div className="flex flex-wrap gap-1.5">
            {player.potionEffects?.map((effect, i) => (
              <span
                key={`${effect.id}-${i}`}
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-mcs-xs"
                style={{
                  borderColor: effect.isBeneficial ? 'var(--mcs-success-border)' : 'var(--mcs-warning-border)',
                  backgroundColor: effect.isBeneficial ? 'var(--mcs-success-bg-subtle)' : 'var(--mcs-warning-bg-subtle)',
                  color: effect.isBeneficial ? 'var(--mcs-success-fg)' : 'var(--mcs-warning-fg)',
                }}
              >
                {effect.name}
                {effect.level > 1 && toRomanLabel(effect.level)}
                {effect.durationSeconds >= 0 && ` · ${formatEffectDuration(effect.durationSeconds)}`}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* ── 基本信息 2×3 网格 ── */}
      <Section title="基本信息">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <InfoCell label="坐标" value={player.position ? `${Math.round(player.position.x)}, ${Math.round(player.position.y)}, ${Math.round(player.position.z)}` : '--'} mono />
          <InfoCell label="游戏模式" value={player.gameMode ? GAME_MODE_LABELS[player.gameMode] ?? player.gameMode : '--'} />
          <InfoCell label="维度" value={player.dimension ? DIMENSION_LABELS[player.dimension] ?? player.dimension : '--'} />
          <InfoCell label="IP 地址" value={player.ip || '--'} mono />
          <InfoCell label="总游戏时长" value={formatPlayTime(player.totalPlayTime)} />
          <InfoCell label="最后在线" value={player.lastSeen ? formatRelativeTime(player.lastSeen) : '--'} />
          <InfoCell label="连续在线" value={player.isOnline ? formatPlayTime(player.onlineTime) : '--'} />
          <InfoCell
            label="复活点"
            value={
              player.respawnPoint
                ? `${Math.round(player.respawnPoint.x)}, ${Math.round(player.respawnPoint.y)}, ${Math.round(player.respawnPoint.z)}`
                : player.spawnPoint
                  ? `${Math.round(player.spawnPoint.x)}, ${Math.round(player.spawnPoint.y)}, ${Math.round(player.spawnPoint.z)}`
                  : '--'
            }
            mono
          />
        </div>
      </Section>

      {/* ── 封禁记录区（该玩家名+IP 匹配；生效中可解封）── */}
      <Section title="封禁记录">
        {relatedBans.length === 0 ? (
          <p className="text-mcs-xs text-mcs-text-subtle">无封禁记录</p>
        ) : (
          <div className="flex flex-col gap-2">
            {relatedBans.map((ban, i) => (
              <div
                key={`${ban.targetType}-${ban.target}-${i}`}
                className="flex items-center justify-between gap-2 rounded-mcs-sm border border-mcs-border-muted px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-mcs-xs">
                    <span className={ban.isActive ? 'text-mcs-error-fg' : 'text-mcs-text-muted'}>
                      {ban.isActive ? '生效中' : '已解除'}
                    </span>
                    <span className="text-mcs-text-subtle"> · {ban.targetType === 'ip' ? 'IP 封禁' : '玩家封禁'} · {ban.reason || '无理由'}</span>
                  </div>
                  <div className="text-mcs-2xs text-mcs-text-subtle">
                    {ban.isPermanent
                      ? '永久'
                      : ban.expiresAt
                        ? (ban.isActive ? (formatBanRemaining(ban.expiresAt, nowMs) ?? '即将解封') : '已到期')
                        : ''}
                    {' · '}
                    {ban.createdAt ? formatRelativeTime(ban.createdAt) : ''}
                  </div>
                </div>
                {ban.isActive && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setConfirmAction(`pardon-${ban.targetType}-${ban.target}-${i}`)}
                    disabled={running !== null}
                  >
                    解封
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── 行为状态（在线；空则「无特殊状态」）── */}
      {player.isOnline && (
        <Section title="行为状态">
          {activeBehaviors.length === 0 ? (
            <p className="text-mcs-xs text-mcs-text-subtle">无特殊状态</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {activeBehaviors.map((b) => (
                <span
                  key={b.label}
                  className="inline-flex items-center gap-1 rounded-mcs-xs bg-mcs-bg-hover px-1.5 py-0.5 text-mcs-xs text-mcs-text-muted"
                >
                  {b.icon}
                  {b.label}
                </span>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ── 统计数据（stats 非空）── */}
      {player.stats && (
        <Section title="统计数据">
          <div className="grid grid-cols-3 gap-2">
            <StatCell label="死亡次数" value={String(player.stats.deathCount ?? 0)} />
            <StatCell label="成就达成" value={String(player.stats.achievementCount ?? 0)} />
            <StatCell label="入睡次数" value={String(player.stats.sleepCount ?? 0)} />
            <StatCell label="累计登录" value={String(player.stats.loginCount ?? 0)} />
            <StatCell label="总在线时长" value={formatPlayTime(player.stats.totalOnline ?? 0)} />
            <StatCell
              label="已离线"
              value={player.isOnline ? '--' : formatPlayTime(player.stats.offlineSince ?? 0)}
            />
          </div>
        </Section>
      )}

      {/* ── IP 登录历史（非空；服务端可能不提供该字段）── */}
      {(player.ipHistory?.length ?? 0) > 0 && (
        <Section title="IP 登录历史">
          <div className="flex flex-col gap-1.5">
            {player.ipHistory?.map((entry, i) => (
              <div key={`${entry.ip}-${i}`} className="flex items-center justify-between text-mcs-xs">
                <span className="font-mono text-mcs-text-muted">{entry.ip}</span>
                <span className="text-mcs-text-subtle">
                  {entry.lastSeen} · {entry.count} 次
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── OP/白名单确认对话框 ── */}
      <ConfirmDialog
        open={confirmToggle !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmToggle(null)
        }}
        title={
          confirmToggle === 'op'
            ? player.isOp
              ? '确认取消OP'
              : '确认设为OP'
            : player.isWhitelisted
              ? '确认移除白名单'
              : '确认加入白名单'
        }
        description={
          confirmToggle === 'op'
            ? player.isOp
              ? `即将取消 ${player.name} 的 OP 权限`
              : `即将设置 ${player.name} 为 OP`
            : player.isWhitelisted
              ? `即将移除 ${player.name} 的白名单`
              : `即将添加 ${player.name} 至白名单`
        }
        confirmText="确认操作"
        onConfirm={async () => {
          if (!confirmToggle) return
          if (confirmToggle === 'op') {
            await runAction(
              player.isOp ? 'deop' : 'op',
              { kind: player.isOp ? 'deop' : 'op', playerName: player.name },
              player.isOp ? `已取消 ${player.name} 的 OP` : `已设置 ${player.name} 为 OP`,
            )
          } else {
            await runAction(
              player.isWhitelisted ? 'whitelistRemove' : 'whitelistAdd',
              {
                kind: player.isWhitelisted ? 'whitelistRemove' : 'whitelistAdd',
                playerName: player.name,
              },
              player.isWhitelisted ? `已移除 ${player.name} 的白名单` : `已添加 ${player.name} 至白名单`,
            )
          }
          setConfirmToggle(null)
        }}
      />

      {/* ── 确认对话框（清空背包/踢出/解封）── */}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
        title={confirmAction === 'clearinv' ? '确认清空背包' : confirmAction === 'kick' ? '确认踢出' : '确认解封'}
        description={
          confirmAction === 'clearinv'
            ? `即将清空 ${player.name} 的背包`
            : confirmAction === 'kick'
              ? `即将踢出 ${player.name}`
              : `即将解封 ${confirmAction?.split('-')[2] ?? ''}`
        }
        warning={confirmAction === 'clearinv' ? '此操作不可撤销，所有物品将被永久删除' : '此操作不可撤销'}
        confirmText="确认操作"
        danger
        onConfirm={async () => {
          if (!confirmAction) return
          if (confirmAction === 'clearinv') {
            await runAction('clearinv', { kind: 'command', command: `clear ${player.name}` })
          } else if (confirmAction === 'kick') {
            await runAction('kick', { kind: 'kick', playerName: player.name }, `已成功踢出 ${player.name}`)
          } else if (confirmAction.startsWith('pardon-')) {
            const [, targetType, target, index] = confirmAction.split('-')
            const ban = relatedBans[Number(index)]
            if (ban) {
              await runAction('pardon', {
                kind: 'pardonTarget',
                playerName: target,
                targetType: targetType as 'player' | 'ip',
              })
            }
          }
          setConfirmAction(null)
        }}
      />

      {/* ── 发送消息对话框 ── */}
      <ConfirmDialog
        open={messageOpen}
        onOpenChange={(open) => {
          if (!open) setMessageOpen(false)
        }}
        title={`发送消息给 ${player.name}`}
        description=""
        confirmText="发送"
        onConfirm={async () => {
          const text = messageText.trim()
          if (text.length === 0) return
          await runAction('tell', { kind: 'command', command: `tell ${player.name} ${text}` })
          setMessageText('')
          setMessageOpen(false)
        }}
      >
        <textarea
          value={messageText}
          onChange={(e) => setMessageText(e.target.value)}
          placeholder="输入消息内容…"
          rows={3}
          maxLength={200}
          className="w-full resize-none rounded-mcs-xs border border-mcs-border-default bg-mcs-bg-default px-2.5 py-2 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-subtle focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
        />
      </ConfirmDialog>

      {/* RCON 不可用时在线操作提示 */}
      {player.isOnline && !isRconConnected && (
        <p className="text-mcs-xs text-mcs-text-subtle">提示：RCON 未连接，在线操作可能失败（需启用 RCON）</p>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-mcs-xs font-medium text-mcs-text-subtle">{title}</h4>
      {children}
    </div>
  )
}

function InfoCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-mcs-2xs text-mcs-text-subtle">{label}</span>
      <span className={mono ? 'font-mono text-mcs-xs text-mcs-text-default' : 'text-mcs-xs text-mcs-text-default'}>
        {value}
      </span>
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-mcs-xs bg-mcs-bg-muted px-2 py-1.5">
      <span className="text-mcs-2xs text-mcs-text-subtle">{label}</span>
      <span className="font-mono text-mcs-sm font-medium tabular-nums text-mcs-text-default">{value}</span>
    </div>
  )
}

/** 等级罗马数字（II/III…） */
function toRomanLabel(level: number): string {
  const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
  return romans[level - 1] ?? String(level)
}

/** 药水剩余时长（秒 → m:ss 或 无限） */
function formatEffectDuration(seconds: number): string {
  if (seconds < 0) return '∞'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 时长格式（X天X小时/X小时X分/X分） */
function formatPlayTime(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天${hours}小时`
  if (hours > 0) return `${hours}小时${minutes}分`
  return `${minutes}分`
}

// 保留引用（批量模式头像堆叠等未来扩展）
