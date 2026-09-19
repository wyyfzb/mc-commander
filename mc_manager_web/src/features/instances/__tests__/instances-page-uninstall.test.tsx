/**
 * InstancesPage 卸载流程：实例名确认由服务端强制，实例无备份时服务端回 409，
 * UI 必须就地转入「不可恢复」二次确认并带 acknowledgeIrreversible 重发，
 * 最终提示报出保留的备份份数（卸载不再销毁备份）。
 * MSW 拦截：DELETE 响应由 uninstallMock 控制；数据为结构占位虚构内容。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers, uninstallMock } from '@/test/mocks/handlers'
import { InstancesPage } from '../instances-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
// server.use 的覆盖是追加式且跨用例存活的：用例自己挂的场景必须在用例后复位
afterEach(() => server.resetHandlers())

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/instances',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <InstancesPage />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/instances'] },
  )
  return render(<RouterProvider router={router} />)
}

/** 打开卸载弹窗并输入实例名（走真实卡片操作菜单） */
async function openUninstallDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '演示实例 操作菜单' }))
  await user.click(await screen.findByRole('menuitem', { name: '卸载实例' }))
  await user.type(screen.getByLabelText(/输入实例名/), '演示实例')
}

beforeEach(() => {
  localStorage.clear()
  uninstallMock.calls = 0
  uninstallMock.retainedBackupCount = 0
  uninstallMock.bodies = []
  uninstallMock.expectedName = null
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
})

describe('InstancesPage · 卸载确认', () => {
  it('有备份：单阶段确认即可（不带 acknowledgeIrreversible），提示保留份数', async () => {
    uninstallMock.retainedBackupCount = 3
    const user = userEvent.setup()
    renderPage()
    await openUninstallDialog(user)

    await user.click(screen.getByRole('button', { name: '确认卸载' }))

    expect(await screen.findByText('实例 "演示实例" 已卸载，已保留 3 份备份')).toBeInTheDocument()
    expect(uninstallMock.calls).toBe(1)
    expect(uninstallMock.bodies[0]).toEqual({ confirmName: '演示实例' })
  })

  it('零备份 409：转入不可恢复二次确认，重发时带 acknowledgeIrreversible', async () => {
    const user = userEvent.setup()
    renderPage()
    await openUninstallDialog(user)

    await user.click(screen.getByRole('button', { name: '确认卸载' }))

    // 服务端前置清单校验拒绝：弹窗不关闭，就地给出不可恢复警告与更强的确认动作
    expect(
      await screen.findByText(/该实例没有任何备份：删除后世界数据与配置不可恢复/),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText(/输入实例名/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '确认不可恢复删除' }))

    expect(await screen.findByText('实例 "演示实例" 已卸载，该实例没有备份')).toBeInTheDocument()
    expect(uninstallMock.calls).toBe(2)
    // 首次不声明（让服务端的前置清单校验生效），二次确认才声明不可恢复
    expect(uninstallMock.bodies[0]).toEqual({ confirmName: '演示实例' })
    expect(uninstallMock.bodies[1]).toEqual({
      confirmName: '演示实例',
      acknowledgeIrreversible: true,
    })
  })

  it('空名实例 40916：转入不可恢复二次确认，提示据实说「无名称」而非「无备份」', async () => {
    // 空名实例：列表名称为空 → 卡片展示名回退 id（instanceLabel），菜单与确认框都用原值比对
    server.use(
      http.get('*/api/v1/instances', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: [{ id: 'demo', name: '', isRunning: true, playerCount: 0 }],
          timestamp: new Date().toISOString(),
        }),
      ),
    )
    uninstallMock.expectedName = ''
    uninstallMock.retainedBackupCount = 3
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'demo 操作菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '卸载实例' }))
    // 空名实例：输入框留空即匹配（空串天然匹配），故不输入直接确认
    await user.click(screen.getByRole('button', { name: '确认卸载' }))

    expect(await screen.findByText(/该实例没有名称，实例名确认不构成有效确认/)).toBeInTheDocument()
    // 反向断言：不得套用「没有任何备份」的文案（本实例有 3 份备份）
    expect(screen.queryByText(/该实例没有任何备份/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '确认不可恢复删除' }))
    expect(uninstallMock.bodies[1]).toEqual({ confirmName: '', acknowledgeIrreversible: true })
  })

  it('实例名与输入不符：确认按钮禁用（服务端同名校验的 UI 前置态）', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: '演示实例 操作菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '卸载实例' }))

    expect(screen.getByRole('button', { name: '确认卸载' })).toBeDisabled()
    await user.type(screen.getByLabelText(/输入实例名/), '别的名字')
    expect(screen.getByRole('button', { name: '确认卸载' })).toBeDisabled()
    expect(uninstallMock.calls).toBe(0)
  })

  // 升级前库里可能存着带首尾空白的实例名：前端两侧都 trim 才可能确认得上
  describe('库中实例名带首尾空白（升级前旧值）', () => {
    const SPACED_NAME = '演示实例 '

    beforeEach(() => {
      uninstallMock.retainedBackupCount = 2
      server.use(
        http.get('*/api/v1/instances', () =>
          HttpResponse.json({
            status: 'ok',
            code: 0,
            message: 'Success',
            data: [{ id: 'demo', name: SPACED_NAME, isRunning: true, playerCount: 0 }],
            timestamp: new Date().toISOString(),
          }),
        ),
      )
    })

    it('输入界面所见的名字（无尾空格）即可确认，请求体带用户输入原值', async () => {
      const user = userEvent.setup()
      renderPage()
      await openUninstallDialog(user)

      const confirmButton = screen.getByRole('button', { name: '确认卸载' })
      expect(confirmButton).toBeEnabled()
      await user.click(confirmButton)

      // 展示名走 instanceLabel：toast 印 trim 后的名字（尾空格不该跑到引号里），
      // 而确认比对与上报仍是原值——显示口径与确认口径各司其职
      expect(await screen.findByText('实例 "演示实例" 已卸载，已保留 2 份备份')).toBeInTheDocument()
      expect(uninstallMock.bodies[0]).toEqual({ confirmName: '演示实例' })
    })

    it('输入带尾空格的原样名字同样可确认，confirmName 原样上报（trim 由服务端裁决）', async () => {
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('button', { name: /演示实例\s+操作菜单/ }))
      await user.click(await screen.findByRole('menuitem', { name: '卸载实例' }))
      await user.type(screen.getByLabelText(/输入实例名/), SPACED_NAME)

      await user.click(screen.getByRole('button', { name: '确认卸载' }))

      expect(await screen.findByText('实例 "演示实例" 已卸载，已保留 2 份备份')).toBeInTheDocument()
      expect(uninstallMock.bodies[0]).toEqual({ confirmName: SPACED_NAME })
    })
  })

  // 升级前库里还可能存着空名旧行：弹窗必须能走完，不得出现「必须输入但输入什么都不对」的死状态
  describe('库中实例名为空串（升级前旧值）', () => {
    beforeEach(() => {
      uninstallMock.retainedBackupCount = 2
      uninstallMock.expectedName = ''
      server.use(
        http.get('*/api/v1/instances', () =>
          HttpResponse.json({
            status: 'ok',
            code: 0,
            message: 'Success',
            data: [{ id: 'demo', name: '', isRunning: true, playerCount: 0 }],
            timestamp: new Date().toISOString(),
          }),
        ),
      )
    })

    it('空输入即匹配但要声明不可恢复：首次 40916 → 二次确认带 acknowledgeIrreversible 才卸载', async () => {
      const user = userEvent.setup()
      renderPage()
      // 操作按钮的可访问名同样回退到 id：空名旧行此前给出的是「无名按钮」（名字只剩「操作菜单」）
      await user.click(await screen.findByRole('button', { name: 'demo 操作菜单' }))
      await user.click(await screen.findByRole('menuitem', { name: '卸载实例' }))
      // 确认块刻意用原值（服务端比的是 trim 后的 name），故这里标签仍是空名
      expect(screen.getByLabelText(/输入实例名/)).toHaveAttribute('placeholder', '')

      const confirmButton = screen.getByRole('button', { name: '确认卸载' })
      expect(confirmButton).toBeEnabled()
      await user.click(confirmButton)

      // 空名让「输入实例名」这道闸门空转（空串天然匹配），服务端额外要求显式声明不可恢复
      expect(
        await screen.findByText(/该实例没有名称，实例名确认不构成有效确认/),
      ).toBeInTheDocument()
      expect(uninstallMock.bodies[0]).toEqual({ confirmName: '' })

      await user.click(screen.getByRole('button', { name: '确认不可恢复删除' }))

      // 提示回退到 id：印 `实例 "" 已卸载` 时用户无法确认卸掉的是哪一个
      expect(await screen.findByText('实例 "demo" 已卸载，已保留 2 份备份')).toBeInTheDocument()
      expect(uninstallMock.bodies[1]).toEqual({ confirmName: '', acknowledgeIrreversible: true })
    })

    it('输入任意非空名字 → 确认按钮禁用（UI 侧拦截，服务端同判为 400）', async () => {
      const user = userEvent.setup()
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'demo 操作菜单' }))
      await user.click(await screen.findByRole('menuitem', { name: '卸载实例' }))

      await user.type(screen.getByLabelText(/输入实例名/), '随便什么')

      expect(screen.getByRole('button', { name: '确认卸载' })).toBeDisabled()
      expect(uninstallMock.calls).toBe(0)
    })
  })
})
