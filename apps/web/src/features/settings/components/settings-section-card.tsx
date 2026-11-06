/**
 * SettingsSectionCard —— 设置页面板的区块卡片基座。
 *
 * 设置页各面板（登录与密码、两步验证等）的区块外观必须一致：图标底块 + 标题 + 说明 +
 * 内容槽位。该配方不得内联在消费方，也不能靠复制——
 * 两处各写一份就会出现两套标题字号/图标底色的漂移。
 *
 * 标题取 `lg` 档，对齐 components/mcs/card.tsx 的 heading 配方（`lg` + `font-semibold` +
 * `text-mcs-text-default`）：区块标题是标题层级的一档，不因卡片更紧凑而降为正文档。
 *
 * 区块头单独导出：调用方已是某个区块卡的一部分时（连接表单的「从其他设备访问」段），
 * 要的是同一份区块头而不是第二层卡片面——「面」与「头」拆开后，配方仍只有一份。
 */
import type { LucideIcon } from 'lucide-react'
import { Card } from '@/components/mcs/card'

interface SettingsSectionHeaderProps {
  icon: LucideIcon
  title: string
  /** 说明行：允许 ReactNode——长机制说明可挂 `InfoHint` 收进浮层，行内只留定位短句 */
  description: React.ReactNode
}

/** 区块头：图标底块 + 标题 + 说明行；不带卡片面，供已有区块卡的场景复用 */
export function SettingsSectionHeader({
  icon: Icon,
  title,
  description,
}: SettingsSectionHeaderProps) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
        <Icon className="size-4 text-mcs-accent-fg" aria-hidden />
      </div>
      <div>
        <h3 className="text-mcs-lg font-semibold text-mcs-text-default">{title}</h3>
        <p className="mt-0.5 text-mcs-2xs text-mcs-text-muted">{description}</p>
      </div>
    </div>
  )
}

interface SettingsSectionCardProps extends SettingsSectionHeaderProps {
  children: React.ReactNode
}

export function SettingsSectionCard({
  icon,
  title,
  description,
  children,
}: SettingsSectionCardProps) {
  return (
    <Card className="p-5 bg-mcs-bg-default">
      <SettingsSectionHeader icon={icon} title={title} description={description} />
      {children}
    </Card>
  )
}
