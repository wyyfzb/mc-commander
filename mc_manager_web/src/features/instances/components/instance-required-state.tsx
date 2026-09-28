/**
 * InstanceRequiredState —— 「本页所需的实例当前不可用」的统一门（7 处页面/面板共用）
 *
 * 原先各页各自 gate 在 `!instanceId` 上、一律渲染「暂无服务器实例 + 去部署向导」，
 * 而 `instanceId` 初值为 null、app-shell 只在**列表就绪后**才自动选第一个实例：
 * 列表还在路上（刷新首帧）或请求失败时会持续显示「你没有实例」，把用户推向一件
 * 当下没有意义的动作（正确动作是等/重试）。判据收敛到实例列表本身，四态各自诚实：
 * 加载中 → 过渡占位；失败 → 报错可重试；确实为空 → 建实例；有实例待选中 → 过渡占位。
 */
import { Loader2, ServerOff } from 'lucide-react'
import { useNavigate } from 'react-router'
import { EmptyState } from '@/components/mcs/empty-state'
import { useInstances } from '@/api/queries'

/** 过渡态：列表未到，或有实例但 app-shell 尚未完成自动选中（同一帧语义） */
function InstancePendingState() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-6 animate-spin text-mcs-text-muted" aria-hidden />
      <p className="text-mcs-sm text-mcs-text-muted">正在载入服务器实例…</p>
    </div>
  )
}

export function InstanceRequiredState() {
  const navigate = useNavigate()
  const instancesQuery = useInstances()

  if (instancesQuery.isPending) return <InstancePendingState />
  if (instancesQuery.isError) {
    return (
      <EmptyState
        icon={ServerOff}
        title="实例列表加载失败"
        hint="无法获取服务器实例列表，请检查面板连接后重试"
        action={{ label: '重试', onClick: () => void instancesQuery.refetch() }}
      />
    )
  }
  if ((instancesQuery.data?.length ?? 0) > 0) return <InstancePendingState />
  return (
    <EmptyState
      icon={ServerOff}
      title="暂无服务器实例"
      hint="使用部署向导创建第一个实例"
      action={{ label: '部署新实例', onClick: () => navigate('/instances?tab=deploy') }}
    />
  )
}
