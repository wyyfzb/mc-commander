import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { DeploySuccessView } from '@/features/instances/components/deploy/views'
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
  const hit = banners.find((b) => /服务器进程已启动|自动启动失败/.test(b.textContent))
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

/** 找「未同意 EULA，故未启动」那条横幅（role=status）——只在 未同意 EULA 时存在 */
function eulaBanner(container: HTMLElement): HTMLElement {
  const banners = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
  const hit = banners.find((b) => b.textContent?.includes('EULA'))
  if (!hit) throw new Error('未找到未启动提示块')
  return hit
}

function renderWith(eulaAgreed: boolean, started = eulaAgreed) {
  return render(
    <DeploySuccessView
      result={{ ...RESULT, started }}
      eulaAgreed={eulaAgreed}
      onComplete={vi.fn()}
    />,
  )
}

describe('DeploySuccessView 自动启动状态块', () => {
  it('仅确认进程已启动，使用中性档并指向实例卡片查就绪', () => {
    const { container } = renderWith(true)
    const banner = autoStartBanner(container)
    expect(banner).toHaveTextContent('服务器进程已启动，是否就绪请在实例卡片上查看。')
    expect(banner.className).toContain('bg-mcs-bg-muted')
    expect(banner.className).not.toContain('border-l-2')
  })

  it('已同意 EULA 但进程未拉起时提示手动启动', () => {
    const { container } = renderWith(true, false)
    const banner = autoStartBanner(container)
    expect(banner).toHaveTextContent('自动启动失败，可稍后在实例页手动启动')
    expect(banner.className).toContain('border-l-mcs-warning-fg')
  })

  it('未同意 EULA 时不报自动启动失败', () => {
    const { container } = renderWith(false)
    expect(eulaBanner(container)).toHaveTextContent('服务器尚未启动')
    expect(() => autoStartBanner(container)).toThrow()
  })

  it('白名单提示：info 档（还差一步而非告警）+ 说清默认已开/空名单进不去/出路在玩家页，且排在启动状态之后', () => {
    const { container } = renderWith(true)
    const banner = whitelistBanner(container)

    // 「还差一步」不是故障：与同屏「未同意 EULA」那条同档（info），不得落到 warning/error
    expect(banner.className).toContain('border-l-mcs-info-fg')
    expect(banner.className).not.toContain('border-l-mcs-warning-fg')
    expect(banner.className).not.toContain('border-l-mcs-error-fg')
    // 单句走默认 bar 形态 ⇒ 正文档 xs；完整句子最低 xs，不得落到 2xs 角标档
    expect(banner.className).toContain('text-mcs-xs')

    const text = banner.textContent ?? ''
    expect(text).toContain('默认开启白名单')
    expect(text).toContain('名单为空时任何玩家都无法进入')
    expect(text).toContain('玩家页')
    // 出路必须是**此刻做得到**的：加白名单入口走 RCON，服务器没起来时那个按钮是禁用的，
    // 而未就绪时缺「服务器启动后」就等于
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

  it('未同意 EULA 时同屏两条 info 档横幅靠图标区分语义（同图标同导轨会被读成一条两块）', () => {
    const { container } = renderWith(false)
    const eulaIcon = eulaBanner(container).querySelector('svg')?.outerHTML
    const whitelistIcon = whitelistBanner(container).querySelector('svg')?.outerHTML
    expect(eulaIcon).toBeTruthy()
    expect(whitelistIcon).toBeTruthy()
    // 两条导轨都是 info 蓝，颜色区分不了它们，唯一的区分手段就是图标语义
    expect(eulaBanner(container).className).toContain('border-l-mcs-info-fg')
    expect(whitelistBanner(container).className).toContain('border-l-mcs-info-fg')
    expect(whitelistIcon).not.toBe(eulaIcon)
  })
})
