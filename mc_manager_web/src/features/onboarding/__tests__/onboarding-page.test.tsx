/**
 * OnboardingPage 行为级补测（issue 433）
 * - 跳过类：「已有服务端」默认态——部署指南不渲染，直连表单就位
 * - 推进类：部署方式切换——指南块内容随选择渲染（Windows 手动步骤 / Linux 一键脚本+要点）
 * - 边界类：Docker 不占卡片位，只在卡片区下方一行说明（不提供镜像、不给跑不通的命令）
 * - 单选组类：三张卡是同一 radiogroup 下的 radio（aria-checked + roving tabindex + 方向键）
 * - 完成类：连接表单保存成功 → 欢迎 toast + navigate('/dashboard')
 * - 附属：命令复制成功/失败反馈、ConnectionForm variant 透传
 * ConnectionForm 以轻量桩替代（其自身行为由 settings 域测试覆盖）；数据全虚构
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { OnboardingPage } from '../onboarding-page'

const { toastSuccess, toastError, copyTextMock, navigateSpy } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  copyTextMock: vi.fn<() => Promise<boolean>>(),
  navigateSpy: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

// OnboardingPage 消费 useNavigate 与 Link（返回登录页）；Link 桩为纯锚点渲染，导出其余保留
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  }
})

vi.mock('@/lib/clipboard', () => ({
  copyText: () => copyTextMock(),
}))

// ConnectionForm 重表单组件桩：暴露 variant 与保存成功入口
vi.mock('@/features/settings/components/connection-form', () => ({
  ConnectionForm: (props: { variant: string; onSaved: () => void }) => (
    <div data-testid="connection-form" data-variant={props.variant}>
      <button type="button" onClick={props.onSaved}>
        保存并连接
      </button>
    </div>
  ),
}))

beforeEach(() => {
  vi.clearAllMocks()
  copyTextMock.mockResolvedValue(true)
})

describe('OnboardingPage · 默认态（跳过部署指南）', () => {
  it('渲染标题 + 三部署方式卡 + Docker 说明 + 连接表单 + 部署文档链接', () => {
    render(<OnboardingPage />)
    expect(screen.getByText('欢迎使用 MC Commander')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /已有服务端/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Linux 一键部署/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Windows 手动部署/ })).toBeInTheDocument()
    // 不提供官方镜像 → 不占卡片位，只在卡片区下方如实说明
    expect(screen.queryByRole('button', { name: /Docker/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Docker 不在支持范围内/)).toBeInTheDocument()
    expect(screen.getByTestId('connection-form')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← 返回登录页' })).toHaveAttribute('href', '/login')
    expect(screen.getByRole('link', { name: '查看部署文档 →' })).toHaveAttribute('href', 'https://gitee.com/wyyfzb/mc-commander')
  })

  it('默认选中「已有服务端」且部署指南不渲染（跳过路径）', () => {
    render(<OnboardingPage />)
    const already = screen.getByRole('radio', { name: /已有服务端/ })
    expect(already).toHaveAttribute('aria-checked', 'true')
    // 两种指南均未出现
    expect(screen.queryByText('Windows 手动部署（Node 22+）')).not.toBeInTheDocument()
    expect(screen.queryByText('Linux 一键部署命令')).not.toBeInTheDocument()
  })
})

describe('OnboardingPage · 部署方式推进', () => {
  it('切换到 Windows 手动部署：卡片选中态迁移 + 步骤指南渲染', () => {
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('radio', { name: /Windows 手动部署/ }))
    expect(screen.getByRole('radio', { name: /Windows 手动部署/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /已有服务端/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Windows 手动部署（Node 22+）')).toBeInTheDocument()
    expect(screen.getByText(/nodejs\.org/)).toBeInTheDocument()
    expect(screen.getByText(/Copy-Item \.env\.example \.env/)).toBeInTheDocument()
    expect(screen.getByText(/localhost:25566/)).toBeInTheDocument()
    // 前端产物缺失时服务端不挂载静态层（:25566 只有 API）——构建步骤必须在列
    expect(screen.getByText(/npm run build/)).toBeInTheDocument()
    expect(screen.getByText(/Copy-Item \.\.\/mc_manager_web\/dist\/\* public\//)).toBeInTheDocument()
    // 发布物没有 Windows 包，页面必须把这一点说清而不是指引下载
    expect(screen.getByText(/未提供 Windows 安装包/)).toBeInTheDocument()
    expect(screen.getByText(/建议改用 WSL2/)).toBeInTheDocument()
  })

  it('切换到 Linux 一键部署：一键脚本 + 三条要点清单', () => {
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('radio', { name: /Linux 一键部署/ }))
    expect(screen.getByText('Linux 一键部署命令')).toBeInTheDocument()
    expect(screen.getByText(/deploy-mc-commander\.sh/)).toBeInTheDocument()
    expect(screen.getByText(/自动安装 Java 17\/21\/25/)).toBeInTheDocument()
    expect(screen.getByText(/妥善保存/)).toBeInTheDocument()
    expect(screen.getByText(/25566 端口/)).toBeInTheDocument()
  })

  it('指南块随选择互斥：切回「已有服务端」指南消失', () => {
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('radio', { name: /Linux 一键部署/ }))
    expect(screen.getByText('Linux 一键部署命令')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /已有服务端/ }))
    expect(screen.queryByText('Linux 一键部署命令')).not.toBeInTheDocument()
  })
})

describe('OnboardingPage · 部署方式单选组语义', () => {
  it('三张卡同属一个 radiogroup，选中态用 aria-checked 表达（不是各按各的开关）', () => {
    render(<OnboardingPage />)
    const group = screen.getByRole('radiogroup', { name: '部署方式' })
    expect(within(group).getAllByRole('radio')).toHaveLength(3)
    expect(within(group).getByRole('radio', { name: /已有服务端/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(group).getByRole('radio', { name: /Linux 一键部署/ })).toHaveAttribute('aria-checked', 'false')
    // 组外没有游离的 radio
    expect(within(group).getAllByRole('radio')).toHaveLength(screen.getAllByRole('radio').length)
  })

  it('roving tabindex：组内只有选中项可 Tab 进入', () => {
    render(<OnboardingPage />)
    expect(screen.getByRole('radio', { name: /已有服务端/ })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: /Linux 一键部署/ })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('radio', { name: /Windows 手动部署/ })).toHaveAttribute('tabindex', '-1')
  })

  it('方向键在组内移动并即时选中（右移 / 左移回绕 / Home），焦点跟随', () => {
    render(<OnboardingPage />)
    const already = screen.getByRole('radio', { name: /已有服务端/ })
    already.focus()

    fireEvent.keyDown(already, { key: 'ArrowRight' })
    const linux = screen.getByRole('radio', { name: /Linux 一键部署/ })
    expect(linux).toHaveAttribute('aria-checked', 'true')
    expect(linux).toHaveFocus()
    // 选中即换指南（键盘用户与鼠标用户看到同一结果）
    expect(screen.getByText('Linux 一键部署命令')).toBeInTheDocument()

    // 左移回绕：首项左移落到末项
    fireEvent.keyDown(linux, { key: 'ArrowLeft' })
    expect(already).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(already, { key: 'ArrowLeft' })
    const windows = screen.getByRole('radio', { name: /Windows 手动部署/ })
    expect(windows).toHaveAttribute('aria-checked', 'true')
    expect(windows).toHaveFocus()

    fireEvent.keyDown(windows, { key: 'Home' })
    expect(already).toHaveAttribute('aria-checked', 'true')
    expect(already).toHaveFocus()
  })

  it('上下键与 End 同样按单选组模型工作', () => {
    render(<OnboardingPage />)
    const already = screen.getByRole('radio', { name: /已有服务端/ })
    already.focus()

    fireEvent.keyDown(already, { key: 'ArrowDown' })
    expect(screen.getByRole('radio', { name: /Linux 一键部署/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByRole('radio', { name: /Linux 一键部署/ }), { key: 'ArrowUp' })
    expect(already).toHaveAttribute('aria-checked', 'true')
    // End 跳末项
    fireEvent.keyDown(already, { key: 'End' })
    expect(screen.getByRole('radio', { name: /Windows 手动部署/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('点击非选中项后 roving tabindex 随之迁移（组内恒好一个 Tab 停靠点）', () => {
    render(<OnboardingPage />)
    const group = screen.getByRole('radiogroup', { name: '部署方式' })
    fireEvent.click(screen.getByRole('radio', { name: /Windows 手动部署/ }))

    const stops = within(group)
      .getAllByRole('radio')
      .filter((el) => el.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAccessibleName(/Windows 手动部署/)
  })

  it('方向键之外的按键不抢：选中态不动，且不吞掉默认行为', () => {
    render(<OnboardingPage />)
    const already = screen.getByRole('radio', { name: /已有服务端/ })
    already.focus()
    fireEvent.keyDown(already, { key: 'a' })
    expect(already).toHaveAttribute('aria-checked', 'true')
    // preventDefault 只对已识别的方向键触发；误吞 Tab 会让键盘用户出不了组
    expect(fireEvent.keyDown(already, { key: 'Tab' })).toBe(true)
  })
})

describe('OnboardingPage · 命令复制反馈', () => {
  it('复制成功 → toast.success', async () => {
    copyTextMock.mockResolvedValue(true)
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('radio', { name: /Linux 一键部署/ }))
    fireEvent.click(screen.getByRole('button', { name: '复制部署命令' }))
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('命令已复制', { duration: 1500 }), {
      // vi.waitFor 有独立的硬编码 1s 上限，不读 RTL 的 asyncUtilTimeout（J58）
      timeout: 5000,
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('复制失败 → toast.error 引导手动复制', async () => {
    copyTextMock.mockResolvedValue(false)
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('radio', { name: /Linux 一键部署/ }))
    fireEvent.click(screen.getByRole('button', { name: '复制部署命令' }))
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('复制失败，请手动复制'), {
      // 同上：vi.waitFor 不吃全局 RTL 上限
      timeout: 5000,
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})

describe('OnboardingPage · 完成路径（连接保存）', () => {
  it('ConnectionForm 以 onboarding variant 挂载', () => {
    render(<OnboardingPage />)
    expect(screen.getByTestId('connection-form')).toHaveAttribute('data-variant', 'onboarding')
  })

  it('保存成功 → 欢迎 toast + 跳转 /dashboard（完成路径）', () => {
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }))
    expect(toastSuccess).toHaveBeenCalledWith('欢迎使用，已进入管理面板')
    expect(navigateSpy).toHaveBeenCalledWith('/dashboard')
  })
})
