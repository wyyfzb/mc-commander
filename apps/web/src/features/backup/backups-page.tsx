/**
 * BackupsPage —— 侧栏一级「备份」页（实例级，与 玩家/世界/文件/插件/任务 同构）
 *
 * 页面上有两类东西，边界是「属于谁」：
 * - 该实例的备份（列表 / 恢复 / 删除 / 自动备份现状）—— 必须有实例
 * - 归档快照（卸载后保留、已无索引的快照目录）—— **面板级**，没有实例时也在
 *
 * 后者不跟着前者一起被空态挡住：卸载最后一台实例时确认框刚说过「已保留 N 份备份」，
 * 用户转身来这一页却什么都看不到，那是最需要它的时刻。
 */
import { PageHeader } from '@/components/mcs/page-header'
import { useInstances } from '@/api/queries'
import { InstanceRequiredState } from '@/features/instances/components/instance-required-state'
import { useServerStore } from '@/stores/server'
import { AutoBackupSummary } from './components/auto-backup-summary'
import { ArchivedSnapshotsCard } from './components/archived-snapshots-card'
import { BackupPanel } from './components/backup-panel'

export function BackupsPage() {
  const instanceId = useServerStore((s) => s.instanceId)
  const instancesQuery = useInstances()
  const instanceName = instancesQuery.data?.find((i) => i.id === instanceId)?.name ?? ''

  return (
    <div className="@container flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="备份"
        description="备份就是这个服务器在某一刻的存档：世界、插件、配置一起被打包，恢复会整体回到那一刻。"
      />
      {/* 内容区独立滚动：备份列表可长到 10 条 + 归档快照，让页头跟着滚会让「这是哪个实例的
          备份」在滚动后消失 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3">
          {instanceId ? (
            <>
              <AutoBackupSummary instanceId={instanceId} />
              <BackupPanel instanceId={instanceId} />
            </>
          ) : (
            <InstanceRequiredState />
          )}
          <ArchivedSnapshotsCard instanceId={instanceId} instanceName={instanceName} />
        </div>
      </div>
    </div>
  )
}
