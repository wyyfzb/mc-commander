/**
 * TotpPanel（设置页两步验证挂靠向导）测试：
 * - 未启用态：入口按钮；enroll 后展示二维码 + 密钥文本（可复制）
 * - 挂靠中：6 位码提交 → confirm；码错 40106 提示并停留
 * - 确认成功：一次性展示 10 枚恢复码 + 「只显示一次」警示 + 下载/复制/我已保存键盘可达
 * - 「只显示一次」：确认保存后（及经**同一 QueryClient** 重挂后）不再渲染恢复码明文
 * - 已启用态：启用时间与剩余数量；关闭需密码 + 第二因子双证，成功提示含「其它设备已登出」
 * - 通道未认证（无会话也无 API Key）：只给说明，不发请求
 * mock 数据为结构占位（虚构恢复码），严禁真实凭据
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { Toaster, toast as sonnerToast } from 'sonner'
import { handlers } from '@/test/mocks/handlers'
import { queryKeys } from '@/api/queries'
import { TotpPanel } from '../totp-panel'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/**
 * 虚构恢复码（十枚，**服务端字母表内**的 10 位串：`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，
 * 无 I/O/0/1）。首枚刻意取全数字——字母表含 2–9，纯数字的合法恢复码确实存在，
 * 该形状正是「清洗不得截断」这条纪律的承重点（见 lib/__tests__/second-factor.test.ts）。
 */
const RECOVERY_CODES = [
  '2345678923', 'ABCDEFGHJK', 'LMNPQRSTUV', 'WXYZ234567', '89ABCDEFGH',
  'JKLMNPQRST', 'UVWXYZ2345', '6789ABCDEF', 'GHJKLMNPQR', 'STUVWXYZ23',
]

function ok(data: unknown) {
  return HttpResponse.json({ status: 'ok', code: 0, message: 'Success', data, timestamp: '' })
}

function err(code: number, message: string, status: number) {
  return HttpResponse.json(
    { status: 'error', code, message, details: null, timestamp: '' },
    { status },
  )
}

function mockStatus(enabled: boolean, remaining = 10, confirmedAt: string | null = '2026-01-02T03:04:05.000Z') {
  server.use(
    http.get('*/api/v1/auth/totp/status', () => ok({ enabled, confirmedAt, recoveryCodesRemaining: remaining })),
  )
}

/** 面板渲染；传入 queryClient 即复用同一实例（模拟应用级 QueryClient 跨子页存活） */
function renderPanel(props?: { authed?: boolean; queryClient?: QueryClient }) {
  const qc = props?.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TotpPanel baseUrl="https://192.168.1.100:25566" apiKey="demo-key-123" authed={props?.authed ?? true} />
      <Toaster />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  sonnerToast.dismiss()
})

describe('TotpPanel 未启用 → 挂靠', () => {
  it('未启用：显示启用入口，尚未调 enroll', async () => {
    mockStatus(false, 0)
    let enrollCalls = 0
    server.use(
      http.post('*/api/v1/auth/totp/enroll', () => {
        enrollCalls += 1
        return ok({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,AAAA' })
      }),
    )
    renderPanel()

    expect(await screen.findByRole('button', { name: /启用两步验证/ })).toBeInTheDocument()
    expect(screen.getByText(/两步验证（TOTP）/)).toBeInTheDocument()
    expect(enrollCalls).toBe(0)
  })

  it('点启用：展示二维码（带替代文本）与只读密钥，密钥可复制', async () => {
    mockStatus(false, 0)
    server.use(
      http.post('*/api/v1/auth/totp/enroll', () =>
        ok({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,AAAA' }),
      ),
    )
    // setup() 会自行接管 navigator.clipboard，故探针必须在它之后注入（否则断言打在自己的桩上）
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /启用两步验证/ }))

    const qr = await screen.findByAltText(/两步验证二维码/)
    expect(qr).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    const secret = screen.getByLabelText('密钥（无法扫码时手动输入）')
    expect(secret).toHaveValue('JBSWY3DPEHPK3PXP')
    expect(secret).toHaveAttribute('readonly')

    await user.click(screen.getByRole('button', { name: /复制/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP'))
  })

  it('码错（40106）→ 提示并停留；码对 → 一次性展示十枚恢复码 + 只显示一次警示', async () => {
    mockStatus(false, 0)
    server.use(
      http.post('*/api/v1/auth/totp/enroll', () =>
        ok({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,AAAA' }),
      ),
      http.post('*/api/v1/auth/totp/confirm', async ({ request }) => {
        const body = (await request.json()) as { code: string }
        if (body.code !== '123456') return err(40106, '两步验证码错误', 401)
        return ok({ enabled: true, confirmedAt: '2026-01-02T03:04:05.000Z', recoveryCodes: RECOVERY_CODES })
      }),
    )
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /启用两步验证/ }))
    const codeInput = await screen.findByLabelText('认证器中的 6 位验证码')
    await user.type(codeInput, '000000')
    await user.click(screen.getByRole('button', { name: /完成挂靠/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/两步验证码错误|两步验证码或恢复码错误/)
    expect(screen.queryByRole('list', { name: '两步验证恢复码' })).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText('认证器中的 6 位验证码'))
    await user.type(screen.getByLabelText('认证器中的 6 位验证码'), '123456')
    await user.click(screen.getByRole('button', { name: /完成挂靠/ }))

    // 恢复码以语义列表呈现，十枚齐全
    const list = await screen.findByRole('list', { name: '两步验证恢复码' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(10)
    expect(within(list).getByText(RECOVERY_CODES[0]!)).toBeInTheDocument()
    // 「只显示一次」必须是显式警示而不是小字脚注
    expect(screen.getByText(/这些恢复码只显示这一次/)).toBeInTheDocument()
    // 复制 / 下载 / 我已保存 都是可聚焦控件
    expect(screen.getByRole('button', { name: /复制全部/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /下载 \.txt/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /我已保存/ })).toBeEnabled()
  })

  /**
   * 「只显示一次」的承重断言。
   *
   * 真实的泄漏路径不是模块级变量，而是**存活的 QueryClient**：设置页用 `<Outlet/>` 切子页
   * 会卸载本面板，而应用级 QueryClient（main.tsx）跨子页存活——若哪天有人图省事把明文塞进
   * `setQueryData`（"免得重挂后丢失"），切一次子页就会把恢复码原样带回来。
   * 故本用例**复用一个 QueryClient** 做卸载重挂；每次 new 一个的写法对该类回归恒真无防护。
   */
  it('确认保存后明文消失；且经**同一 QueryClient** 卸载重挂（切子页往返）也不复现', async () => {
    mockStatus(false, 0)
    server.use(
      http.post('*/api/v1/auth/totp/enroll', () =>
        ok({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,AAAA' }),
      ),
      http.post('*/api/v1/auth/totp/confirm', () =>
        ok({ enabled: true, confirmedAt: '2026-01-02T03:04:05.000Z', recoveryCodes: RECOVERY_CODES }),
      ),
    )
    const user = userEvent.setup()
    // 应用级 QueryClient 的替身：整个用例共用，重挂不重建
    const sharedClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = renderPanel({ queryClient: sharedClient })

    await user.click(await screen.findByRole('button', { name: /启用两步验证/ }))
    await user.type(await screen.findByLabelText('认证器中的 6 位验证码'), '123456')
    await user.click(screen.getByRole('button', { name: /完成挂靠/ }))
    await screen.findByRole('list', { name: '两步验证恢复码' })

    // 收起后：status 已失效重取（此 mock 固定 enabled=false → 回到未启用态入口）
    await user.click(screen.getByRole('button', { name: /我已保存/ }))
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: '两步验证恢复码' })).not.toBeInTheDocument(),
    )
    expect(screen.queryByText(RECOVERY_CODES[0]!)).not.toBeInTheDocument()

    // 卸载重挂（= 设置页子导航「通用设置 → 账号与安全」往返）：同一 QueryClient 仍在，
    // 明文若能经它存活，这里必然复现
    view.unmount()
    mockStatus(true, 10)
    renderPanel({ queryClient: sharedClient })
    expect(await screen.findByText('已启用')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '两步验证恢复码' })).not.toBeInTheDocument()
    expect(screen.queryByText(RECOVERY_CODES[0]!)).not.toBeInTheDocument()
    // 缓存里也不得留下明文（断言到数据层，避免只靠渲染结果间接推断）
    expect(JSON.stringify(sharedClient.getQueryData(queryKeys.totpStatus()) ?? {})).not.toContain(
      RECOVERY_CODES[0]!,
    )
  })
})

describe('TotpPanel 已启用 → 关闭', () => {
  it('已启用：显示启用时间与剩余恢复码数', async () => {
    mockStatus(true, 7)
    renderPanel()

    expect(await screen.findByText('已启用')).toBeInTheDocument()
    expect(screen.getByText(/启用时间：/)).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText(/剩余恢复码/)).toBeInTheDocument()
    // 剩余充足时的提醒（本用例为 7 枚 > 阈值 3，不出现）
    expect(screen.queryByText(/可用恢复码仅剩/)).not.toBeInTheDocument()
  })

  // 阈值口径：剩余 ≤3 即告警（清单 #31）。边界用「恰好 3 枚」钉住——阈值回退到
  // ≤2 时该用例必红，而不是只覆盖「显然很低」的 2 枚
  it.each([
    [3, true],
    [2, true],
    [1, true],
    [0, true],
    [4, false],
    [10, false],
  ])('剩余 %i 枚 → 告警提示出现=%s', async (remaining, shouldWarn) => {
    mockStatus(true, remaining)
    renderPanel()
    await screen.findByText('已启用')

    const banner = screen.queryByText(/可用恢复码仅剩/)
    if (shouldWarn) {
      expect(banner).toHaveTextContent(`可用恢复码仅剩 ${remaining} 枚`)
    } else {
      expect(banner).not.toBeInTheDocument()
    }
  })

  it('关闭：确认按钮需密码 + 第二因子双证齐备；成功后提示「其它设备已登出」', async () => {
    mockStatus(true, 10)
    let body: Record<string, unknown> = {}
    server.use(
      http.post('*/api/v1/auth/totp/disable', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return ok({ ok: true })
      }),
    )
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /关闭两步验证/ }))
    const dialog = await screen.findByRole('dialog')
    // 双证未齐：确认按钮禁用
    expect(within(dialog).getByRole('button', { name: '关闭两步验证' })).toBeDisabled()

    await user.type(within(dialog).getByLabelText('管理员密码'), 'demo-pass-12345')
    expect(within(dialog).getByRole('button', { name: '关闭两步验证' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText('两步验证码'), 'ABCD2345EF')
    expect(within(dialog).getByRole('button', { name: '关闭两步验证' })).toBeEnabled()

    await user.click(within(dialog).getByRole('button', { name: '关闭两步验证' }))

    await waitFor(() => expect(body).toEqual({ password: 'demo-pass-12345', code: 'ABCD2345EF' }))
    expect(await screen.findByText('两步验证已关闭，其它设备已登出')).toBeInTheDocument()
  })

  it('关闭失败（密码错 40102）→ 弹窗内提示，弹窗不关闭', async () => {
    mockStatus(true, 10)
    server.use(http.post('*/api/v1/auth/totp/disable', () => err(40102, '密码错误', 401)))
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /关闭两步验证/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('管理员密码'), 'wrong-pass')
    await user.type(within(dialog).getByLabelText('两步验证码'), '123456')
    await user.click(within(dialog).getByRole('button', { name: '关闭两步验证' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('密码错误')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('TotpPanel 未认证通道', () => {
  it('无会话也无 API Key：只给说明，不发状态请求', async () => {
    let statusCalls = 0
    server.use(
      http.get('*/api/v1/auth/totp/status', () => {
        statusCalls += 1
        return ok({ enabled: false, confirmedAt: null, recoveryCodesRemaining: 0 })
      }),
    )
    renderPanel({ authed: false })

    expect(await screen.findByText(/需要登录会话或 API Key 才能配置/)).toBeInTheDocument()
    expect(statusCalls).toBe(0)
  })
})
