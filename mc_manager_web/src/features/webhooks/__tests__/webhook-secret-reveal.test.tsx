/**
 * Webhook 签名密钥的显隐切换
 * 遮蔽的三种渠道（通用/飞书/钉钉）此前只有 type="password"，粘贴的密钥无法自查；
 * 本用例钉住：遮蔽态必有显隐按钮且能切到明文、切换只作用于密钥框；
 * 明文渠道（企业微信/Server酱/PushPlus）保持无按钮的明文输入（type 分支语义不变）。
 * MSW 拦截列表与事件类型端点（结构占位虚构数据，严禁真实服务器信息）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Toaster } from 'sonner'
import { handlers } from '@/test/mocks/handlers'
import WebhookPage from '../webhook-page'
import { useConnectionStore } from '@/stores/connection'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WebhookPage />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  renderPage()
  const triggers = await screen.findAllByRole('button', { name: /新建 Webhook/ })
  await user.click(triggers[0]!)
  return screen.getByRole('radiogroup', { name: 'Webhook 渠道预设' })
}

/** 密钥输入框（label 的 htmlFor 指向它，遮蔽与明文两支共用同一 id；按标签全文定位，避开显隐按钮的 aria-label） */
const GENERIC_SECRET_LABEL = 'HMAC 密钥（留空不签名）'

function secretInput() {
  return screen.getByLabelText(GENERIC_SECRET_LABEL)
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  server.use(
    http.get('*/api/v1/webhooks', () => ok([])),
    http.get('*/api/v1/webhooks/event-types', () => ok([])),
  )
})

describe('Webhook 密钥显隐切换', () => {
  it('遮蔽渠道（通用）：密钥框默认遮蔽且有显隐按钮，切换后变明文且只动自己', async () => {
    const user = userEvent.setup()
    await openCreateDialog(user)

    const secret = secretInput()
    expect(secret).toHaveAttribute('type', 'password')

    const reveal = screen.getByRole('button', { name: '显示密钥' })
    await user.click(reveal)

    expect(secretInput()).toHaveAttribute('type', 'text')
    // 切换后的按钮语义翻转（仅密钥框这一枚）
    expect(screen.getByRole('button', { name: '隐藏密钥' })).toBeInTheDocument()
    // 无 CapsLock 提醒（密钥是粘贴而非键入，该提醒在此不适用）
    expect(screen.queryByText('大写锁定已开启')).not.toBeInTheDocument()
  })

  it('切到明文渠道（企业微信）：无显隐按钮，密钥框保持明文并可写', async () => {
    const user = userEvent.setup()
    const group = await openCreateDialog(user)
    await user.click(within(group).getByRole('radio', { name: '企业微信' }))

    const secret = screen.getByLabelText('企业微信机器人无需密钥')
    expect(secret).toHaveAttribute('type', 'text')
    expect(secret).toBeDisabled()
    expect(screen.queryByRole('button', { name: /显示密钥|隐藏密钥/ })).not.toBeInTheDocument()
  })

  it('切到需填 token 的明文渠道（PushPlus）：明文且无显隐按钮', async () => {
    const user = userEvent.setup()
    const group = await openCreateDialog(user)
    await user.click(within(group).getByRole('radio', { name: 'PushPlus' }))

    const secret = screen.getByLabelText(/PushPlus token/)
    expect(secret).toHaveAttribute('type', 'text')
    expect(secret).toBeEnabled()
    expect(screen.queryByRole('button', { name: /显示密钥|隐藏密钥/ })).not.toBeInTheDocument()
  })
})
