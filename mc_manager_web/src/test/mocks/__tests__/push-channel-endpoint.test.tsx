/**
 * mock 端点的**页面级**守卫：推送通道卡片必须能经 MSW 真读到状态。
 *
 * 为什么单独立这条：卡片自己的承重用例把 `@/api/world` 打桩了（那样才能精确控制各种状态），
 * 于是**mock 缺端点时没有任何用例会变红**——推送通道的 GET 就这么漏配过一次，症状一直到
 * 截图里「读不到推送通道状态：Not found」才被发现。这里刻意不打桩 API 层，让卡片走真实的
 * `fetch → MSW` 路径：删掉 handlers 里的那条端点，本用例立刻转红。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { handlers } from '../handlers'
import { PushChannelCard } from '@/features/world/components/push-channel-card'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('mock 端点覆盖：推送通道状态', () => {
  it('卡片经 MSW 读到状态并渲染，而不是落到「读不到推送通道状态」', async () => {
    useConnectionStore.setState({ status: 'ready', baseUrl: 'http://mock.local', apiKey: 'k' })
    useServerStore.setState({ status: null })

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <PushChannelCard instanceId="i-1" isRunning={false} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('未开启')).toBeInTheDocument())
    // 反面：错误分支不该出现（它是这条守卫要防的状态）
    expect(screen.queryByText(/读不到推送通道状态/)).toBeNull()
  })
})
