/**
 * DegradationBanners 测试（降级横幅）：
 * - WS 断开（hasConnectedOnce + 未连接）→ error 横幅 + 重连按钮 + 真实轮询间隔
 * - RCON 未连接（运行中实例）→ warning 横幅 + 服务器属性深链（enable-rcon 所在处）
 * - 正常状态 → 不渲染
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
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
    // 文案里的间隔必须与 api/queries.ts 的 refetchInterval 一致（曾写成 5s）
    expect(screen.getByText(/每 30 秒/)).toBeInTheDocument()
    expect(screen.queryByText(/每 5s/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重连/ })).toBeInTheDocument()
  })

  it('RCON 未连接（运行中）：warning 横幅 + 服务器属性深链', () => {
    useServerStore.setState({
      status: { isRunning: true, isRconConnected: false } as never,
    })
    renderBanners()
    expect(screen.getByText(/RCON 未连接/)).toBeInTheDocument()
    // 出口要落在能修的地方（/world 默认是世界信息页，改不了 enable-rcon）
    expect(screen.getByRole('link', { name: '前往服务器属性启用' })).toHaveAttribute(
      'href',
      '/world?tab=properties',
    )
  })

  it('连接未配置：不渲染（onboarding 场景）', () => {
    useConnectionStore.setState({ status: 'unconfigured' })
    useServerStore.setState({ socketConnected: false, hasConnectedOnce: true })
    renderBanners()
    expect(screen.queryByText(/WebSocket 已断开/)).not.toBeInTheDocument()
  })
})
