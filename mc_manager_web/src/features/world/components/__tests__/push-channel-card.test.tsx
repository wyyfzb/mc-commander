/**
 * 推送通道开关卡片。
 *
 * 承重点：这个开关的价值全在**替用户写对三项**，而用户看到的只有这一屏——所以界面必须
 * 把三件事说清，缺一件他就会去手改文件踩坑：
 * ① 开没开；② 绑在哪（非本机＝暴露面变大）；③ 运行中改动要重启才生效。
 * 另外「不要手改 server.properties」这句提示本身是承重的：用户手改正是本功能要防的事。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PushChannelCard } from '../push-channel-card'
import type { PushChannelState } from '@/api/types'
import { useConnectionStore } from '@/stores/connection'

const { apiGetPushChannel, apiSetPushChannel } = vi.hoisted(() => ({
  apiGetPushChannel: vi.fn(),
  apiSetPushChannel: vi.fn(),
}))

vi.mock('@/api/world', async (importOriginal) => ({
  // 显式标注 importOriginal 的类型：不标注时返回 unknown，展开会报 TS2698
  ...(await importOriginal<typeof import('@/api/world')>()),
  apiGetPushChannel,
  apiSetPushChannel,
}))

const STATE_OFF: PushChannelState = {
  enabled: false,
  tlsEnabled: true,
  host: 'localhost',
  port: 0,
  secretConfigured: false,
}

function renderCard(state: PushChannelState | Error, { isRunning = false } = {}) {
  if (state instanceof Error) apiGetPushChannel.mockRejectedValueOnce(state)
  else apiGetPushChannel.mockResolvedValue(state)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PushChannelCard instanceId="inst-1" isRunning={isRunning} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // usePushChannel 以「连接就绪」为 enabled 条件（未配置面板时不该发请求），
  // 测试里必须先把 store 置成 ready，否则查询根本不跑、断言只会在超时里打转
  useConnectionStore.setState({
    baseUrl: 'https://panel.test',
    apiKey: 'test-key',
    status: 'ready',
  })
})

describe('PushChannelCard', () => {
  it('未开启时显示未开启、并交代不要手改 server.properties', async () => {
    renderCard(STATE_OFF)
    expect(await screen.findByText('未开启')).toBeInTheDocument()
    // 这句是护栏的一半：用户手改正是本功能要防的事
    expect(screen.getByText(/不要手改 server.properties/)).toBeInTheDocument()
  })

  it('端口为 0 时显示「随机端口」而不是 0（0 会被读成「没端口」）', async () => {
    renderCard(STATE_OFF)
    expect(await screen.findByText(/localhost:随机端口/)).toBeInTheDocument()
  })

  it('开启后显示状态与端口，并把调用发成 { enabled: true }', async () => {
    renderCard(STATE_OFF)
    await screen.findByText('未开启')
    apiSetPushChannel.mockResolvedValueOnce({
      enabled: true,
      restartRequired: false,
      secretGenerated: true,
    })

    await userEvent.click(screen.getByRole('switch', { name: '开启实时推送' }))

    await waitFor(() =>
      expect(apiSetPushChannel).toHaveBeenCalledWith(expect.anything(), 'inst-1', true),
    )
    expect(await screen.findByText(/已开启，下次启动服务器时生效/)).toBeInTheDocument()
  })

  it('运行中改动：必须提示要重启才生效（MSMP 只在启动时读）', async () => {
    renderCard(STATE_OFF, { isRunning: true })
    await screen.findByText('未开启')
    apiSetPushChannel.mockResolvedValueOnce({
      enabled: true,
      restartRequired: true,
      secretGenerated: true,
    })

    await userEvent.click(screen.getByRole('switch', { name: '开启实时推送' }))

    expect(await screen.findByText(/重启服务器/)).toBeInTheDocument()
    // 两条提示互斥：不写这条时，去掉 isRunning 判断会让两条同时渲染而断言照样通过
    expect(screen.queryByText(/下次启动服务器时生效/)).not.toBeInTheDocument()
  })

  it('绑定非本机且已开启 → 提示暴露面（本机绑定则不提示，避免常年挂一条不生效的告警）', async () => {
    renderCard({ ...STATE_OFF, enabled: true, host: '0.0.0.0', port: 25585 })
    expect(await screen.findByText(/管理协议已对网络开放/)).toBeInTheDocument()
  })

  it('未开启时即便 host 不是本机也不提示暴露面（没在监听，告警只会是噪音）', async () => {
    renderCard({ ...STATE_OFF, enabled: false, host: '0.0.0.0' })
    await screen.findByText('未开启')
    expect(screen.queryByText(/管理协议已对网络开放/)).not.toBeInTheDocument()
  })

  it('绑定 localhost 时不提示暴露面', async () => {
    renderCard({ ...STATE_OFF, enabled: true })
    await screen.findByText('已开启')
    expect(screen.queryByText(/管理协议已对网络开放/)).not.toBeInTheDocument()
  })

  it.each([['127.0.0.1'], ['::1'], ['LOCALHOST'], ['127.0.0.1 ']])(
    '本机形态 %s 都算 loopback，不误报暴露面',
    async (host) => {
      renderCard({ ...STATE_OFF, enabled: true, host })
      await screen.findByText('已开启')
      expect(screen.queryByText(/管理协议已对网络开放/)).not.toBeInTheDocument()
    },
  )

  it('读状态失败 → 提示读不到，且不渲染开关（不给一个状态未知的开关乱点）', async () => {
    renderCard(new Error('boom'))
    expect(await screen.findByText(/读不到推送通道状态/)).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('设置失败 → 报错且不改动本地显示（仍显示未开启）', async () => {
    renderCard(STATE_OFF)
    await screen.findByText('未开启')
    apiSetPushChannel.mockRejectedValueOnce(new Error('serverside-nope'))

    await userEvent.click(screen.getByRole('switch', { name: '开启实时推送' }))

    expect(await screen.findByText(/设置失败/)).toBeInTheDocument()
    expect(screen.getByText('未开启')).toBeInTheDocument()
  })
})
