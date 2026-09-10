/**
 * DegradationBanners —— 降级横幅组（连接降级与数据缺失的诚实提示）
 * - WS 断开：已降级 HTTP 轮询（数据仍可用）+ 手动重连按钮
 * - RCON 未连接：实时数据（睡眠状态等）不可用 + 跳服务器属性（enable-rcon 所在处）
 * 设计纪律：NoticeBanner 四色 token；文案即落地文案（数值须与 queries.ts 的轮询间隔一致）
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
          {/* 层级分离：文案靠左成一体，重连按钮独立右侧动作为实心边界按钮，
              不再以同色 inline ghost 融入提示文字 */}
          <span className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <b>WebSocket 已断开</b> · 已降级为定时刷新（每 30 秒），数据仍可用
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
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0">
              <b>RCON 未连接</b> · 玩家血量、坐标、睡眠等实时数据不可用
            </span>
            {/* 「检查」不指向能修的地方等于没有出口：enable-rcon 在服务器属性里，
                且保存后需重启实例生效（properties-panel 会提示需重启项） */}
            <Link
              to="/world?tab=properties"
              className="rounded-mcs-sm px-1.5 py-0.5 text-mcs-2xs font-medium text-mcs-warning-fg underline-offset-2 hover:underline"
            >
              前往服务器属性启用
            </Link>
          </span>
        </NoticeBanner>
      )}
    </div>
  )
}
