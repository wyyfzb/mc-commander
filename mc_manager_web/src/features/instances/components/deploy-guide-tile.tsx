/**
 * DeployGuideTile —— 单实例时的部署引导块（实例页网格右栏）
 * 单实例下原三列网格只占最左一格，1280/1440 上右侧约 65% 是空白（J21）。
 * 不把唯一卡片拉成整幅宽度：卡内 4 格指标摊到 300px 级会破坏监控区的密度分级（P3），
 * 也让卡片操作行与名称相隔一整屏。改为两栏——左卡片、右引导块，把「再开一个服」的下一步放进视线
 */
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/mcs/card'
import { cn } from '@/lib/utils'

interface DeployGuideTileProps {
  /** 部署向导入口（与页面头部 CTA 同一入口） */
  onDeploy: () => void
  /** 入场 stagger（与实例卡同批编排，由调用点注入） */
  className?: string
}

export function DeployGuideTile({ onDeploy, className }: DeployGuideTileProps) {
  return (
    <Card
      as="div"
      data-testid="deploy-guide-tile"
      className={cn(
        'flex flex-col items-center justify-center gap-2 border-dashed p-4 text-center',
        className,
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-mcs-md bg-mcs-bg-default" aria-hidden>
        <Plus className="size-5 text-mcs-text-muted" />
      </span>
      <p className="text-mcs-sm font-medium text-mcs-text-default">再部署一个实例</p>
      <p className="text-mcs-xs text-mcs-text-muted">独立目录 / 端口 / Java 版本，切换实例互不影响</p>
      <Button variant="outline" size="sm" className="mt-1" onClick={onDeploy}>
        打开部署向导
      </Button>
    </Card>
  )
}
