/**
 * Webhook 渠道预设的单选组语义（J54）
 * 该处此前已是 role=radiogroup + role=radio + aria-checked，却没有 roving tabindex 与
 * 方向键——读屏宣告了「单选组」，键盘操作却不符合模型（三个按钮各占一个 Tab 停靠点、
 * 方向键无响应）。本用例锁定补齐后的完整 APG 模型。
 * MSW 拦截列表与事件类型端点（结构占位虚构数据，严禁真实服务器信息）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
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

/** 打开「新建 Webhook」对话框并返回渠道预设单选组 */
async function openPresetGroup(user: ReturnType<typeof userEvent.setup>) {
  renderPage()
  // 空态 CTA 与顶栏按钮同名「新建 Webhook」：取顶栏那个（列表为空时两个都在页面里）
  const triggers = await screen.findAllByRole('button', { name: /新建 Webhook/ })
  await user.click(triggers[0]!)
  return screen.getByRole('radiogroup', { name: 'Webhook 渠道预设' })
}

/** 一条 platform 为清单外值的 webhook（版本错配/旧数据；前端不做运行时校验） */
const legacyPlatformWebhook = {
  id: 1,
  name: '旧版通道',
  url: 'https://example.com/hook',
  secret: '',
  platform: 'discord',
  events: [] as string[],
  isEnabled: true,
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  server.use(
    http.get('*/api/v1/webhooks', () => ok([])),
    http.get('*/api/v1/webhooks/event-types', () => ok([])),
  )
})

describe('Webhook 渠道预设单选组', () => {
  it('是完整的单选组：radiogroup + 每项 radio/aria-checked + roving tabindex', async () => {
    const user = userEvent.setup()
    const group = await openPresetGroup(user)

    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(6)
    // 默认选中「通用」：它是唯一可 Tab 进入的项
    const generic = within(group).getByRole('radio', { name: '通用' })
    expect(generic).toHaveAttribute('aria-checked', 'true')
    expect(generic).toHaveAttribute('tabindex', '0')
    expect(within(group).getByRole('radio', { name: '飞书' })).toHaveAttribute('aria-checked', 'false')
    expect(within(group).getByRole('radio', { name: '飞书' })).toHaveAttribute('tabindex', '-1')
  })

  it('方向键移动并即时选中、焦点跟随；Home/End 跳首尾、首尾回绕', async () => {
    const user = userEvent.setup()
    const group = await openPresetGroup(user)
    const generic = within(group).getByRole('radio', { name: '通用' })
    generic.focus()

    fireEvent.keyDown(generic, { key: 'ArrowRight' })
    const feishu = within(group).getByRole('radio', { name: '飞书' })
    expect(feishu).toHaveAttribute('aria-checked', 'true')
    expect(feishu).toHaveFocus()

    fireEvent.keyDown(feishu, { key: 'End' })
    const pushplus = within(group).getByRole('radio', { name: 'PushPlus' })
    expect(pushplus).toHaveAttribute('aria-checked', 'true')
    expect(pushplus).toHaveFocus()

    // 末项右移回绕到首项（焦点同样跟随）
    fireEvent.keyDown(pushplus, { key: 'ArrowRight' })
    expect(generic).toHaveAttribute('aria-checked', 'true')
    expect(generic).toHaveFocus()

    fireEvent.keyDown(generic, { key: 'End' })
    fireEvent.keyDown(pushplus, { key: 'Home' })
    expect(generic).toHaveAttribute('aria-checked', 'true')
    expect(generic).toHaveFocus()
  })

  it('点击非选中项后停靠点迁移（组内恒好一个 tabindex=0）', async () => {
    const user = userEvent.setup()
    const group = await openPresetGroup(user)

    await user.click(within(group).getByRole('radio', { name: '钉钉' }))
    const stops = within(group)
      .getAllByRole('radio')
      .filter((el) => el.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAccessibleName('钉钉')
  })

  it('platform 为清单外值时组内仍有且仅有一个 Tab 停靠点（异常数据不得让键盘进不了组）', async () => {
    server.use(http.get('*/api/v1/webhooks', () => ok([legacyPlatformWebhook])))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: '设置 旧版通道' }))
    const group = screen.getByRole('radiogroup', { name: 'Webhook 渠道预设' })

    // findIndex 为 -1 时若直接拿它算 tabindex，六项会全为 -1：键盘按 Tab 直接跳过整组
    const stops = within(group)
      .getAllByRole('radio')
      .filter((el) => el.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAccessibleName('通用')
    // 且不谎报选中：当前值不在清单里，没有哪一项能代表它
    expect(within(group).queryAllByRole('radio', { checked: true })).toHaveLength(0)

    // 停靠点可用：方向键把选择落到清单内第二项
    fireEvent.keyDown(stops[0]!, { key: 'ArrowRight' })
    expect(within(group).getByRole('radio', { name: '飞书' })).toHaveAttribute('aria-checked', 'true')
  })

  it('方向键之外的按键不抢，也不吞掉默认行为', async () => {
    const user = userEvent.setup()
    const group = await openPresetGroup(user)
    const generic = within(group).getByRole('radio', { name: '通用' })
    generic.focus()

    fireEvent.keyDown(generic, { key: 'a' })
    expect(generic).toHaveAttribute('aria-checked', 'true')
    // preventDefault 只对已识别的方向键触发；误吞 Tab 会让键盘用户出不了组
    expect(fireEvent.keyDown(generic, { key: 'Tab' })).toBe(true)
  })
})
