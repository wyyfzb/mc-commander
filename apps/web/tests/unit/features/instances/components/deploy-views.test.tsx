/**
 * DeploySuccessView 的自动启动状态块（三档：pending / ok / failed）与白名单提示（info 档、
 * 三件事齐全且出路带「服务器启动后」前置、排在状态块之后、与同屏 EULA 条靠图标区分）。
 *
 * 单独测这个视图而不走 DeployDialog：三档由 `autoStart` prop 直接决定，走全流程只能
 * 到达其中一两档（pending 需服务端首启未回、failed 需自动启动报错），
 * 而色档恰恰是「文案对、颜色错」这类缺陷唯一的暴露面。
 * 断言色类而非文案存在性——本处曾把 pending 染成 info 前景（文案对、颜色错），
 * 存在性断言抓不到。
 */
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { DeploySuccessView } from '@/features/instances/components/deploy/views'
import type { AutoStartState } from '@/features/instances/components/deploy/types'
import type { DeployResult } from '@/api/types'

const RESULT: DeployResult = {
  id: 'inst-deploy-001',
  name: '测试生存服',
  type: 'fabric',
  mcVersion: '1.21.4',
  javaVersion: '21',
  path: '/opt/mc/instances/inst-deploy-001',
  maxMemory: '2G',
  warnings: [],
  started: true,
}

/** 找承载 autoStart 文案的那条横幅（role=status） */
function autoStartBanner(container: HTMLElement): HTMLElement {
  const banners = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
  const hit = banners.find((b) => /正在启动服务器|已发送启动指令|自动启动失败/.test(b.textContent))
  if (!hit) throw new Error('未找到自动启动状态块')
  return hit
}

/** 找白名单提示那条横幅（role=status） */
function whitelistBanner(container: HTMLElement): HTMLElement {
  const banners = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
  const hit = banners.find((b) => b.textContent?.includes('白名单'))
  if (!hit) throw new Error('未找到白名单提示块')
  return hit
}

/** 找「未同意 EULA，故未启动」那条横幅（role=status）——只在 autoStart=null 时存在 */
function eulaBanner(container: HTMLElement): HTMLElement {
  const banners = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
  const hit = banners.find((b) => b.textContent?.includes('EULA'))
  if (!hit) throw new Error('未找到未启动提示块')
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

  it('白名单提示：info 档（还差一步而非告警）+ 说清默认已开/空名单进不去/出路在玩家页，且排在启动状态之后', () => {
    const { container } = renderWith('ok')
    const banner = whitelistBanner(container)

    // 「还差一步」不是故障：与同屏「未同意 EULA」那条同档（info），不得落到 warning/error
    expect(banner.className).toContain('border-mcs-info-border')
    expect(banner.className).not.toContain('border-mcs-warning-border')
    expect(banner.className).not.toContain('border-mcs-error-border')
    // 单句走默认 bar 形态 ⇒ 正文档 xs；完整句子最低 xs，不得落到 2xs 角标档
    expect(banner.className).toContain('text-mcs-xs')

    const text = banner.textContent ?? ''
    expect(text).toContain('默认开启白名单')
    expect(text).toContain('名单为空时任何玩家都无法进入')
    expect(text).toContain('玩家页')
    // 出路必须是**此刻做得到**的：加白名单入口走 RCON，服务器没起来时那个按钮是禁用的，
    // 而本视图在 autoStart=null/failed 时恰好就是没起来的状态 ⇒ 缺「服务器启动后」就等于
    // 教用户做一件当场做不到的事，还与相邻那条「先到实例页点启动」互相打架。
    expect(text).toContain('服务器启动后')
    // 点名控件（同屏既有横幅的口径是「点『启动』」，只说到页面名可发现性不足）
    expect(text).toContain('添加白名单')
    // 可见文案只讲用户要做什么：不出现配置键名与运维视角字段（与设置弹窗同口径）
    expect(text).not.toMatch(/white-list|enforce-whitelist|server\.properties|端口|host/i)

    // 主动作（部署成功 + 启动状态）在前，白名单是进入前的最后一步 ⇒ 必须排在其后
    const order = autoStartBanner(container).compareDocumentPosition(banner)
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('autoStart=null 时同屏两条 info 档横幅靠图标区分语义（同图标同 tint 会被读成一条两块）', () => {
    const { container } = renderWith(null)
    const eulaIcon = eulaBanner(container).querySelector('svg')?.outerHTML
    const whitelistIcon = whitelistBanner(container).querySelector('svg')?.outerHTML
    expect(eulaIcon).toBeTruthy()
    expect(whitelistIcon).toBeTruthy()
    // 两条都是 info 蓝，颜色区分不了它们，唯一的区分手段就是图标语义
    expect(eulaBanner(container).className).toContain('border-mcs-info-border')
    expect(whitelistBanner(container).className).toContain('border-mcs-info-border')
    expect(whitelistIcon).not.toBe(eulaIcon)
  })
})
