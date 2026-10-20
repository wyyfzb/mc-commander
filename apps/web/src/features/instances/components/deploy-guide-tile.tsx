/**
 * DeployGuideTile —— 单实例时的部署引导块（实例页网格右侧，三列档下跨两列）
 * 网格列数按容器宽切档（见 INSTANCE_GRID_CLASS），三列档（内容宽 ≥1024px）下卡片只占
 * 最左一格，右侧两列由本块补满：既不把唯一卡片拉成整幅宽度（卡内 4 格指标摊到 300px 级
 * 会破坏监控区的密度分级），又把「再开一个服」的下一步放进视线。
 * 两列档（内容宽 672–1023px）本块只占一格，与卡片并列——跨满整行会把第二行留空，视觉上像缺数据
 */
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/mcs/card'
import { cn } from '@/lib/utils'

interface DeployGuideTileProps {
  /** 部署向导入口（与页面头部 CTA 同一入口） */
  onDeploy: () => void
  /** 内存余量一行；null 表示暂无读数（算不出余量，整行不渲染） */
  remainingText?: string | null
  /** 入场 stagger（与实例卡同批编排，由调用点注入） */
  className?: string
}

export function DeployGuideTile({ onDeploy, remainingText, className }: DeployGuideTileProps) {
  return (
    <Card
      as="div"
      data-testid="deploy-guide-tile"
      className={cn(
        'flex flex-col items-center justify-center gap-2 border-dashed p-4 text-center',
        className,
      )}
    >
      <span
        className="flex size-10 items-center justify-center rounded-mcs-md bg-mcs-bg-default"
        aria-hidden
      >
        <Plus className="size-5 text-mcs-text-muted" />
      </span>
      <p className="text-mcs-sm font-medium text-mcs-text-default">再部署一个实例</p>
      <p className="text-mcs-xs text-mcs-text-muted">
        独立目录 / 端口 / Java 版本，切换实例互不影响
      </p>
      {/* 把「还能开几个」摆在入口处：这里是用户决定要不要再加一台的地方，
          等进了向导才告诉他内存不够，等于让他白走一趟 */}
      {remainingText != null && <p className="text-mcs-xs text-mcs-text-muted">{remainingText}</p>}
      <Button variant="outline" size="sm" className="mt-1" onClick={onDeploy}>
        打开部署向导
      </Button>
    </Card>
  )
}
