/**
 * LoginPage 密码显隐回归测试：
 * 设密模式三个凭据输入曾经只有「确认密码」是裸 input——两次输入里最容易打错、
 * 也最需要对照的那一格反而只能盲打。本用例把「两个密码框各有一个显隐切换」
 * 钉住，并验证切换只作用于自己那一格。
 * 单独成文件同 先例（login-page.test.tsx 的修改会被工具链误拦）。
 * mock 数据为虚构内容，严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { handlers } from '@/test/mocks/handlers'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { LoginPage } from '../login-page'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().clearSession()
  useConnectionStore.getState().setStatus('unconfigured')
})

function okEnvelope(data: unknown) {
  return HttpResponse.json({ status: 'ok', code: 0, message: 'Success', data, timestamp: '' })
}

function renderLoginPage() {
  const router = createMemoryRouter(
    [
      { path: '/login', Component: LoginPage },
      { path: '/dashboard', Component: () => <div>dashboard-reached</div> },
    ],
    { initialEntries: ['/login'] },
  )
  return render(<RouterProvider router={router} />)
}

/** 取某个密码框自己的显隐按钮（按结构定位，不依赖两个框的先后顺序） */
function revealToggleFor(input: HTMLElement): HTMLElement {
  const box = input.closest('.relative')
  if (!(box instanceof HTMLElement)) throw new Error('密码框未找到显隐按钮容器')
  return within(box).getByRole('button')
}

describe('LoginPage 设密模式密码显隐', () => {
  beforeEach(() => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
  })

  it('管理员密码与确认密码各有一个显隐切换，切换只影响自己那一格', async () => {
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('确认密码')).toBeInTheDocument())

    const password = screen.getByLabelText('管理员密码')
    const confirm = screen.getByLabelText('确认密码')
    expect(password).toHaveAttribute('type', 'password')
    expect(confirm).toHaveAttribute('type', 'password')

    // 两个密码框各有一枚显隐按钮（数量即「两格都能显隐」这条断言本身）
    expect(screen.getAllByRole('button', { name: '显示密码' })).toHaveLength(2)

    await userEvent.click(revealToggleFor(confirm))
    expect(screen.getByLabelText('确认密码')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('管理员密码')).toHaveAttribute('type', 'password')
    // 切换后的按钮语义翻转为「隐藏密码」（仅确认密码那一格）
    expect(screen.getAllByRole('button', { name: '隐藏密码' })).toHaveLength(1)
  })

  it('登录模式（非设密）不渲染确认密码，不存在第二个显隐切换', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: true })))
    renderLoginPage()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: '管理员登录' })).toBeInTheDocument(),
    )

    expect(screen.queryByLabelText('确认密码')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '显示密码' })).toHaveLength(1)
  })
})
