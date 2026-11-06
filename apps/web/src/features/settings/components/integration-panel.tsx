/**
 * IntegrationPanel —— 「推送与记录」子页：两个独立页面（推送配置 / 操作记录）的入口。
 *
 * 只放入口卡、不把页面搬进来：两者都是完整页面，各自带 PageHeader 与自己的数据查询
 * （webhooks 838 行、audit 487 行）。嵌进设置子路由会同时出现两个页头，并且
 * 设置页自己已有独立滚动容器——嵌进来就是三层滚动。
 */
import { Link } from 'react-router'
import { BellRing, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSectionCard } from './settings-section-card'

/** 入口卡 = 区块卡 + 一个跳转按钮；按钮是 link 语义，用 Button asChild 承载 */
function EntryLink({ to, label }: { to: string; label: string }) {
  return (
    <Button asChild variant="outline">
      <Link to={to}>{label}</Link>
    </Button>
  )
}

export function IntegrationPanel() {
  return (
    <div className="flex flex-col gap-3">
      <SettingsSectionCard
        icon={BellRing}
        title="推送通知到外部"
        description="把服务器事件推送到 QQ 群 / Discord / 企业微信等，需要对方提供一个 Webhook 地址"
      >
        <div className="flex flex-wrap items-center gap-3">
          <EntryLink to="/webhooks" label="去配置推送" />
          <span className="text-mcs-xs text-mcs-text-muted">这是独立页面，点开会离开设置</span>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        icon={ScrollText}
        title="谁做了什么"
        description="查看管理员操作记录与命令执行历史，出了问题可以回查"
      >
        <div className="flex flex-wrap items-center gap-3">
          <EntryLink to="/audit" label="查看操作记录" />
          <span className="text-mcs-xs text-mcs-text-muted">这是独立页面，点开会离开设置</span>
        </div>
      </SettingsSectionCard>
    </div>
  )
}
