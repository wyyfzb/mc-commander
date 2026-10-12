/**
 * SettingsSectionCard —— 设置页面板的区块卡片基座。
 *
 * 设置页各面板（账号与安全、两步验证等）的区块外观必须一致：图标底块 + 标题 + 说明 +
 * 内容槽位。此前该配方内联在 account-panel 里，第二个消费者出现时不能靠复制——
 * 两处各写一份就会出现两套标题字号/图标底色的漂移。
 *
 * 标题取 `lg` 档，对齐 components/mcs/card.tsx 的 heading 配方（`lg` + `font-semibold` +
 * `text-mcs-text-default`）：区块标题是标题层级的一档，不因卡片更紧凑而降为正文档。
 */
import type { LucideIcon } from 'lucide-react'
import { Card } from '@/components/mcs/card'

interface SettingsSectionCardProps {
  icon: LucideIcon
  title: string
  /** 说明行：允许 ReactNode——长机制说明可挂 `InfoHint` 收进浮层，行内只留定位短句 */
  description: React.ReactNode
  children: React.ReactNode
}

export function SettingsSectionCard({
  icon: Icon,
  title,
  description,
  children,
}: SettingsSectionCardProps) {
  return (
    <Card className="p-5 bg-mcs-bg-default">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
          <Icon className="size-4 text-mcs-accent-fg" aria-hidden />
        </div>
        <div>
          <h3 className="text-mcs-lg font-semibold text-mcs-text-default">{title}</h3>
          <p className="mt-0.5 text-mcs-2xs text-mcs-text-muted">{description}</p>
        </div>
      </div>
      {children}
    </Card>
  )
}
