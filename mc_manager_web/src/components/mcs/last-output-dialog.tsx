/**
 * LastOutputDialog —— 实例末尾日志弹窗（issue 343：崩溃排障深入链接）
 * - 入口：崩溃/熔断 toast「查看末尾日志」action / 启动失败 toast（全局单例，ui store 控制）
 * - 打开时拉取 GET /instances/:id 消费 lastOutput（服务端进程末尾输出，崩溃时最接近现场）
 * - 手动刷新 + 空态诚实提示；等宽滚动区展示，不截断
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, ScrollText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiGet } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'

/** 末尾日志最大展示字符数（服务端 lastOutput 本身有界；防御性截断超长输出） */
const MAX_DISPLAY_CHARS = 20_000

export function LastOutputDialog() {
  const instanceId = useUiStore((s) => s.lastOutputInstanceId)
  const setInstanceId = useUiStore((s) => s.setLastOutputInstanceId)
  const open = instanceId !== null

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)

  const fetchLastOutput = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const status = await apiGet<{ lastOutput: string | null }>(
        `/api/v1/instances/${id}`,
        useConnectionStore.getState(),
      )
      setOutput(status.lastOutput)
    } catch (e) {
      setError(getFriendlyErrorText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!instanceId) return
    // oxlint-disable-next-line react/set-state-in-effect -- 打开时重取远程数据（重置 on 开关惯用法，market-sheet 同款），loading/error 同步置位供首帧渲染
    void fetchLastOutput(instanceId)
  }, [instanceId, fetchLastOutput])

  const truncated =
    output != null && output.length > MAX_DISPLAY_CHARS
      ? output.slice(-MAX_DISPLAY_CHARS)
      : output

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          // 关闭即重置（下次打开重新拉取，避免残留旧实例输出）
          setInstanceId(null)
          setOutput(null)
          setError(null)
        }
      }}
    >
      {/* 普通弹窗外观：玻璃效果预算仅限抽屉与确认弹窗（token-integrity 守卫） */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="size-4 text-mcs-accent-fg" aria-hidden />
            实例末尾日志
          </DialogTitle>
          <DialogDescription>
            服务器进程最近输出（崩溃/异常退出时最接近现场）
          </DialogDescription>
        </DialogHeader>

        <div className="relative min-h-40">
          {loading ? (
            <div
              className="flex min-h-40 flex-col items-center justify-center gap-2 text-mcs-text-muted"
              role="status"
              aria-label="加载末尾日志中"
            >
              <Loader2 className="size-5 animate-spin" aria-hidden />
              <p className="text-mcs-xs">正在获取末尾日志…</p>
            </div>
          ) : error ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-mcs-text-muted">
              <p className="text-mcs-xs text-mcs-error-fg">获取失败：{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => instanceId && void fetchLastOutput(instanceId)}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                重试
              </Button>
            </div>
          ) : truncated ? (
            <pre
              data-testid="last-output-content"
              className="max-h-72 overflow-auto rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default p-3 font-mono text-mcs-xs leading-relaxed text-mcs-text-default"
              aria-label="服务器末尾日志内容"
            >
              {truncated}
            </pre>
          ) : (
            <p className="flex min-h-40 items-center justify-center text-mcs-xs text-mcs-text-muted">
              暂无日志输出（服务端未上报 lastOutput）
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => instanceId && void fetchLastOutput(instanceId)}
            disabled={loading}
          >
            <RefreshCw className={`size-3.5${loading ? ' animate-spin' : ''}`} aria-hidden />
            刷新
          </Button>
          <Button size="sm" onClick={() => {
            setInstanceId(null)
            setOutput(null)
            setError(null)
          }}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
