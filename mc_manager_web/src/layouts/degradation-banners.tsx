/**
 * DegradationBanners —— 降级横幅组（连接降级与数据缺失的诚实提示）
 * - WS 断开：已降级 HTTP 轮询（数据仍可用）+ 手动重连按钮
 * - RCON 未连接：实时数据（睡眠状态等）不可用 + 检查（跳世界页属性）
 * 设计纪律：NoticeBanner 四色 token；文案即落地文案
 */
import { Link } from 'react-router'
import { RefreshCw, ShieldAlert, WifiOff } from 'lucide-react'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Button } from '@/components/ui/button'
import { getSocketSingleton } from '@/hooks/use-server-socket'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'

export function DegradationBanners() {
  const socketConnected = useServerStore((s) => s.socketConnected)
  const hasConnectedOnce = useServerStore((s) => s.hasConnectedOnce)
  const status = useServerStore((s) => s.status)
  const connectionReady = useConnectionStore((s) => s.status === 'ready')

  const wsDown = connectionReady && !socketConnected && hasConnectedOnce
  const rconDown = status?.isRunning === true && status.isRconConnected === false

  if (!wsDown && !rconDown) return null

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-4 pt-2">
      {wsDown && (
        <NoticeBanner variant="error" icon={WifiOff}>
          <span className="flex items-center gap-2">
            <b>WebSocket 已断开</b> · 已降级 HTTP 轮询（每 5s），数据仍可用
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-mcs-2xs text-mcs-error-fg"
              onClick={() => void getSocketSingleton()?.connect()}
            >
              <RefreshCw className="size-3" aria-hidden />
              重连
            </Button>
          </span>
        </NoticeBanner>
      )}
      {rconDown && (
        <NoticeBanner variant="warning" icon={ShieldAlert}>
          <span className="flex items-center gap-2">
            <b>RCON 未连接</b> · 玩家睡眠状态等实时数据不可用
            <Link
              to="/world"
              className="rounded-mcs-sm px-1.5 py-0.5 text-mcs-2xs font-medium text-mcs-warning-fg underline-offset-2 hover:underline"
            >
              检查
            </Link>
          </span>
        </NoticeBanner>
      )}
    </div>
  )
}
