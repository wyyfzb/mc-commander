/**
 * mock 端点的**页面级**守卫：实时推送开关必须能经 MSW 真读到状态。
 *
 * 为什么单独立这条：设置弹窗自己的承重用例把 `@/api/world` 打桩了（那样才能精确控制各种状态），
 * 于是**mock 缺端点时没有任何用例会变红**——推送通道的 GET 就这么漏配过一次，症状一直到
 * 截图里「读不到推送通道状态：Not found」才被发现。这里刻意不打桩 API 层，让弹窗走真实的
 * `fetch → MSW` 路径：删掉 handlers 里的那条端点，本用例立刻转红（开关不再渲染，
 * 取而代之是那条读失败提示）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { handlers, mockInstanceStatus } from '../handlers'
import { InstanceSettingsDialog } from '@/features/instances/components/instance-settings-dialog'
import type { InstanceStatus, InstanceSummary } from '@/api/types'
import { useConnectionStore } from '@/stores/connection'

const server = setupServer(...handlers)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const instance: InstanceSummary = { id: 'i-1', name: '虚构甲服', isRunning: false, playerCount: 0 }
const detail: InstanceStatus = { ...mockInstanceStatus, id: 'i-1', name: '虚构甲服' }

describe('mock 端点覆盖：实时推送状态', () => {
  it('设置弹窗经 MSW 读到状态并渲染开关，而不是落到「读不到实时推送状态」', async () => {
    useConnectionStore.setState({ status: 'ready', baseUrl: 'http://mock.local', apiKey: 'k' })

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <InstanceSettingsDialog instance={instance} detail={detail} onOpenChange={() => {}} />
      </QueryClientProvider>,
    )

    // 夹具里通道是关的 ⇒ 开关在场且为关；状态读到之前不渲染开关（不给状态未知的开关乱点）
    expect(await screen.findByRole('switch', { name: '实时推送' })).not.toBeChecked()
    // 反面：读失败分支不该出现（它是这条守卫要防的状态）
    expect(screen.queryByText(/读不到实时推送状态/)).toBeNull()
  })
})
