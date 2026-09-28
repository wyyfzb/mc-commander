/**
 * HeartsArmor —— 血心与护甲行
 * - 心：10 槽（20 点满），满心 = health/2 向下取整，半心 = 奇数点数
 * - 护甲：Shield 图标 + 数值角标（10 盾槽总宽 264px 超出状态列宽被裁剪，故用
 *   数字角标，hover/aria 仍保精确值 —— 状态优先）
 */
import { Heart, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'

interface HeartsArmorProps {
  health: number | null
  maxHealth: number | null
  armor: number | null
  /** 单个图标像素（默认 11） */
  iconSize?: number
  className?: string
}

const HEART_SLOTS = 10

/** 心行 gap-0.5 = 2px；分隔 mx-0.5 = 4px */
const SLOT_GAP_PX = 2
const SEPARATOR_PX = 4

/**
 * 估算完整渲染宽度（10 心 + 分隔 + Shield 图标 + 数值角标）。
 * 供状态列防裁剪回归测试断言（列宽 184 - 左右 px-2 共 32 = 168px 可用）。
 * font-mono 10px 数字约 6px/位。
 */
export function heartsArmorContentWidth(iconSize: number, armorDigits: number): number {
  const heartRow = HEART_SLOTS * iconSize + (HEART_SLOTS - 1) * SLOT_GAP_PX
  const shieldGap = SLOT_GAP_PX
  const numberWidth = armorDigits * 6
  return heartRow + SEPARATOR_PX + shieldGap + iconSize + numberWidth
}

export function HeartsArmor({
  health,
  maxHealth,
  armor,
  iconSize = 11,
  className,
}: HeartsArmorProps) {
  if (health === null || maxHealth === null) {
    // 离线：显示占位（P1 三重编码第三通道由文字兜底）
    return <span className={cn('text-mcs-xs text-mcs-text-muted', className)}>--</span>
  }

  // health.ceil() 得点数 → 满心 = 点数 ~/2（10 心满）；半心 = 奇数
  const points = Math.ceil(Math.max(health, 0))
  const fullHearts = Math.floor(points / 2)
  const hasHalfHeart = points % 2 === 1

  return (
    <span
      className={cn('inline-flex items-center gap-0.5', className)}
      role="img"
      aria-label={`生命 ${health}/${maxHealth}，护甲 ${armor ?? 0}`}
      title={`生命 ${health}/${maxHealth}，护甲 ${armor ?? 0}`}
    >
      {Array.from({ length: HEART_SLOTS }, (_, i) => {
        const filled = i < fullHearts
        const half = !filled && i === fullHearts && hasHalfHeart
        return (
          <span
            key={`h${i}`}
            className="relative inline-flex overflow-hidden"
            style={{ width: iconSize, height: iconSize }}
          >
            {/* 底层：空心轮廓 */}
            <Heart
              className="absolute inset-0 text-mcs-text-muted"
              style={{ width: iconSize, height: iconSize }}
              strokeWidth={1.5}
              fill="none"
              aria-hidden
            />
            {/* 满心：全宽实心覆盖 */}
            {filled && (
              <Heart
                className="absolute inset-0 text-mcs-error-fg"
                fill="currentColor"
                strokeWidth={0}
                style={{ width: iconSize, height: iconSize }}
                aria-hidden
              />
            )}
            {/* 半心：左半实心覆盖 */}
            {half && (
              <span
                className="absolute inset-y-0 left-0 overflow-hidden"
                style={{ width: iconSize / 2 }}
              >
                <Heart
                  className="text-mcs-error-fg"
                  fill="currentColor"
                  strokeWidth={0}
                  style={{ width: iconSize, height: iconSize }}
                  aria-hidden
                />
              </span>
            )}
          </span>
        )
      })}
      <span className="mx-0.5" aria-hidden />
      {/* 护甲：Shield 图标 + 精确数值（角标紧凑表达） */}
      <span className="inline-flex shrink-0 items-center gap-0.5 text-mcs-info-fg">
        <Shield
          fill="currentColor"
          strokeWidth={0}
          style={{ width: iconSize, height: iconSize }}
          aria-hidden
        />
        <span className="font-mono text-mcs-xs leading-none tabular-nums">{armor ?? 0}</span>
      </span>
    </span>
  )
}
