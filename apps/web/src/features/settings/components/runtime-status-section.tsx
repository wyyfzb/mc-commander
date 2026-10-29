/**
 * RuntimeStatusSection —— 运行环境（Node.js）检查
 *
 * 面板自更新只换代码，不动 Node 运行时；宿主机的 Node 补丁线一旦落后，
 * 用户既看不到也管不了。这里把「当前 / 官方最新」摆出来，能自动升级时给按钮。
 *
 * 只有软链指向本面板安装的 Node 才允许升级：指向别处时只提示原因，
 * 因为改它会破坏用户自己的系统环境。
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { apiRuntimeStatus, apiUpgradeRuntime } from '@/api/panel'
import { useConnectionStore } from '@/stores/connection'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { toast } from 'sonner'

export function RuntimeStatusSection() {
  const config = useConnectionStore()
  const queryClient = useQueryClient()
  const [upgrading, setUpgrading] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['panel-runtime'],
    queryFn: ({ signal }) => apiRuntimeStatus(config, signal),
    staleTime: 60 * 60_000,
    retry: false,
  })

  // 升级由 root 单元在面板之外执行，成功后面板在新版本上重启；
  // 故这里不等结果，只把「已开始」告诉用户
  const startUpgrade = async () => {
    setUpgrading(true)
    try {
      await apiUpgradeRuntime(config)
      toast.success('已开始升级运行环境，面板会重启一次', {
        description: '完成后自动恢复；失败会退回当前版本。',
        duration: 10_000,
      })
      // 升级期间接口会断，稍后再刷新一次状态
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['panel-runtime'] }), 90_000)
    } catch {
      setUpgrading(false)
    }
  }

  if (isLoading) {
    return (
      <Card className="flex items-center gap-3 px-4 py-3">
        <Loader2 className="size-4 animate-spin text-mcs-text-muted" aria-hidden />
        <span className="text-mcs-sm text-mcs-text-muted">正在检查运行环境…</span>
      </Card>
    )
  }

  // 查不到就如实说查不到：把「没查到」显示成「已最新」会让用户以为无需处理
  if (isError || !data) {
    return (
      <NoticeBanner variant="neutral" icon={ShieldAlert}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span>没查到运行环境状态（不影响使用）</span>
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

  // 落后且有可升级路径：这才是需要用户动手的状态
  if (data.hasUpdate && data.managed) {
    return (
      <NoticeBanner variant="warning" form="card" icon={AlertTriangle}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <div className="font-semibold text-mcs-text-default">
              运行环境需要更新（{data.current} → {data.latest}）
            </div>
            <div className="text-mcs-xs text-mcs-text-muted">
              Node.js {data.current} 缺少已发布的安全修复，升级后无需其它操作。
            </div>
          </div>
          <Button size="sm" onClick={() => void startUpgrade()} disabled={upgrading}>
            {upgrading ? '正在升级…' : '升级并重启'}
          </Button>
        </div>
      </NoticeBanner>
    )
  }

  // 落后但不可自动升级：说明原因与出路，不给按钮
  if (data.hasUpdate && !data.managed) {
    return (
      <NoticeBanner variant="neutral" form="card" icon={ShieldAlert}>
        <div className="min-w-0">
          <div className="font-semibold text-mcs-text-default">
            运行环境需要更新（{data.current} → {data.latest}）
          </div>
          <div className="text-mcs-xs text-mcs-text-muted">
            {data.reason ?? '当前 Node 不是本面板安装的，无法自动升级。'}
          </div>
        </div>
      </NoticeBanner>
    )
  }

  // 已是最新，或查询失败但当前不低于已知版本
  return (
    <Card className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-success-bg-subtle">
        <CheckCircle2 className="size-4 text-mcs-success-fg" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-mcs-sm font-semibold text-mcs-text-default">运行环境正常</div>
        <div className="text-mcs-xs text-mcs-text-muted">
          {data.latest
            ? `Node.js ${data.current}（${data.latest} 线最新）`
            : `Node.js ${data.current}`}
        </div>
      </div>
    </Card>
  )
}
