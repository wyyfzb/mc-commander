/**
 * UpdateCheckSection —— 更新检查卡片（运维韧性）
 * 查询 npm registry，1h staleTime，不轮询
 * - 加载中：spinner + 文案
 * - 最新版本：绿色 CheckCircle + 当前版本号 + 重试按钮
 * - 离线：灰色 + WifiOff 图标
 * - 有更新：黄色警告 + 版本号 + 「立即更新」按钮 + 外链
 */
import { useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { useCheckUpdate } from '@/api/queries'
import { applyPanelUpdate } from '@/api/panel'
import { useConnectionStore } from '@/stores/connection'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { toast } from 'sonner'

export function UpdateCheckSection() {
  const config = useConnectionStore()
  const { data, isLoading, isError, refetch } = useCheckUpdate()
  const [updating, setUpdating] = useState(false)

  // 更新由 root 单元在面板之外执行：成功后 systemd 把面板拉起来，失败则自动回退。
  // 面板此刻会被停掉，故这里不等结果，只把「已开始」告诉用户。
  const startUpdate = async () => {
    if (!data?.latest) return
    setUpdating(true)
    try {
      await applyPanelUpdate(config, `v${data.latest}`)
      toast.success('已开始更新，面板会短暂断开', {
        description: '完成后自动恢复；失败会自动回退到当前版本。',
        duration: 8000,
      })
    } catch {
      // 具体原因由 api 层统一提示（权限缺失 / 单元不存在等），这里只解除按钮锁
      setUpdating(false)
    }
  }

  if (isLoading) {
    return (
      <Card className="flex items-center gap-3 px-4 py-3">
        <Loader2 className="size-4 animate-spin text-mcs-text-muted" aria-hidden />
        <span className="text-mcs-sm text-mcs-text-muted">正在检查更新…</span>
      </Card>
    )
  }

  // 检查失败不能静默留白：用户点进「关于」就是要知道有没有新版，空白等于什么都没说
  if (isError || !data) {
    return (
      <NoticeBanner variant="neutral" icon={WifiOff}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span>没查到最新版本（面板连不上更新源，不影响使用）</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-mcs-xs font-medium text-mcs-info-fg hover:underline"
          >
            重试
          </button>
        </div>
      </NoticeBanner>
    )
  }

  // 已是最新
  if (!data.hasUpdate) {
    return (
      <Card className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-success-bg-subtle">
          <CheckCircle2 className="size-4 text-mcs-success-fg" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-mcs-sm font-semibold text-mcs-text-default">已是最新版本</div>
          <div className="text-mcs-xs text-mcs-text-muted">
            {data.offline ? '无法连接更新服务器（离线）' : `当前 v${data.current}`}
          </div>
        </div>
        {data.offline && <WifiOff className="size-4 text-mcs-text-muted" aria-hidden />}
        <button
          type="button"
          onClick={() => void refetch()}
          className="text-mcs-xs text-mcs-info-fg hover:underline"
          aria-label="重新检查"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </Card>
    )
  }

  // 有更新可用
  return (
    <NoticeBanner variant="warning" form="card" icon={RefreshCw}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <div className="font-semibold text-mcs-text-default">发现新版本 v{data.latest}</div>
          <div className="text-mcs-xs text-mcs-text-muted">当前 v{data.current}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data.url && (
            <a
              href={data.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-mcs-xs font-medium text-mcs-warning-fg hover:underline"
            >
              查看 <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
          <Button size="sm" onClick={() => void startUpdate()} disabled={updating}>
            {updating ? '正在更新…' : '立即更新'}
          </Button>
        </div>
      </div>
    </NoticeBanner>
  )
}
