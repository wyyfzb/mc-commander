/**
 * OverviewTab —— 详情概览 Tab
 * 分区顺序：操作按钮组 → 状态条 → 药水效果 → 基本信息 → 封禁记录 → 行为状态 → 统计 → IP 登录历史
 * 可逆操作（OP/白名单/游戏模式）直接执行 + 5s undo toast；无逆操作的踢出直执；
 * 不可逆操作（清空背包/解封）保留后果清单确认（口径与行内菜单、批量条共用 reversible-action）
 * 操作按钮组/常量与格式化工具/展示子件拆分至 overview-actions.tsx、detail-overview-format.ts、overview-cells.tsx（issue 489）
 */
import { useState, type ReactNode } from 'react'
import { Feather, Flame, MoveDown, Snowflake, Wind, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { formatBanRemaining } from '@/lib/mc-ban'
import { formatRelativeTime } from '@/lib/format'
import type { BanRecord, Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'
import { DIMENSION_LABELS, GAME_MODE_LABELS, formatEffectDuration, formatPlayTime, toRomanLabel } from './detail-overview-format'
import { InfoCell, Section, StatCell } from './overview-cells'
import { OverviewActions, type ActionOutcome } from './overview-actions'
import { toastWithUndo } from '../reversible-action'

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
  const [messageText, setMessageText] = useState('')
  const [messageOpen, setMessageOpen] = useState(false)
  const [running, setRunning] = useState<string | null>(null)

  /** 操作收尾统一入口：直执 + 回执；可逆操作（outcome.undo）在回执上挂 5s 撤销入口 */
  const runAction = async (key: string, req: PlayerActionRequest, outcome?: ActionOutcome) => {
    setRunning(key)
    try {
      await onAction(req)
      const undo = outcome?.undo
      if (!undo) {
        if (outcome?.successText) toast.success(outcome.successText)
        return
      }
      toastWithUndo({
        text: outcome?.successText ?? '操作已完成',
        undoText: undo.text,
        undo: () => onAction(undo.req),
      })
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(null)
    }
  }

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
      <OverviewActions
        player={player}
        running={running}
        runAction={runAction}
        onSendMessage={() => setMessageOpen(true)}
        onClearInventory={() => setConfirmAction('clearinv')}
        onOpenBanDialog={onOpenBanDialog}
      />

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
          <InfoCell label="连续在线" value={player.isOnline && player.onlineTime != null ? formatPlayTime(player.onlineTime) : '--'} />
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
          <p className="text-mcs-xs text-mcs-text-muted">无封禁记录</p>
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
                    <span className="text-mcs-text-muted"> · {ban.targetType === 'ip' ? 'IP 封禁' : '玩家封禁'} · {ban.reason || '无理由'}</span>
                  </div>
                  <div className="text-mcs-2xs text-mcs-text-muted">
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
            <p className="text-mcs-xs text-mcs-text-muted">无特殊状态</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {activeBehaviors.map((b) => (
                <span
                  key={b.label}
                  className="inline-flex items-center gap-1 rounded-mcs-xs bg-mcs-bg-secondary px-1.5 py-0.5 text-mcs-xs text-mcs-text-muted"
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
                <span className="text-mcs-text-muted">
                  {entry.lastSeen} · {entry.count} 次
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── 确认对话框（清空背包/解封——均为不可逆或需后果清单的操作）── */}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
        title={confirmAction === 'clearinv' ? '确认清空背包' : '确认解封'}
        description={
          confirmAction === 'clearinv'
            ? `即将清空 ${player.name} 的背包`
            : `即将解封 ${confirmAction?.split('-')[2] ?? ''}`
        }
        warning={confirmAction === 'clearinv' ? '此操作不可撤销，所有物品将被永久删除' : '此操作不可撤销'}
        confirmText="确认操作"
        danger
        onConfirm={async () => {
          if (!confirmAction) return
          if (confirmAction === 'clearinv') {
            await runAction('clearinv', { kind: 'command', command: `clear ${player.name}` })
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
          className="w-full resize-none rounded-mcs-xs border border-mcs-border-default bg-mcs-bg-default px-2.5 py-2 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-muted focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
        />
      </ConfirmDialog>

      {/* RCON 不可用时在线操作提示 */}
      {player.isOnline && !isRconConnected && (
        <p className="text-mcs-xs text-mcs-text-muted">提示：RCON 未连接，在线操作可能失败（需启用 RCON）</p>
      )}
    </div>
  )
}

// 保留引用（批量模式头像堆叠等未来扩展）
