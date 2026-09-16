import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * 两步验证（TOTP）E2E：登录第二因子 + 设置页挂靠向导关键步骤
 *
 * 夹具策略：`scripts/mock-server.mjs` 未建模 TOTP 端点（它的登录恒成功、也没有
 * /auth/totp/*），故本 spec 用 `page.route` **就地**补齐，不改 mock 的共享行为——
 * 改 mock 会让其它 spec 的「密码登录必成功」前提失效（先例见 players-virtual-scroll.spec.ts）。
 *
 * 覆盖：登录遇 40105 → 就地展开输入 → 6 位码 → 进入面板；
 *       登录用**纯数字 10 位恢复码**原样提交（服务端字母表含 2–9，该形状合法；
 *       前端任何长度截断都会在这里现形：请求体必须仍是 10 位）；
 *       设置页挂靠向导：状态 → enroll（二维码 + 密钥）→ confirm → 一次性恢复码 →
 *       我已保存 → 子导航往返与 reload 双路径都不复现明文。
 * 凭据与恢复码全为虚构结构占位，严禁真实信息。
 */

/** mock 后端会话令牌（scripts/mock-server.mjs 的固定值；注入会话态以免每次真登录） */
const MOCK_SESSION_TOKEN = 'e2e-mock-session-token-0000000001'

/**
 * 虚构恢复码（十枚，**服务端字母表内**的 10 位串：`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，
 * 无 I/O/0/1）。首枚刻意取全数字——字母表含 2–9 ⇒ 纯数字恢复码合法，
 * 正是「清洗不得截断」这条纪律的承重点。
 */
const RECOVERY_CODES = [
  '2345678923', 'ABCDEFGHJK', 'LMNPQRSTUV', 'WXYZ234567', '89ABCDEFGH',
  'JKLMNPQRST', 'UVWXYZ2345', '6789ABCDEF', 'GHJKLMNPQR', 'STUVWXYZ23',
]

/** 全数字恢复码（展示形态带分组；清洗后应为 RECOVERY_CODES[0]） */
const ALL_DIGIT_RECOVERY_CODE = RECOVERY_CODES[0]!
const ALL_DIGIT_RECOVERY_DISPLAY = '23456-78923'

const QR_DATA_URL =
  // 1×1 透明 PNG 的 data URL（真实二维码由服务端生成；此处只验 UI 契约与替代文本）
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAI/wH+pNNfAAAAAElFTkSuQmCC'

function ok(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', code: 0, message: 'Success', data, timestamp: new Date().toISOString() }),
  }
}

function fail(code: number, message: string, httpStatus: number) {
  return {
    status: httpStatus,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'error', code, message, details: null, timestamp: new Date().toISOString() }),
  }
}

/** 注入会话态（mock 后端只校验 Bearer 等于它签发的固定令牌） */
async function seedSession(page: Page) {
  await page.addInitScript((token) => {
    localStorage.setItem(
      'mcs-session',
      JSON.stringify({
        token,
        sessionId: 'sess-mock-1',
        expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      }),
    )
  }, MOCK_SESSION_TOKEN)
}

/** 登录端点的第二因子建模：未带码回 40105，带码成功；记录每次请求体供边界断言 */
async function routeLoginWithTotp(
  page: Page,
  acceptCode: string,
  seen: Array<{ password?: string; totpCode?: string }> = [],
) {
  await page.route('**/api/v1/auth/login', async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as { password?: string; totpCode?: string }
    seen.push(body)
    if (!body.totpCode) return route.fulfill(fail(40105, '需要两步验证码', 401))
    if (body.totpCode !== acceptCode) return route.fulfill(fail(40106, '两步验证码或恢复码错误', 401))
    return route.fulfill(
      ok({
        token: MOCK_SESSION_TOKEN,
        sessionId: 'sess-mock-1',
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
    )
  })
  return seen
}

test.describe('登录页第二因子（40105）', () => {
  test('密码通过后展开验证码输入 → 输入 6 位码 → 进入仪表盘', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('mcs-connection')
      localStorage.removeItem('mcs-session')
    })
    await routeLoginWithTotp(page, '123456')

    await page.goto('/login')
    const password = page.getByLabel('管理员密码')
    await expect(password).toBeVisible()
    await password.fill('e2e-correct-pass')
    await page.getByRole('button', { name: /登录/ }).click()

    // 40105：就地展开（不跳页），密码保留，标题切到「两步验证」
    await expect(page.getByRole('heading', { name: '两步验证' })).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByLabel('管理员密码')).toHaveValue('e2e-correct-pass')

    const code = page.getByLabel('两步验证码')
    await expect(code).toBeVisible()
    await expect(code).toHaveAttribute('inputmode', 'numeric')
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code')

    await code.fill('123456')
    await page.getByRole('button', { name: /验证并登录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('button', { name: '管理员菜单' })).toBeVisible()
  })

  test('验证码错误（40106）→ 分类文案，仍留在登录页可重试', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('mcs-connection')
      localStorage.removeItem('mcs-session')
    })
    await routeLoginWithTotp(page, '123456')

    await page.goto('/login')
    await page.getByLabel('管理员密码').fill('e2e-correct-pass')
    await page.getByRole('button', { name: /登录/ }).click()

    const code = page.getByLabel('两步验证码')
    await code.fill('000000')
    await page.getByRole('button', { name: /验证并登录/ }).click()
    await expect(page.getByRole('alert')).toContainText('两步验证码或恢复码错误')
    await expect(page).toHaveURL(/\/login/)
    // 错误后清空，避免原样重提
    await expect(code).toHaveValue('')
  })

  /**
   * F-01 的边界证据：纯数字的 10 位恢复码必须在浏览器→服务端边界上**原样**出现。
   * 服务端字母表含 2–9，故这种码合法且会被分到恢复码分支；任何「纯数字就截到 6 位」
   * 的清洗都会把它削成 6 位 TOTP 形状（服务端只认恰好 6 位 ⇒ 走 TOTP 分支 ⇒ 必失败），
   * 而输入框里也会只剩 6 个字符——本用例两条一起断言。
   */
  test('纯数字 10 位恢复码：输入框保留全文且请求体原样提交', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('mcs-connection')
      localStorage.removeItem('mcs-session')
    })
    const seen = await routeLoginWithTotp(page, ALL_DIGIT_RECOVERY_CODE)

    await page.goto('/login')
    await page.getByLabel('管理员密码').fill('e2e-correct-pass')
    await page.getByRole('button', { name: /登录/ }).click()

    const code = page.getByLabel('两步验证码')
    // 展示形态带分组：清洗只去分隔符，10 位一位不少
    await code.fill(ALL_DIGIT_RECOVERY_DISPLAY)
    await expect(code).toHaveValue(ALL_DIGIT_RECOVERY_CODE)

    await page.getByRole('button', { name: /验证并登录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    expect(seen[1]).toEqual({
      password: 'e2e-correct-pass',
      totpCode: ALL_DIGIT_RECOVERY_CODE,
    })
  })
})

test.describe('设置页两步验证挂靠向导', () => {
  test('未启用 → enroll 展示二维码与密钥 → confirm 后一次性展示恢复码 → 我已保存后收起（子导航往返与刷新双路径不复现）', async ({ page }) => {
    await seedSession(page)
    await page.addInitScript(() => {
      localStorage.setItem('mcs-connection', JSON.stringify({ baseUrl: '', apiKey: '' }))
    })

    // 状态：先未启用；confirm 之后翻为已启用（模拟服务端状态迁移）
    let enabled = false
    await page.route('**/api/v1/auth/totp/status', (route) =>
      route.fulfill(
        ok(
          enabled
            ? { enabled: true, confirmedAt: '2026-01-02T03:04:05.000Z', recoveryCodesRemaining: 10 }
            : { enabled: false, confirmedAt: null, recoveryCodesRemaining: 0 },
        ),
      ),
    )
    await page.route('**/api/v1/auth/totp/enroll', (route) =>
      route.fulfill(
        ok({
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUrl: 'otpauth://totp/MCCommander:admin?secret=JBSWY3DPEHPK3PXP',
          qrDataUrl: QR_DATA_URL,
        }),
      ),
    )
    await page.route('**/api/v1/auth/totp/confirm', async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { code?: string }
      if (body.code !== '123456') return route.fulfill(fail(40106, '两步验证码错误', 401))
      enabled = true
      return route.fulfill(
        ok({ enabled: true, confirmedAt: '2026-01-02T03:04:05.000Z', recoveryCodes: RECOVERY_CODES }),
      )
    })

    await page.goto('/settings/account')
    await expect(page.getByRole('heading', { name: '两步验证（TOTP）' })).toBeVisible()

    // 未启用：入口按钮
    await page.getByRole('button', { name: /启用两步验证/ }).click()

    // 二维码（可访问替代文本）+ 只读密钥
    await expect(page.getByAltText(/两步验证二维码/)).toBeVisible()
    await expect(page.getByLabel('密钥（无法扫码时手动输入）')).toHaveValue('JBSWY3DPEHPK3PXP')

    // confirm：码错先报错
    const code = page.getByLabel('认证器中的 6 位验证码')
    await code.fill('000000')
    await page.getByRole('button', { name: /完成挂靠/ }).click()
    await expect(page.getByRole('alert')).toContainText(/两步验证码错误|两步验证码或恢复码错误/)

    // 码对：一次性恢复码列表 + 只显示一次警示
    await code.fill('123456')
    await page.getByRole('button', { name: /完成挂靠/ }).click()
    const list = page.getByRole('list', { name: '两步验证恢复码' })
    await expect(list).toBeVisible()
    await expect(list.getByRole('listitem')).toHaveCount(10)
    await expect(list.getByText(ALL_DIGIT_RECOVERY_CODE)).toBeVisible()
    await expect(page.getByText(/这些恢复码只显示这一次/)).toBeVisible()
    await expect(page.getByRole('button', { name: /复制全部/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /下载 \.txt/ })).toBeVisible()

    // 我已保存 → 明文收起，只剩「剩余 N 个」
    await page.getByRole('button', { name: /我已保存/ }).click()
    await expect(page.getByRole('list', { name: '两步验证恢复码' })).toBeHidden()
    await expect(page.getByText(/剩余恢复码/)).toBeVisible()

    // 路径一：设置页子导航往返。`<Outlet/>` 会卸载本面板，而应用级 QueryClient 跨子页存活
    // ——这是「明文被塞进 query 缓存」这类回归唯一能在应用内复现的路径（reload 会销毁缓存，测不到）
    await page.getByRole('link', { name: '通用设置' }).click()
    await expect(page).toHaveURL(/\/settings\/general/)
    await page.getByRole('link', { name: '账号与安全' }).click()
    await expect(page).toHaveURL(/\/settings\/account/)
    await expect(page.getByText(/剩余恢复码/)).toBeVisible()
    await expect(page.getByRole('list', { name: '两步验证恢复码' })).toBeHidden()
    await expect(page.getByText(ALL_DIGIT_RECOVERY_CODE)).toBeHidden()

    // 路径二：整页刷新（销毁内存态）。两条路径合起来才算把「只显示一次」钉住
    await page.reload()
    await expect(page.getByText(/剩余恢复码/)).toBeVisible()
    await expect(page.getByText(ALL_DIGIT_RECOVERY_CODE)).toBeHidden()
  })

  test('已启用 → 关闭需密码与第二因子双证，成功后提示其它设备已登出', async ({ page }) => {
    await seedSession(page)
    await page.addInitScript(() => {
      localStorage.setItem('mcs-connection', JSON.stringify({ baseUrl: '', apiKey: '' }))
    })

    let enabled = true
    await page.route('**/api/v1/auth/totp/status', (route) =>
      route.fulfill(
        ok(
          enabled
            ? { enabled: true, confirmedAt: '2026-01-02T03:04:05.000Z', recoveryCodesRemaining: 8 }
            : { enabled: false, confirmedAt: null, recoveryCodesRemaining: 0 },
        ),
      ),
    )
    await page.route('**/api/v1/auth/totp/disable', async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { password?: string; code?: string }
      if (!body.password || !body.code) return route.fulfill(fail(40015, '两步验证尚未挂靠，请先完成挂靠', 400))
      enabled = false
      return route.fulfill(ok({ ok: true }))
    })

    await page.goto('/settings/account')
    await expect(page.getByText('已启用')).toBeVisible()
    await expect(page.getByText(/剩余恢复码/)).toBeVisible()

    await page.getByRole('button', { name: /关闭两步验证/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // 双证未齐时确认不可点
    await expect(dialog.getByRole('button', { name: '关闭两步验证' })).toBeDisabled()

    await dialog.getByLabel('管理员密码').fill('e2e-correct-pass')
    await dialog.getByLabel('两步验证码').fill('ABCD2345EF')
    await expect(dialog.getByRole('button', { name: '关闭两步验证' })).toBeEnabled()
    await dialog.getByRole('button', { name: '关闭两步验证' }).click()

    await expect(page.getByText('两步验证已关闭，其它设备已登出')).toBeVisible()
    await expect(page.getByRole('button', { name: /启用两步验证/ })).toBeVisible()
  })
})
