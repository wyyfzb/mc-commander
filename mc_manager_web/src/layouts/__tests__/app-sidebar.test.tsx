/**
 * AppSidebar 实例迷你卡的「是否实时」标记（刷新时机这条结果说明的落点）：
 * - 推送连通说「实时」，未连通说「每 N 秒刷新」；实时通道断开或详情未到时两者都不写
 * - 完整解释走 title 与 sr-only，可见文本只留短语（该行是 2xs mono 元数据档）
 * - 该卡只在展开态渲染（桌面收起时整块不渲染；移动抽屉恒展开态）
 * 这里直接渲染 AppSidebar 而不是整壳：AppShell 会挂 useServerSocket，jsdom 里连不上
 * mock 的 WS 会把 socketConnected 翻回 false，通道门控那几条会跟着随机转红。
 * rail 与移动抽屉各渲染一份迷你卡 ⇒ 查询必须限定在其中一份之内，否则撞 strict 模式。
 * MSW 拦截实例列表与详情（结构占位虚构数据，严禁真实服务器信息）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppSidebar } from '../app-sidebar'
import { FALLBACK_POLL_INTERVAL_MS, queryKeys } from '@/api/queries'
import { mockInstanceStatus } from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledFrame: 'bypass' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

function instancesOk(data: unknown) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

const rail = () => screen.getByRole('complementary', { name: '主导航' })
const drawer = () => screen.getByRole('complementary', { name: '主导航（移动端）' })

function renderSidebar(props?: { collapsed?: boolean; mobileNavOpen?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        {/* NavLink 需要 Router 上下文：这里只给最小外壳，不引入 AppShell 的路由树 */}
        <MemoryRouter>
          <AppSidebar
            collapsed={props?.collapsed ?? false}
            mobileNavOpen={props?.mobileNavOpen ?? false}
            onMobileNavClose={() => {}}
          />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return qc
}

/** 列表里一个运行中实例；capabilities 传 'unknown' 时详情请求悬而不决（模拟详情未到） */
function readyWithMiniCard(
  capabilities: { rcon: boolean; msmp: boolean; msmpPush: boolean } | 'unknown',
) {
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  server.use(
    http.get('*/api/v1/instances', () =>
      instancesOk([{ id: 'demo-1', name: '演示实例', isRunning: true, playerCount: 3 }]),
    ),
    capabilities === 'unknown'
      ? http.get('*/api/v1/instances/:id', () => new Promise<Response>(() => {}))
      : http.get('*/api/v1/instances/:id', () =>
          instancesOk({ ...mockInstanceStatus, id: 'demo-1', capabilities }),
        ),
  )
  useServerStore.setState({ instanceId: 'demo-1', socketConnected: true })
}

describe('AppSidebar 实例迷你卡的刷新时机标记', () => {
  beforeEach(() => {
    localStorage.clear()
    // 逐例清零，避免上一例的选中的实例/通道态渗进下一例
    useServerStore.setState({ instanceId: null, socketConnected: false, hasConnectedOnce: false })
  })

  it('推送连通：状态行尾追加「实时」，完整解释走 title 与 sr-only', async () => {
    readyWithMiniCard({ rcon: true, msmp: true, msmpPush: true })
    renderSidebar()

    const line = await within(rail()).findByText('运行中 · 3 人在线 · 实时')
    // 句子不进可见文本（完整句会把这行 152px 内容宽撑到截断），但要真的可达：
    // title 供指针悬停；aria-label 在 role=generic 上按规范被忽略（本仓已踩过）⇒ 挂 sr-only
    expect(line).toHaveAttribute('title', '实时推送已连通，服务器的状态变化会立即到达面板')
    expect(line.querySelector('.sr-only')?.textContent).toBe(
      '，实时推送已连通，服务器的状态变化会立即到达面板',
    )
    // 字号沿用该行既有档位（2xs 只放可扫读的短标签），不得升成 12px 句子
    expect(line).toHaveClass('font-mono', 'text-mcs-2xs')
  })

  it('推送未连通：说「轮询」', async () => {
    readyWithMiniCard({ rcon: true, msmp: false, msmpPush: false })
    renderSidebar()

    // 可见文本只给「轮询」这个短语，秒数在完整解释里——常量与字面量同为 30 时
    // 「秒数取自常量而不是写死」不可被变异区分，故本条不自称锁它
    // 「两字标签不截断」是真实几何问题，jsdom 量不到（clientWidth 恒 0）⇒ 由 e2e 锁
    const line = await within(rail()).findByText('运行中 · 3 人在线 · 轮询')
    expect(line).toHaveAttribute(
      'title',
      `实时推送未连通，面板每 ${FALLBACK_POLL_INTERVAL_MS / 1000} 秒刷新一次状态`,
    )
  })

  it('实例详情未到 ⇒ 状态行不写刷新时机：宁可不说，也不说错', async () => {
    readyWithMiniCard('unknown')
    renderSidebar()

    // 精确匹配即门控判据：若按 `?? false` 落到轮询档，这行会多出「 · 轮询」而不匹配
    const line = await within(rail()).findByText('运行中 · 3 人在线')
    expect(line).not.toHaveAttribute('title')
    expect(line.querySelector('.sr-only')).toBeNull()
  })

  it('实时通道断开 ⇒ 不替轮询打包票（间隔已由降级横幅据实声明，两处会重复）', async () => {
    readyWithMiniCard({ rcon: true, msmp: true, msmpPush: true })
    useServerStore.setState({ socketConnected: false, hasConnectedOnce: true })
    const qc = renderSidebar()

    // 详情必须先真的到达，否则本条会在详情返回之前断言完——删掉通道门控也照样绿（假绿）。
    // 侧栏卡只展示列表字段，详情到达没有可见凭证 ⇒ 直接读该查询的状态当锚点
    await waitFor(() => {
      expect(qc.getQueryState(queryKeys.instance('demo-1'))?.status).toBe('success')
    })
    expect(within(rail()).getByText('运行中 · 3 人在线')).toBeInTheDocument()
    expect(within(rail()).queryByText(/实时$/)).toBeNull()
  })

  it('桌面侧栏收起：迷你卡整块不渲染（标记随之不出现）', async () => {
    readyWithMiniCard({ rcon: true, msmp: true, msmpPush: true })
    // 抽屉打开：关闭态的抽屉 aria-hidden，按角色查不到；打开后它才是可查的第二副本
    renderSidebar({ collapsed: true, mobileNavOpen: true })

    // 抽屉那副本体恒展开 ⇒ 它出现即证明详情已到
    expect(await within(drawer()).findByText('运行中 · 3 人在线 · 实时')).toBeInTheDocument()
    expect(within(rail()).queryByText(/人在线/)).toBeNull()
  })
})
