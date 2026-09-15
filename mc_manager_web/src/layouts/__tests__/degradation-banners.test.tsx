/**
 * DegradationBanners 测试（降级横幅）：
 * - WS 断开（hasConnectedOnce + 未连接）→ error 横幅 + 重连按钮 + 轮询间隔（取 queries 常量）
 * - WS 断开且服务端有部署在途 → 补写「进度由服务端刷新、勿重新发起部署」（J29 断线提示）
 * - RCON 未连接（运行中实例）→ warning 横幅 + 写明服务器侧动作；不得给界面做不到的出口
 *   （enable-rcon 属安全敏感项，properties-panel 恒渲染只读占位符）
 * - 正常状态 → 不渲染
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useDeployStore } from '@/stores/deploy'
import { FALLBACK_POLL_INTERVAL_MS } from '@/api/queries'
import * as instancesApi from '@/api/instances'
import { DegradationBanners } from '../degradation-banners'
import type { DeployStatusResponse } from '@/api/types'

/** 兜底查询替身（默认空态；用例覆写为在途快照） */
let deployStatusImpl: () => Promise<DeployStatusResponse>

function renderBanners() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DegradationBanners />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('DegradationBanners', () => {
  beforeEach(() => {
    deployStatusImpl = () => Promise.resolve({ deploying: false })
    vi.spyOn(instancesApi, 'apiGetDeployStatus').mockImplementation(() => deployStatusImpl())
    useServerStore.setState({
      socketConnected: true,
      hasConnectedOnce: true,
      status: { isRunning: true, isRconConnected: true } as never,
    })
    useConnectionStore.setState({ status: 'ready' })
    useDeployStore.setState({ progress: null, deploying: false, lastResult: null, recentActiveDeploy: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('WS 断开 + 服务端有部署在途：提示进度刷新方式且明确不得重新发起部署（J29）', async () => {
    deployStatusImpl = () =>
      Promise.resolve({
        deploying: true,
        instanceId: 'paper-a1b2c3d4',
        instanceName: '生存服',
        type: 'paper',
        mcVersion: '1.21.4',
        stage: 'download',
        percent: 0.45,
        transferred: 52_428_800,
        total: 104_857_600,
        updatedAt: Date.now(),
      })
    useServerStore.setState({ socketConnected: false, hasConnectedOnce: true })
    renderBanners()

    // 可兑现文案：说清进度的获取方式，并给出「不要重复发起」的明确动作
    expect(
      await screen.findByText(
        new RegExp(`服务端仍有部署在进行，进度每 ${FALLBACK_POLL_INTERVAL_MS / 1000} 秒从服务端刷新`),
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/请勿重新发起部署（会重复创建实例）/)).toBeInTheDocument()
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
