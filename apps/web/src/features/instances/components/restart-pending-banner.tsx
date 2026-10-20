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

  const entries = Object.keys(pending).map((id) => {
    const found = instances.find((i) => i.id === id)
    return { id, label: found ? instanceLabel(found) : id, running: found?.isRunning === true }
  })
  if (entries.length === 0) return null

  /* 两处措辞各有约束：「设置」涵盖推送开关（说「启动配置」对它是假陈述）；
     已停止的实例没有「重启」这一步，合成一个分支会让用户去找不存在的按钮 */
  const running = entries.filter((e) => e.running).map((e) => e.label)
  const stopped = entries.filter((e) => !e.running).map((e) => e.label)
  const parts: string[] = []
  if (running.length > 0) parts.push(`${running.join('、')} 的设置已修改，重启后生效`)
  if (stopped.length > 0) parts.push(`${stopped.join('、')} 的设置已修改，下次启动即生效`)
  return (
    <NoticeBanner variant="info" icon={RotateCcw}>
      {parts.join('；')}
    </NoticeBanner>
  )
}
