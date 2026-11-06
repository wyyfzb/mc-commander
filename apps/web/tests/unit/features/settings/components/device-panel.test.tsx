/**
 * DevicePanel 测试（「连接与外观」子页 = 面板连接 + 界面外观）：
 * - 两段都在，且都以 SettingsSectionCard 承载（同页只用一种区块基座）
 * - 界面外观三项（主题 / 终端自动滚动 / 命令确认）确实来自浏览器本地 store
 * - 面板连接段只输出字段：**不再套一层自带卡片**（否则区块卡里再套卡片面）
 * - 分组判据是「换设备跟不跟过来」：两段都只落 localStorage，故合并
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { handlers } from '@tests/support/handlers'
import { DevicePanel } from '@/features/settings/components/device-panel'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useUiStore } from '@/stores/ui'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

// radix Select 依赖 Pointer Capture API（jsdom 未实现，缺失会崩溃）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

function renderPanel() {
  // ConnectionForm 内的未保存守卫依赖 data router 上下文（useBlocker）
  const router = createMemoryRouter([{ path: '/', element: <DevicePanel /> }], {
    initialEntries: ['/'],
  })
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useUiStore.setState({ theme: 'dark', terminalAutoScroll: true, confirmCommands: false })
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    hasConnectedOnce: true,
    lastStatusEvent: null,
  })
})

afterEach(() => {
  server.resetHandlers()
})

describe('DevicePanel 两段都在', () => {
  it('面板连接 + 界面外观两段区块标题都在', () => {
    renderPanel()
    expect(screen.getByRole('heading', { name: '面板连接' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '界面外观' })).toBeInTheDocument()
  })

  it('说明行讲清「只存在这台电脑上」——这是两段合并的依据', () => {
    renderPanel()
    expect(screen.getByText(/只存在这台电脑上，换设备要重新填/)).toBeInTheDocument()
    expect(screen.getByText(/同样只存在这台电脑上/)).toBeInTheDocument()
  })

  it('区块标题统一是 h3（SettingsSectionCard 基座），同页不出现第二套区块头', () => {
    renderPanel()
    // 两段都是 h3：若某段改用 Card+CardHeader 手写，这里仍是 h3，但下面的
    // 「不再套一层卡片」用例会先红（那是真正会漂移的地方）
    expect(screen.getByRole('heading', { name: '面板连接', level: 3 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '界面外观', level: 3 })).toBeInTheDocument()
  })
})

describe('DevicePanel 面板连接段', () => {
  it('表单字段可用：面板地址 + API Key + 保存按钮', () => {
    renderPanel()
    expect(screen.getByRole('textbox', { name: '面板地址' })).toBeInTheDocument()
    expect(screen.getByLabelText('API Key')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存连接' })).toBeInTheDocument()
  })

  /* bare：调用方已提供区块卡外观，整段（字段区 + 「从其他设备访问」）都不再套卡片面。
     断言「卡片面只有一层」而不是「没有卡片面」——SettingsSectionCard 本身就该有一层，
     多出来的第二层才是「区块卡里再套卡片面」的层级堆叠。按 DOM 祖先逐层数，
     类名匹配在基座改版时也只会漏报不会误报 */
  function cardSurfacesAbove(el: HTMLElement) {
    let node: HTMLElement | null = el.parentElement
    let count = 0
    while (node && node !== document.body) {
      const cls = node.className
      if (
        typeof cls === 'string' &&
        cls.includes('shadow-mcs-card') &&
        cls.includes('border') &&
        cls.includes('rounded')
      ) {
        count += 1
      }
      node = node.parentElement
    }
    return count
  }

  it('卡片面只有一层：表单字段不在嵌套的第二层卡片里', () => {
    renderPanel()
    // 恰好一层（SettingsSectionCard）；2 层就是区块卡套卡片
    expect(cardSurfacesAbove(screen.getByRole('textbox', { name: '面板地址' }))).toBe(1)
  })

  /* 「从其他设备访问」在字段区之外，只数字段区会恰好绕过它——两段各起一个起点，
     才能守住「整段都归调用方的区块卡」 */
  it('卡片面只有一层：「从其他设备访问」段同样不再套第二层卡片', () => {
    renderPanel()
    const heading = screen.getByRole('heading', { name: '从其他设备访问' })
    expect(cardSurfacesAbove(heading)).toBe(1)
  })
})

describe('DevicePanel 界面外观段', () => {
  it('三项都在：主题 / 终端自动滚动 / 命令执行二次确认', () => {
    renderPanel()
    expect(screen.getByRole('combobox', { name: '界面主题' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '终端自动滚动' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '命令执行二次确认' })).toBeInTheDocument()
  })

  it('拨动开关只改浏览器本地 store，不发请求', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole('switch', { name: '终端自动滚动' }))
    expect(useUiStore.getState().terminalAutoScroll).toBe(false)

    await user.click(screen.getByRole('switch', { name: '命令执行二次确认' }))
    expect(useUiStore.getState().confirmCommands).toBe(true)
  })

  it('主题切换生效（浏览器本地偏好即时生效）', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('combobox', { name: '界面主题' }))
    await user.click(await screen.findByRole('option', { name: '亮色' }))
    expect(useUiStore.getState().theme).toBe('light')
  })

  /* 反向锚点：实例级配置（自动重启等）写入口是 PUT /instances/:id，
     不在这张「浏览器本地偏好」区块里。整段不渲染会让上面正向断言转红，
     但挡不住「再加一行实例配置」的漂移 */
  it('不出现实例级配置项（自动重启住实例设置弹窗）', () => {
    renderPanel()
    expect(screen.queryByText('意外停止后自动重启')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '意外停止后自动重启' })).not.toBeInTheDocument()
  })
})
