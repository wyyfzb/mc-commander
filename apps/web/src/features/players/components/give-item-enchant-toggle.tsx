/**
 * 附魔开关（清单行内联的附魔配置复用）
 *
 * 走 ui/switch 基座而不是手写 role="switch"：基座已承担 Radix 的键盘语义（空格切换、
 * aria-checked、disabled 时不可聚焦），命中区也由基座保证 ≥24×24（WCAG 2.2 SC 2.5.8）。
 * 手写版本只有 16px 高且紫色配色与全站 switch 不一致。
 */
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'

export function EnchantToggle({
  label,
  on,
  disabled,
  onToggle,
}: {
  label: string
  on: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <Switch
      aria-label={label}
      checked={on}
      disabled={disabled}
      onCheckedChange={onToggle}
      className={cn(
        // 附魔语义色（紫）：基座默认走 primary（= 品牌绿），附魔是「属性」不是「品牌/健康」，
        // 紫色是它在全站的既有语义色（tone.ts 的 purple 档）
        on && 'data-checked:bg-mcs-purple-bg-subtle data-checked:border-mcs-purple-border',
        '[&_[data-slot=switch-thumb]]:data-checked:bg-mcs-purple-fg',
      )}
    />
  )
}
