/**
 * DeploySuccessView 的自动启动状态块（三档：pending / ok / failed）。
 *
 * 单独测这个视图而不走 DeployDialog：三档由 `autoStart` prop 直接决定，走全流程只能
 * 到达其中一两档（pending 需服务端首启未回、failed 需自动启动报错），
 * 而色档恰恰是「文案对、颜色错」这类缺陷唯一的暴露面。
 * 断言色类而非文案存在性——本处曾把 pending 染成 info 前景（文案对、颜色错），
 * 存在性断言抓不到。
 */
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { DeploySuccessView } from '../deploy/views'
import type { AutoStartState } from '../deploy/types'
import type { DeployResult } from '@/api/types'

const RESULT: DeployResult = {
  id: 'inst-deploy-001',
  name: '测试生存服',
  type: 'fabric',
  mcVersion: '1.21.4',
} as DeployResult

/** 找承载 autoStart 文案的那条横幅（role=status） */
function autoStartBanner(container: HTMLElement): HTMLElement {
  const banners = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
  const hit = banners.find((b) => /正在启动服务器|已发送启动指令|自动启动失败/.test(b.textContent))
  if (!hit) throw new Error('未找到自动启动状态块')
  return hit
}

function renderWith(autoStart: AutoStartState) {
  return render(<DeploySuccessView result={RESULT} autoStart={autoStart} onComplete={vi.fn()} />)
}

describe('DeploySuccessView 自动启动状态块', () => {
  it('pending 走中性档：既非成功也非失败，不得染成任一语义色', () => {
    const { container } = renderWith('pending')
    const banner = autoStartBanner(container)
    expect(banner.className).toContain('border-mcs-border-muted')
    expect(banner.className).toContain('bg-mcs-bg-muted')
    expect(banner.className).toContain('text-mcs-text-muted')
    // info 蓝是最像「合理」的错档（在途≈提示），特别钉死
    expect(banner.className).not.toContain('text-mcs-info-fg')
    expect(banner.className).not.toContain('bg-mcs-info-bg-subtle')
  })

  it('pending 的加载图标必须在转：spinner 静止则「在途」无任何动效表达', () => {
    const { container } = renderWith('pending')
    const icon = autoStartBanner(container).querySelector('svg')
    expect(icon?.getAttribute('class')).toContain('animate-spin')
  })

  it('ok 走 success 档、failed 走 warning 档，两档互不串色', () => {
    const ok = renderWith('ok')
    expect(autoStartBanner(ok.container).className).toContain('border-mcs-success-border')
    expect(autoStartBanner(ok.container).className).not.toContain('border-mcs-warning-border')

    const failed = renderWith('failed')
    expect(autoStartBanner(failed.container).className).toContain('border-mcs-warning-border')
    expect(autoStartBanner(failed.container).className).not.toContain('border-mcs-success-border')
  })

  it('autoStart=null（未勾选 EULA）不渲染状态块', () => {
    const { container } = renderWith(null)
    expect(() => autoStartBanner(container)).toThrow()
  })
})
