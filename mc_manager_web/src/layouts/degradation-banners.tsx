/**
 * DegradationBanners —— 降级横幅组（连接降级与数据缺失的诚实提示）
 * - WS 断开：已降级 HTTP 轮询（数据仍可用）+ 手动重连按钮；间隔取自 queries 的常量
 * - RCON 未连接：实时数据（睡眠状态等）不可用 + 需在服务器上开启的说明
 *   （enable-rcon 属安全敏感项，properties-panel 对其恒渲染只读占位符——
 *   故不给「前往启用」这类界面做不到的出口，只写实情与动作）
 * 设计纪律：NoticeBanner 四色 token；禁用文案值一律由代码常量拼接，不写死
 */
import { RefreshCw, ShieldAlert, WifiOff } from 'lucide-react'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Button } from '@/components/ui/button'
import { getSocketSingleton } from '@/hooks/use-server-socket'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { FALLBACK_POLL_INTERVAL_MS } from '@/api/queries'

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
          {/* 层级分离：文案靠左成一体，重连按钮独立右侧动作为实心边界按钮，
              不再以同色 inline ghost 融入提示文字 */}
          <span className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <b>WebSocket 已断开</b> · 已降级为定时刷新（每 {FALLBACK_POLL_INTERVAL_MS / 1000} 秒），数据仍可用
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 border-mcs-error-border bg-mcs-bg-default text-mcs-2xs text-mcs-error-fg hover:bg-mcs-state-hover"
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
          <span className="min-w-0">
            <b>RCON 未连接</b> · 玩家血量、坐标、睡眠等实时数据不可用；需在服务器上把
            server.properties 的 enable-rcon 设为 true（并配置 rcon.password）后重启实例，
            该键属安全敏感项、面板不代为修改
          </span>
        </NoticeBanner>
      )}
    </div>
  )
}
