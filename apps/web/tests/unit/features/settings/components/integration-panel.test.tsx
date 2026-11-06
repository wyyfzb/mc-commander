/**
 * IntegrationPanel 测试（「推送与记录」子页 = 两个独立页面的入口卡）：
 * - 两张卡：推送通知到外部 → /webhooks；谁做了什么 → /audit
 * - 卡内是**跳转**不是内嵌：webhooks / audit 各自是完整页面（自带 PageHeader），
 *   嵌进设置子路由会出现两个页头 + 三层滚动
 * - 每张卡都交代「这是独立页面，点开会离开设置」，避免用户以为跳走是出错
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { IntegrationPanel } from '@/features/settings/components/integration-panel'

function renderPanel() {
  // Link 需要路由上下文
  const router = createMemoryRouter([{ path: '/', element: <IntegrationPanel /> }], {
    initialEntries: ['/'],
  })
  render(<RouterProvider router={router} />)
}

describe('IntegrationPanel 两张入口卡', () => {
  it('两个区块标题都在', () => {
    renderPanel()
    expect(screen.getByRole('heading', { name: '推送通知到外部' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '谁做了什么' })).toBeInTheDocument()
  })

  it('说明行讲清各是什么、需要什么', () => {
    renderPanel()
    expect(screen.getByText(/QQ 群 \/ Discord \/ 企业微信/)).toBeInTheDocument()
    expect(screen.getByText(/需要对方提供一个 Webhook 地址/)).toBeInTheDocument()
    expect(screen.getByText(/管理员操作记录与命令执行历史/)).toBeInTheDocument()
  })

  it('按钮文案写点下去的后果，不是「进入」这类流程词', () => {
    renderPanel()
    expect(screen.getByRole('link', { name: '去配置推送' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看操作记录' })).toBeInTheDocument()
  })
})

describe('IntegrationPanel 跳转目标', () => {
  it('推送卡跳 /webhooks，记录卡跳 /audit（顶层路由，不是设置子路由）', () => {
    renderPanel()
    expect(screen.getByRole('link', { name: '去配置推送' })).toHaveAttribute('href', '/webhooks')
    expect(screen.getByRole('link', { name: '查看操作记录' })).toHaveAttribute('href', '/audit')
  })

  /* 反向锚点：webhooks / audit 是完整页面，自带 PageHeader 与自己的数据查询。
     把它们内嵌（iframe 或直接渲染）会同时出现两个页头，且设置页自己已有独立滚动
     容器 ⇒ 三层滚动。这里钉住「只有入口，没有内嵌内容」 */
  it('不内嵌两个页面的内容（只有入口卡）', () => {
    renderPanel()
    expect(document.querySelector('iframe')).toBeNull()
    // 两个页面各自的页面级标题不该出现在这里
    expect(screen.queryByRole('heading', { name: 'Webhook 通知' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '审计日志' })).not.toBeInTheDocument()
  })

  it('每张卡都说明「这是独立页面，点开会离开设置」', () => {
    renderPanel()
    expect(screen.getAllByText('这是独立页面，点开会离开设置')).toHaveLength(2)
  })
})
