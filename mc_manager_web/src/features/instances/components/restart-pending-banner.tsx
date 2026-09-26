/**
 * RestartPendingBanner —— 启动配置「待重启生效」常驻指示器
 *
 * 承担 docs/design-review-guidelines.md 里登记的**级别 3 缺口**：启动配置保存后不立即生效，
 * 是持续状态，但保存动作发生在「保存后即关闭」的弹窗里、原本没有可见常驻载体
 * （口径只能临时压在几秒即散的 toast 文案里）。本组件是该缺口的正式载体。
 *
 * 只覆盖启动配置（内存 / Aikar / JVM 参数）——世界属性、server.properties 文件、插件启停
 * 三类同主题但语义不一，未入本集合，理由见 stores/restart-pending.ts。
 *
 * 清除判据是 status 事件的 `started`（见 use-server-socket），故重启后本横幅自动消失；
 * 跨刷新由 store 的 persist 维持（用户改完关掉页面、明天再来仍能看到）。
 *
 * 集合按实例 id 记，而用户认的是实例名——名字取自页面已加载的列表（不在本组件里再查一次），
 * 列表里查不到的（如已卸载）回退显示 id，不静默丢掉那条待办。
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
     本集合是实例级的（不记字段），且弹窗里保存的是整份启动配置——点进去就能看到当前值 */
  return (
    <NoticeBanner variant="info" icon={RotateCcw}>
      {`${names.join('、')} 的启动配置已修改，重启实例后生效`}
    </NoticeBanner>
  )
}
