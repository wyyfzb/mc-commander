/**
 * OnboardingPage 行为级补测（issue 433）
 * - 跳过类：「已有服务端」默认态——部署指南不渲染，直连表单就位
 * - 推进类：部署方式切换——指南块内容随选择渲染（Windows 手动步骤 / Docker 边界说明 / 手动脚本+要点）
 * - 完成类：连接表单保存成功 → 欢迎 toast + navigate('/dashboard')
 * - 附属：命令复制成功/失败反馈、ConnectionForm variant 透传
 * ConnectionForm 以轻量桩替代（其自身行为由 settings 域测试覆盖）；数据全虚构
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
  it('渲染标题 + 四部署方式卡 + 连接表单 + 部署文档链接', () => {
    render(<OnboardingPage />)
    expect(screen.getByText('欢迎使用 MC Commander')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /已有服务端/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Windows 部署/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Docker/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /手动（Node 22\+）/ })).toBeInTheDocument()
    expect(screen.getByTestId('connection-form')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← 返回登录页' })).toHaveAttribute('href', '/login')
    expect(screen.getByRole('link', { name: '查看部署文档 →' })).toHaveAttribute('href', 'https://gitee.com/wyyfzb/mc-commander')
  })

  it('默认选中「已有服务端」且部署指南不渲染（跳过路径）', () => {
    render(<OnboardingPage />)
    const already = screen.getByRole('button', { name: /已有服务端/ })
    expect(already).toHaveAttribute('aria-pressed', 'true')
    // 三种指南均未出现
    expect(screen.queryByText('Windows 手动部署（Node 22+）')).not.toBeInTheDocument()
    expect(screen.queryByText('Docker：暂不提供')).not.toBeInTheDocument()
    expect(screen.queryByText('Linux 一键部署命令')).not.toBeInTheDocument()
  })
})

describe('OnboardingPage · 部署方式推进', () => {
  it('切换到 Windows 一键包：卡片选中态迁移 + 步骤指南渲染', () => {
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('button', { name: /Windows 部署/ }))
    expect(screen.getByRole('button', { name: /Windows 部署/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /已有服务端/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Windows 手动部署（Node 22+）')).toBeInTheDocument()
    expect(screen.getByText(/nodejs\.org/)).toBeInTheDocument()
    expect(screen.getByText(/Copy-Item \.env\.example \.env/)).toBeInTheDocument()
    expect(screen.getByText(/localhost:25566/)).toBeInTheDocument()
    // 发布物没有 Windows 包，页面必须把这一点说清而不是指引下载
    expect(screen.getByText(/未提供 Windows 一键包/)).toBeInTheDocument()
  })

  it('切换到 Docker：只说明不做容器化的边界，不给可执行命令', () => {
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('button', { name: /Docker/ }))
    expect(screen.getByText('Docker：暂不提供')).toBeInTheDocument()
    expect(screen.getByText(/不做容器化/)).toBeInTheDocument()
    // ghcr.io 镜像不存在，命令随之移除：首访页不得给出跑不通的命令
    expect(screen.queryByText(/ghcr\.io/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /复制 Docker/ })).not.toBeInTheDocument()
  })

  it('切换到手动部署：一键脚本 + 三条要点清单', () => {
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('button', { name: /手动（Node 22\+）/ }))
    expect(screen.getByText('Linux 一键部署命令')).toBeInTheDocument()
    expect(screen.getByText(/deploy-mc-commander\.sh/)).toBeInTheDocument()
    expect(screen.getByText(/自动安装 Java 17\/21\/25/)).toBeInTheDocument()
    expect(screen.getByText(/妥善保存/)).toBeInTheDocument()
    expect(screen.getByText(/25566 端口/)).toBeInTheDocument()
  })

  it('指南块随选择互斥：切回「已有服务端」指南消失', () => {
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('button', { name: /Docker/ }))
    expect(screen.getByText('Docker：暂不提供')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /已有服务端/ }))
    expect(screen.queryByText('Docker：暂不提供')).not.toBeInTheDocument()
  })
})

describe('OnboardingPage · 命令复制反馈', () => {
  it('复制成功 → toast.success', async () => {
    copyTextMock.mockResolvedValue(true)
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('button', { name: /手动（Node 22\+）/ }))
    fireEvent.click(screen.getByRole('button', { name: '复制部署命令' }))
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('命令已复制', { duration: 1500 }))
    expect(toastError).not.toHaveBeenCalled()
  })

  it('复制失败 → toast.error 引导手动复制', async () => {
    copyTextMock.mockResolvedValue(false)
    render(<OnboardingPage />)
    fireEvent.click(screen.getByRole('button', { name: /手动（Node 22\+）/ }))
    fireEvent.click(screen.getByRole('button', { name: '复制部署命令' }))
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('复制失败，请手动复制'))
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
