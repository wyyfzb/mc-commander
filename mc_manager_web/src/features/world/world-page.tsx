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
import { AlertTriangle, Archive, RefreshCw } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
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
import { DatapackPanel } from './components/datapack-panel'
import { PushChannelCard } from './components/push-channel-card'
import { useServerProperties, useUpdateProperties, useWorldInfo } from './queries'
import { InstanceRequiredState } from '@/features/instances/components/instance-required-state'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Card } from '@/components/mcs/card'
import { PageHeader } from '@/components/mcs/page-header'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'

type WorldTab = 'properties' | 'gamerule' | 'datapack'

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

  // 无实例门：加载中/加载失败/真空态/待选中四态各自诚实（见 InstanceRequiredState）
  if (!instanceId) {
    return <InstanceRequiredState />
  }

  const isRconConnected = statusQuery.data?.capabilities.rcon ?? false
  const mcVersion = statusQuery.data?.mcVersion ?? ''

  /** 当前 Tab（URL 深链接初始化；非法值回退 properties） */
  const tabParam = searchParams.get('tab')
  const activeTab: WorldTab =
    tabParam === 'gamerule' || tabParam === 'datapack' ? tabParam : 'properties'
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
    /* @container：主从分栏按「可用内容宽」切档而非视口宽——侧栏可折叠（56px ↔ 208px），
       同视口下内容宽差 152px：1023 视口展开侧栏内容已有 784px（恰容 320+16+448），
       视口差 1px 未达 lg 仍上下堆叠；折叠侧栏 936px 也早该分栏 */
    <div className="@container flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="世界"
        description="服务器属性 · 游戏规则 · 存档"
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate('/settings/backup')}>
            <Archive aria-hidden />
            备份管理
          </Button>
        }
      />

      {/* ── 数据错误横幅（查询失败明确报错，避免左栏/属性面板把错误呈现为空态） ── */}
      {(worldQuery.isError || propertiesQuery.isError) && (
        <NoticeBanner variant="error" icon={AlertTriangle}>
          <span className="flex items-center gap-2">
            <b>世界数据获取失败</b> ·{/* 双查询同错时两部分都列出（审查观察①） */}
            {[
              worldQuery.isError ? '世界信息不可用' : null,
              propertiesQuery.isError ? '服务器属性不可用' : null,
            ]
              .filter(Boolean)
              .join('、')}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-mcs-2xs text-mcs-error-fg"
              onClick={() => {
                if (worldQuery.isError) void worldQuery.refetch()
                if (propertiesQuery.isError) void propertiesQuery.refetch()
              }}
            >
              <RefreshCw className="size-3" aria-hidden />
              重试
            </Button>
          </span>
        </NoticeBanner>
      )}

      {/* ── 主体：左栏信息卡 + 右栏 Tabs ──
          分栏阈值为容器档 @3xl=768px：左栏固定 320px + 列距 16px + 右栏最小 432px。
          低于此宽右栏 Tabs 会被压到读不了几行，改为上下堆叠（左栏限高内滚） */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 @3xl:flex-row">
        {/* 左栏：世界信息 + 维度卡（窄内容宽整宽堆叠并限高内滚，@3xl 起固定 320px） */}
        <div className="flex min-h-0 w-full shrink-0 flex-col gap-4 overflow-y-auto max-h-[45%] @3xl:max-h-none @3xl:w-80">
          <WorldInfoCard
            world={worldQuery.data ?? null}
            isLoading={worldQuery.isLoading}
            onRefresh={() => void worldQuery.refetch()}
            className="animate-mcs-fade-up mcs-delay-1"
          />
          <DimensionCards
            dimensions={worldQuery.data?.dimensions}
            className="animate-mcs-fade-up mcs-delay-2"
          />
        </div>

        {/* ── 右栏：属性 / 游戏规则 Tabs ── */}
        <Card as="div" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as WorldTab)}
            className="flex h-full min-h-0 flex-col"
          >
            <TabsList
              variant="line"
              className="h-10 shrink-0 justify-start gap-0 border-b border-mcs-border-muted px-2 py-0"
            >
              <TabsTrigger value="properties" className="h-10 px-3 text-mcs-sm after:bg-mcs-accent">
                服务器属性
              </TabsTrigger>
              <TabsTrigger value="gamerule" className="h-10 px-3 text-mcs-sm after:bg-mcs-accent">
                游戏规则
              </TabsTrigger>
              <TabsTrigger value="datapack" className="h-10 px-3 text-mcs-sm after:bg-mcs-accent">
                数据包
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="properties"
              className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
            >
              {/* 推送通道写在属性页签内：它写的就是 server.properties 里的键，
                  而属性表把这几项渲染成只读行——开关放在同一屏，用户才不必去手改文件 */}
              <div className="flex flex-col gap-4">
                <PushChannelCard instanceId={instanceId} isRunning={isRunning} />
                <PropertiesPanel
                  properties={propertiesQuery.data}
                  isLoading={propertiesQuery.isLoading}
                  onSave={handleSaveProperties}
                  onEditingChange={setPropertiesEditing}
                  isRunning={isRunning}
                  onRestart={() => handleRestart()}
                />
              </div>
            </TabsContent>
            <TabsContent
              value="gamerule"
              className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
            >
              <GamerulePanel
                instanceId={instanceId}
                mcVersion={mcVersion}
                isRconConnected={isRconConnected}
                onSendCommand={handleSendCommand}
              />
            </TabsContent>
            <TabsContent
              value="datapack"
              className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
            >
              <DatapackPanel
                instanceId={instanceId}
                isRconConnected={isRconConnected}
                mcVersion={mcVersion}
                onSendCommand={handleSendCommand}
              />
            </TabsContent>
          </Tabs>
        </Card>
      </div>

      {/* ── 属性编辑未保存守卫确认 ── */}
      <ConfirmDialog
        open={guard.isBlocked}
        onOpenChange={(open) => !open && guard.cancel()}
        title="属性编辑尚未保存"
        description="离开页面将丢失未保存的属性修改，确定离开吗？"
        cancelText="留下"
        confirmText="放弃修改并离开"
        danger
        onConfirm={guard.proceed}
      />
    </div>
  )
}
