/**
 * GeneralPanel —— 设置页「通用设置」卡片
 * - 意外停止自动重启：服务端实例配置（PUT /instances/:id {autoRestart}）
 *   乐观翻转 → PUT → 成功 toast「自动重启设置已保存」/ 失败回滚 + 错误 toast；
 *   连续快速切换用序号守卫（ref 计数）：陈旧结果作废——成功不 fetch、失败不回滚不弹错
 * - 界面主题：ui store theme/setTheme（本地偏好即时生效，深色/浅色）
 * - 实例为 null：显示无实例提示，不发请求（autoRestart 为实例级服务端配置）
 * 设计纪律：实底卡（玻璃禁区）+ --mcs-* 语义 token + shadcn 基座
 */
import { useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { queryKeys, useInstanceStatus } from '@/api/queries'
import { apiUpdateInstance } from '@/api/instances'
import { getFriendlyErrorText } from '@/api/errors'
import { queryPhase } from '@/lib/query-phase'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useUiStore, type ThemeMode } from '@/stores/ui'
import type { GeneralPanelProps } from './contracts'
import { Card, CardBody, CardHeader } from '@/components/mcs/card'

export function GeneralPanel(_props: GeneralPanelProps) {
  const instanceId = useServerStore((s) => s.instanceId)
  const config = useConnectionStore()
  const queryClient = useQueryClient()
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const terminalAutoScroll = useUiStore((s) => s.terminalAutoScroll)
  const setTerminalAutoScroll = useUiStore((s) => s.setTerminalAutoScroll)
  const confirmCommands = useUiStore((s) => s.confirmCommands)
  const setConfirmCommands = useUiStore((s) => s.setConfirmCommands)

  const instanceQuery = useInstanceStatus(instanceId)
  const instance = instanceQuery.data
  /** 实例配置相位：失败时不得用默认值冒充服务端事实 */
  const instancePhase = queryPhase(instanceQuery)

  /** 乐观翻转本地值（null = 跟随服务端 useInstanceStatus 数据） */
  const [autoRestartOverride, setAutoRestartOverride] = useState<boolean | null>(null)
  /** 切换序号守卫（ref 计数） */
  const seqRef = useRef(0)

  /** 展示值：本地乐观值优先 → 服务端值 → 默认 true */
  const autoRestart = autoRestartOverride ?? instance?.autoRestart ?? true

  const handleAutoRestartChange = async (checked: boolean) => {
    // 乐观翻转：先于请求更新界面，成功后再与服务端对齐
    setAutoRestartOverride(checked)
    const seq = ++seqRef.current
    if (!instanceId) return // 无实例：仅本地态，不发请求
    try {
      await apiUpdateInstance(config, instanceId, { autoRestart: checked })
      if (seq !== seqRef.current) return // 陈旧结果作废：成功不 fetch 不弹 toast（最新意图已覆盖）
      toast.success('自动重启设置已保存')
      // 与服务端对齐：失效实例查询，等下次轮询前拿到确认值
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId) })
    } catch (e) {
      if (seq !== seqRef.current) return // 陈旧失败：不回滚不弹错（防止误回滚最新意图）
      setAutoRestartOverride(null) // 回滚：回到服务端值
      toast.error(`自动重启设置保存失败：${getFriendlyErrorText(e)}`)
    }
  }

  const handleThemeChange = (value: string) => {
    setTheme(value as ThemeMode)
  }

  return (
    <Card>
      <CardHeader className="gap-3 border-b border-mcs-border-subtle px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
          <Settings2 className="size-4 text-mcs-accent-fg" aria-hidden />
        </span>
        <h3 className="text-mcs-lg font-semibold">通用设置</h3>
      </CardHeader>

      <CardBody className="flex flex-col px-4">
        {instanceId ? (
          <div className="flex items-center gap-3 border-b border-mcs-border-subtle py-3 last:border-b-0">
            <div className="min-w-0 flex-1">
              <div className="text-mcs-sm font-semibold text-mcs-text-default">
                意外停止自动重启
              </div>
              <div className="mt-0.5 text-mcs-xs text-mcs-text-muted">
                服务器意外崩溃/退出后自动重启（手动停止不触发）
                {instancePhase === 'failed' && (
                  <span className="text-mcs-error-fg"> · 实例配置读取失败，下方状态不可信</span>
                )}
              </div>
            </div>
            {/* 查询失败时服务端值缺失，`?? true` 会把「读不到」显示成「已开启」——
                这是肯定式假信息（用户会以为崩溃后真会自动重启）。无本地乐观意图时
                不渲染开关，如实标「状态未知」；已有 override 说明用户刚操作过，仍显示其意图。 */}
            {instancePhase === 'failed' && autoRestartOverride === null ? (
              <span className="shrink-0 text-mcs-xs text-mcs-text-muted">状态未知</span>
            ) : (
              <Switch
                checked={autoRestart}
                onCheckedChange={(checked) => void handleAutoRestartChange(checked)}
                aria-label="意外停止自动重启"
              />
            )}
          </div>
        ) : (
          <div className="border-b border-mcs-border-subtle py-3 last:border-b-0">
            <div className="text-mcs-sm font-semibold text-mcs-text-default">意外停止自动重启</div>
            <p className="mt-0.5 text-mcs-xs text-mcs-text-muted">
              未选择实例 — 自动重启为服务器实例配置，选择实例后可修改
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-mcs-sm font-semibold text-mcs-text-default">界面主题</div>
            <div className="mt-0.5 text-mcs-xs text-mcs-text-muted">深色/浅色主题切换</div>
          </div>
          <Select value={theme} onValueChange={handleThemeChange}>
            <SelectTrigger className="w-24" aria-label="界面主题">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">暗色</SelectItem>
              <SelectItem value="light">亮色</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 三项偏好（本地持久化即时生效） */}
        <div className="flex items-center gap-3 border-t border-mcs-border-subtle py-3">
          <div className="min-w-0 flex-1">
            <div className="text-mcs-sm font-semibold text-mcs-text-default">终端自动滚动</div>
            <div className="mt-0.5 text-mcs-xs text-mcs-text-muted">
              新日志自动滚动到底部（关闭后停留在当前位置）
            </div>
          </div>
          <Switch
            checked={terminalAutoScroll}
            onCheckedChange={setTerminalAutoScroll}
            aria-label="终端自动滚动"
          />
        </div>

        <div className="flex items-center gap-3 border-t border-mcs-border-subtle py-3">
          <div className="min-w-0 flex-1">
            <div className="text-mcs-sm font-semibold text-mcs-text-default">命令执行二次确认</div>
            <div className="mt-0.5 text-mcs-xs text-mcs-text-muted">
              危险命令执行前弹确认（终端输入不受影响）
            </div>
          </div>
          <Switch
            checked={confirmCommands}
            onCheckedChange={setConfirmCommands}
            aria-label="命令执行二次确认"
          />
        </div>
      </CardBody>
    </Card>
  )
}
