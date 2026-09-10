/**
 * DegradationBanners 测试（降级横幅）：
 * - WS 断开（hasConnectedOnce + 未连接）→ error 横幅 + 重连按钮 + 轮询间隔（取 queries 常量）
 * - RCON 未连接（运行中实例）→ warning 横幅 + 写明服务器侧动作；不得给界面做不到的出口
 *   （enable-rcon 属安全敏感项，properties-panel 恒渲染只读占位符）
 * - 正常状态 → 不渲染
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { FALLBACK_POLL_INTERVAL_MS } from '@/api/queries'
import { DegradationBanners } from '../degradation-banners'

function renderBanners() {
  return render(
    <MemoryRouter>
      <DegradationBanners />
    </MemoryRouter>,
  )
}

describe('DegradationBanners', () => {
  beforeEach(() => {
    useServerStore.setState({
      socketConnected: true,
      hasConnectedOnce: true,
      status: { isRunning: true, isRconConnected: true } as never,
    })
    useConnectionStore.setState({ status: 'ready' })
  })

  it('正常状态（WS 连接 + RCON 连接）：不渲染任何横幅', () => {
    renderBanners()
    expect(screen.queryByText(/WebSocket 已断开/)).not.toBeInTheDocument()
    expect(screen.queryByText(/RCON 未连接/)).not.toBeInTheDocument()
  })

  it('WS 断开（曾连接过）：error 横幅 + 重连按钮 + 真实轮询间隔', () => {
    useServerStore.setState({ socketConnected: false, hasConnectedOnce: true })
    renderBanners()
    expect(screen.getByText(/WebSocket 已断开/)).toBeInTheDocument()
    // 文案里的间隔由 FALLBACK_POLL_INTERVAL_MS 拼接（曾各自写死，横幅长期谎报 5s）
    expect(
      screen.getByText(new RegExp(`每 ${FALLBACK_POLL_INTERVAL_MS / 1000} 秒`)),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重连/ })).toBeInTheDocument()
  })

  it('RCON 未连接（运行中）：warning 横幅写明服务器侧动作，不给做不到的出口', () => {
    useServerStore.setState({
      status: { isRunning: true, isRconConnected: false } as never,
    })
    renderBanners()
    expect(screen.getByText(/RCON 未连接/)).toBeInTheDocument()
    // 可兑现的说明：改哪个键、在哪改、怎么生效
    expect(screen.getByText(/enable-rcon 设为 true/)).toBeInTheDocument()
    expect(screen.getByText(/重启实例/)).toBeInTheDocument()
    // enable-rcon 在属性页是只读占位符（敏感键），故不得再挂「前往启用」类链接
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('连接未配置：不渲染（onboarding 场景）', () => {
    useConnectionStore.setState({ status: 'unconfigured' })
    useServerStore.setState({ socketConnected: false, hasConnectedOnce: true })
    renderBanners()
    expect(screen.queryByText(/WebSocket 已断开/)).not.toBeInTheDocument()
  })
})
