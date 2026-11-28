import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'

/**
 * 冒烟 E2E（基本可跑 / Cmd+K 可跳转 / 主题切换）
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(import.meta.dirname, 'test-results', 'shots')
function maybeShot(page: Page, name: string) {
  return process.env.E2E_SHOT ? page.screenshot({ path: path.join(SHOT_DIR, name) }) : undefined
}

/** 注入连接配置（无配置会重定向 /onboarding）——mock 假 key，严禁真实服务器信息 */
async function setupConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
  })
}

async function controlBorderContrast(control: Locator) {
  return control.evaluate((el) => {
    const style = getComputedStyle(el)
    let host = el.parentElement
    while (host && getComputedStyle(host).backgroundColor === 'rgba(0, 0, 0, 0)') {
      host = host.parentElement
    }
    if (!host) throw new Error('控件缺少实底宿主')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')!
    const fill = (color: string) => {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
    }
    const luminance = () => {
      const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data, (channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    fill(getComputedStyle(host).backgroundColor)
    const surface = luminance()
    if (style.backgroundClip === 'border-box') fill(style.backgroundColor)
    fill(style.borderTopColor)
    const edge = luminance()
    return (Math.max(surface, edge) + 0.05) / (Math.min(surface, edge) + 0.05)
  })
}

test.describe('冒烟', () => {
  test('暗色控件：输入框、下拉框、多行输入和命令搜索的外边界至少 3:1', async ({ page }) => {
    await setupConnection(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/settings/device')
    await expect(page.locator('html')).toHaveClass(/dark/)
    const input = page.getByLabel('面板地址')
    const select = page.getByRole('combobox', { name: '界面主题' })
    await expect(input).toBeVisible()
    await expect.soft(await controlBorderContrast(input), '面板地址').toBeGreaterThanOrEqual(3)
    await expect.soft(await controlBorderContrast(select), '界面主题').toBeGreaterThanOrEqual(3)

    await page.goto('/dashboard')
    const textarea = page.getByLabel('公告内容')
    await expect(textarea).toBeVisible()
    await expect.soft(await controlBorderContrast(textarea), '公告内容').toBeGreaterThanOrEqual(3)

    await page.keyboard.press('Control+k')
    const search = page.getByPlaceholder('输入页面名称或命令…')
    await expect(search).toBeFocused()
    // 命令面板把键盘焦点留在输入框；单独测量无焦点时的外边界。
    await search.evaluate(async (el: HTMLInputElement) => {
      el.blur()
      const view = el.ownerDocument.defaultView
      if (!view) return
      await new Promise<void>((resolve) =>
        view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())),
      )
    })
    const group = search.locator('xpath=ancestor::*[@data-slot="input-group"]')
    await expect(search).not.toBeFocused()
    await expect.soft(await controlBorderContrast(group), '命令搜索').toBeGreaterThanOrEqual(3)
  })
  test('强制颜色：Tab 聚焦表单与命令搜索时仍有轮廓', async ({ page }) => {
    await setupConnection(page)
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    await page.goto('/settings/device')
    const expectOutline = async (locator: Locator, label: string) => {
      const outline = await locator.evaluate((el) => getComputedStyle(el).outlineStyle)
      expect.soft(outline, label).toBe('solid')
    }
    const address = page.getByLabel('面板地址')
    await address.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(address).toBeFocused()
    await expectOutline(address, '面板地址')

    const theme = page.getByRole('combobox', { name: '界面主题' })
    await theme.focus()
    await expectOutline(theme, '界面主题')

    await page.goto('/dashboard')
    const announcement = page.getByLabel('公告内容')
    await announcement.focus()
    await expectOutline(announcement, '公告内容')
    await page.keyboard.press('Control+k')
    const search = page.getByPlaceholder('输入页面名称或命令…')
    await expect(search).toBeFocused()
    await expectOutline(search.locator('xpath=ancestor::*[@data-slot="input-group"]'), '命令搜索')
  })

  /* 字体子集覆盖（中文标点等）**不在 e2e 锁**：量宽与 `document.fonts.check()` 都
     证不了「某码位在不在字体里」——前者对着一串字符求和时，子集里只要留任意一枚字形就通过
     （实测：只含 `…` 的字体仍绿）；后者对子集外字符也返回 true。码位级覆盖由
     `tests/unit/font-subset.test.ts` 承担（自带 WOFF2 cmap 解析，无第三方依赖）。 */
  test('页面加载：品牌、侧栏、顶栏元素可见', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/')
    // index 路由重定向到 /dashboard
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByText('MC Commander').first()).toBeVisible()
    /* 侧栏主序列全部要可达：只断言其中几项时，其余项被删掉照样绿，
       而用户看不到入口就不会知道那个页面还在 */
    for (const label of [
      '仪表盘',
      '玩家',
      '世界',
      '文件',
      '任务',
      '备份',
      '插件',
      '实例',
      '全局总览',
    ]) {
      await expect(page.getByRole('link', { name: new RegExp(label) })).toBeVisible()
    }
    // 底部辅助区两项（帮助 / 设置）与主序列分开
    for (const label of ['帮助', '设置']) {
      await expect(page.getByRole('link', { name: new RegExp(label) })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: /搜索或执行命令/ })).toBeVisible()
    // 顶栏实例标识（mock 无 WS，状态点文案动态不稳，用实例名断言）。
    // mock 的实例列表恰好一个 ⇒ 选择器降级为纯展示：实例名不该挂在可点的按钮上
    // （mock 若增到多实例，这里会红——那正是「该恢复下拉」的信号，不是脆断言）
    await expect(page.getByText('E2E 演示实例').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'E2E 演示实例' })).toHaveCount(0)
  })

  test('导航跳转：点击侧栏玩家进入占位页', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/')
    await page.getByRole('link', { name: /玩家/ }).click()
    await expect(page).toHaveURL(/\/players/)
    // 玩家页：搜索框可见
    await expect(page.getByPlaceholder('搜索玩家名或 UUID…')).toBeVisible()
  })

  test('Cmd+K：打开命令面板并跳转页面', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/')
    // lazy chunk 首次编译期间键盘事件可能被吞：先等页面就绪再按键
    await expect(page.getByText('E2E 演示实例').first()).toBeVisible()
    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder('输入页面名称或命令…')).toBeVisible()
    await page.getByRole('option', { name: /世界/ }).click()
    await expect(page).toHaveURL(/\/world/)
  })

  test('主题切换：从顶栏按钮和设置下拉框中心圆形扩散', async ({ page }) => {
    await setupConnection(page)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/settings/device')
    const root = page.locator('html')
    const theme = page.getByRole('combobox', { name: '界面主题' })
    const topbar = page.getByRole('button', { name: '切换到亮色主题' })
    await expect(root).toHaveClass(/dark/)
    await expect(topbar).toBeVisible()

    await page.evaluate(() => {
      const start = document.startViewTransition.bind(document)
      document.startViewTransition = (update) => {
        const root = document.documentElement
        const listClosed = !document.querySelector('[role=listbox]')
        const activeRole = document.activeElement?.getAttribute('role') ?? ''
        const transition = start(update)
        void transition.ready.then(() => {
          const animation = document
            .getAnimations()
            .find((item) => 'animationName' in item && item.animationName === 'mcs-theme-reveal')
          if (animation) {
            animation.pause()
            animation.currentTime = 50
          }
          const style = getComputedStyle(root, '::view-transition-new(root)')
          root.dataset.testReveal = JSON.stringify({
            clip: style.clipPath,
            duration: style.animationDuration,
            listClosed,
            activeRole,
          })
        })
        return transition
      }
    })

    const assertReveal = async (origin: {
      x: number
      y: number
      width: number
      height: number
    }) => {
      await expect(root).toHaveAttribute('data-test-reveal', /"clip":"circle\(/)
      const { clip, duration, listClosed, activeRole } = JSON.parse(
        (await root.getAttribute('data-test-reveal'))!,
      )
      const match = /circle\(([\d.]+)px at ([\d.]+)px ([\d.]+)px\)/.exec(clip)
      expect(match).not.toBeNull()
      const [radius, x, y] = match!.slice(1).map(Number)
      expect(radius).toBeGreaterThan(0)
      expect(x).toBeCloseTo(origin.x + origin.width / 2, 0)
      expect(y).toBeCloseTo(origin.y + origin.height / 2, 0)
      expect(duration).toBe('0.3s')
      await maybeShot(page, `theme-reveal-${activeRole || 'button'}.png`)
      await page.evaluate(() => {
        delete document.documentElement.dataset.testReveal
        for (const animation of document.getAnimations()) {
          if ('animationName' in animation && animation.animationName === 'mcs-theme-reveal') {
            animation.finish()
          }
        }
      })
      await expect(root).not.toHaveAttribute('data-theme-reveal')
      return { listClosed, activeRole }
    }

    const buttonBounds = (await topbar.boundingBox())!
    await topbar.click()
    await assertReveal(buttonBounds)
    await expect(root).toHaveClass(/light/)

    await theme.scrollIntoViewIfNeeded()
    const selectBounds = (await theme.boundingBox())!
    await theme.click()
    await page.getByRole('option', { name: '暗色' }).press('Enter')
    expect(await assertReveal(selectBounds)).toEqual({ listClosed: true, activeRole: 'combobox' })
    await expect(root).toHaveClass(/dark/)
    await expect(theme).toBeFocused()

    await topbar.click()
    await expect(root).toHaveAttribute('data-test-reveal', /"clip":"circle\(/)
    await expect(root).toHaveClass(/light/)
    // 快照播放时仍可用键盘激活焦点控件。
    await page.keyboard.press('Enter')
    await expect(root).toHaveClass(/dark/)
  })

  for (const fallback of ['减少动态', '不支持 API'] as const) {
    test(`主题切换降级：${fallback}时直接换色`, async ({ page }) => {
      await setupConnection(page)
      if (fallback === '减少动态') {
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.addInitScript(() => {
          document.startViewTransition = () => {
            document.documentElement.dataset.testUnexpectedTransition = ''
            throw new Error('减少动态时不应请求快照')
          }
        })
      } else {
        await page.addInitScript(() => {
          Object.defineProperty(document, 'startViewTransition', { value: undefined })
        })
      }
      await page.goto('/')
      const root = page.locator('html')
      await page.getByRole('button', { name: '切换到亮色主题' }).click()
      await expect(root).toHaveClass(/light/)
      await expect(root).not.toHaveAttribute('data-test-unexpected-transition', '')
      await expect(root).not.toHaveAttribute('data-theme-reveal')
    })
  }

  /* 跟随系统：偏好存 'system' 时配色由 prefers-color-scheme 决定，且系统切换后要即时换档
     （只读一次会让面板停在旧配色）。jsdom 的 matchMedia 是常量桩，这条只有真浏览器能锁。 */
  test('主题跟随系统：按 prefers-color-scheme 定色，系统切换后即时换档', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.addInitScript(() => {
      localStorage.setItem(
        'mcs-ui-preferences',
        JSON.stringify({ state: { theme: 'system' }, version: 0 }),
      )
    })
    await setupConnection(page)
    await page.goto('/')
    await expect(page.locator('html')).toHaveClass(/light/)

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('视觉截图：暗色仪表盘 / 命令面板 / 亮色仪表盘', async ({ page }) => {
    await setupConnection(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // 就绪门：networkidle 只代表网络静默，不保证 React 已挂载——Ctrl+K 若早于
    // CommandPalette 注册 window keydown 监听就会丢键（空按），并行 worker 冷启动下偶发
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 30_000 })
    await maybeShot(page, 'dashboard-dark.png')

    // 可重试的按键：Ctrl+K 是**切换**语义，丢键（早于监听注册）时重按即开——用 toPass
    // 与「监听何时注册」解耦，不再依赖某个前置可见信号恰好覆盖它
    await expect(async () => {
      await page.keyboard.press('Control+k')
      await expect(page.getByPlaceholder('输入页面名称或命令…')).toBeVisible({ timeout: 3_000 })
    }).toPass()
    await maybeShot(page, 'command-palette-dark.png')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await expect(page.locator('html')).not.toHaveAttribute('data-theme-reveal')
    await maybeShot(page, 'dashboard-light.png')

    // 亮色命令面板 + 键盘选中态（设计审查必须修项复审：选中态可见性）
    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder('输入页面名称或命令…')).toBeVisible()
    await page.keyboard.press('ArrowDown') // 从默认首项移到第二项，验证选中态可见
    await maybeShot(page, 'command-palette-light.png')
  })
})
