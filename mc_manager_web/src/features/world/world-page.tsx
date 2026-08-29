/**
 * WorldPage —— 世界页
 * - 左栏（320px）：世界信息卡（9 行只读 + 存档进度条）+ 维度卡（3 张）
 * - 右栏：Tabs（服务器属性 / 游戏规则）——属性走 PUT /properties 热改通道，
 *   游戏规则走 POST /command（gamerule）RCON 通道，互不干扰
 * - 数据流：useWorldInfo / useServerProperties 30s 轮询；useInstanceStatus 提供
 *   mcVersion（gamerule 双版本选集）与 isRconConnected（RCON 可用性）
 * - URL 深链接：?tab=properties|gamerule（可分享、可刷新保持）
 * - 实例切换：query key 含 instanceId，自动切换；无实例显示空态
 */
import { useState } from 'react'
import { Archive, ServerOff } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { apiPost } from '@/api/client'
import { apiSendCommand } from '@/api/players'
import { useInstanceStatus, queryKeys } from '@/api/queries'
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { WorldInfoCard } from './components/world-info-card'
import { DimensionCards } from './components/dimension-cards'
import { PropertiesPanel } from './components/properties-panel'
import { GamerulePanel } from './components/gamerule-panel'
import { useServerProperties, useUpdateProperties, useWorldInfo } from './queries'
import { EmptyState } from '@/components/mcs/empty-state'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'

type WorldTab = 'properties' | 'gamerule'

export function WorldPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const instanceId = useServerStore((s) => s.instanceId)
  /** 属性面板编辑态（未保存守卫） */
  const [propertiesEditing, setPropertiesEditing] = useState(false)
  const guard = useUnsavedGuard(propertiesEditing)
  const config = useConnectionStore()
  const worldQuery = useWorldInfo(instanceId)
  const propertiesQuery = useServerProperties(instanceId)
  const statusQuery = useInstanceStatus(instanceId)
  const updateProperties = useUpdateProperties(instanceId)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  if (!instanceId) {
    return (
      <EmptyState
        icon={ServerOff}
        title="暂无服务器实例"
        hint="请先在服务端创建 MC 服务器实例"
        action={{ label: '前往实例管理', onClick: () => navigate('/instances') }}
      />
    )
  }

  const isRconConnected = statusQuery.data?.isRconConnected ?? false
  const mcVersion = statusQuery.data?.mcVersion ?? ''

  /** 当前 Tab（URL 深链接初始化；非法值回退 properties） */
  const tabParam = searchParams.get('tab')
  const activeTab: WorldTab = tabParam === 'gamerule' ? 'gamerule' : 'properties'
  const setActiveTab = (tab: WorldTab) => {
    const next = new URLSearchParams(searchParams)
    if (tab === 'properties') next.delete('tab')
    else next.set('tab', tab)
    setSearchParams(next, { replace: true })
  }

  /** 发送命令（POST /command；响应为服务端 sendCommand 文本，可能为 null） */
  const handleSendCommand = async (command: string): Promise<string | null> => {
    const resp = await apiSendCommand(config, instanceId, command)
    return resp == null ? null : String(resp)
  }

  /** 保存属性（PUT /properties）；返回 restartRequired 键数组 */
  const handleSaveProperties = async (payload: Record<string, string>): Promise<string[]> => {
    const res = await updateProperties.mutateAsync(payload)
    return res.restartRequired ?? []
  }

  /** 重启服务器（属性保存后 Dialog 内「立即重启」触发；复用 instance-controls 同款 API） */
  const handleRestart = async () => {
    if (!instanceId) throw new Error('未选择实例')
    await apiPost(`/api/v1/instances/${instanceId}/restart`, config)
    void queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId) })
  }

  const isRunning = statusQuery.data?.isRunning ?? false

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      {/* ── 页头：标题 + 「备份世界」入口（→ 设置备份页） ── */}
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h2 className="text-mcs-xl font-semibold text-mcs-text-default">世界</h2>
          <p className="text-mcs-xs text-mcs-text-subtle">服务器属性 · 游戏规则 · 存档</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate('/settings/backup')}>
          <Archive aria-hidden />
          备份世界
        </Button>
      </div>

      {/* ── 主体：左栏信息卡 + 右栏 Tabs ── */}
      <div className="flex min-h-0 flex-1 gap-4">
      {/* 左栏：世界信息 + 维度卡（320px 固定宽） */}
      <div className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto">
        <WorldInfoCard
          world={worldQuery.data ?? null}
          isLoading={worldQuery.isLoading}
          onRefresh={() => void worldQuery.refetch()}
        />
        <DimensionCards dimensions={worldQuery.data?.dimensions} />
      </div>

      {/* ── 右栏：属性 / 游戏规则 Tabs ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as WorldTab)} className="flex h-full min-h-0 flex-col">
          <TabsList className="h-10 shrink-0 justify-start gap-0 rounded-none border-b border-mcs-border-muted bg-transparent px-2 py-0">
            <TabsTrigger
              value="properties"
              className="h-10 rounded-none border-b-2 border-transparent px-3 text-mcs-sm data-[state=active]:border-mcs-accent data-[state=active]:text-mcs-text-default data-[state=active]:shadow-none"
            >
              服务器属性
            </TabsTrigger>
            <TabsTrigger
              value="gamerule"
              className="h-10 rounded-none border-b-2 border-transparent px-3 text-mcs-sm data-[state=active]:border-mcs-accent data-[state=active]:text-mcs-text-default data-[state=active]:shadow-none"
            >
              游戏规则
            </TabsTrigger>
          </TabsList>
          <TabsContent value="properties" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
            <PropertiesPanel
              properties={propertiesQuery.data}
              isLoading={propertiesQuery.isLoading}
              onSave={handleSaveProperties}
              onEditingChange={setPropertiesEditing}
              isRunning={isRunning}
              onRestart={() => handleRestart()}
            />
          </TabsContent>
          <TabsContent value="gamerule" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
            <GamerulePanel
              instanceId={instanceId}
              mcVersion={mcVersion}
              isRconConnected={isRconConnected}
              onSendCommand={handleSendCommand}
            />
          </TabsContent>
        </Tabs>
      </div>
      </div>

      {/* ── 属性编辑未保存守卫确认 ── */}
      <Dialog open={guard.isBlocked} onOpenChange={(open) => !open && guard.cancel()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>属性编辑尚未保存</DialogTitle>
            <DialogDescription>离开页面将丢失未保存的属性修改，确定离开吗？</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={guard.cancel}>
              留下
            </Button>
            <Button variant="destructive" onClick={guard.proceed}>
              放弃修改并离开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
