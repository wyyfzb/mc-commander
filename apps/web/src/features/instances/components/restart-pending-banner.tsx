/**
 * RestartPendingBanner —— 「面板已改、重启后才生效」常驻指示器（实例页一处汇总）
 *
 * 汇总视角的载体，逐台的载体是实例卡片上的「待重启」徽章——用户不必拿名字比对是哪一台。
 * 清除走 status 事件的 `started`（重启后自动消失），跨刷新由 store 的 persist 维持。
 * 名字取自页面已加载的列表，查不到（如已卸载）回退 id，不静默丢掉那条待办。
 */
import { useEffect } from 'react'
import { RotateCcw } from 'lucide-react'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { useRestartPendingStore } from '@/stores/restart-pending'
import { instanceLabel } from '@/lib/instance-label'
import type { InstanceSummary } from '@/api/types'

export function RestartPendingBanner({ instances }: { instances: InstanceSummary[] }) {
  const pending = useRestartPendingStore((s) => s.pending)
  const pruneTo = useRestartPendingStore((s) => s.pruneTo)

  /* 实例列表已加载后，丢掉列表里不存在的条目：实例被卸载后其 started 永不再来，
     留着就是一条永远撤不掉的横幅（且持久化，刷新后仍在）。只在列表非空时清——
     空列表也可能是「还没加载完」，据此清会把有效待办误删。 */
  useEffect(() => {
    if (instances.length === 0) return
    pruneTo(new Set(instances.map((i) => i.id)))
  }, [instances, pruneTo])

  const names = Object.keys(pending).map((id) => {
    const found = instances.find((i) => i.id === id)
    return found ? instanceLabel(found) : id
  })
  if (names.length === 0) return null

  /* 只说明「有哪几个实例有待生效的改动 + 怎么让它生效」，不复述改了哪几项：
     本集合是实例级的（不记字段），而弹窗里保存的是整份设置——点进去就能看到当前值。
     措辞用「设置」而非「启动配置」：实时推送开关同属本集合，说「启动配置」对它就是假陈述 */
  return (
    <NoticeBanner variant="info" icon={RotateCcw}>
      {`${names.join('、')} 的设置已修改，重启实例后生效`}
    </NoticeBanner>
  )
}
