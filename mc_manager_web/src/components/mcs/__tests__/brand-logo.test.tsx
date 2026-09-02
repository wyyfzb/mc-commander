import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BrandLogo } from '../brand-logo'

/**
 * BrandLogo 品牌图标测试：装饰/语义两态与品牌 token 应用
 */

describe('BrandLogo', () => {
  it('默认装饰态：aria-hidden，无 role', () => {
    const { container } = render(<BrandLogo className="size-5" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('role')).toBeNull()
  })

  it('传入 label 时语义态：role=img + aria-label（onboarding 用）', () => {
    const { container } = render(<BrandLogo label="MC Commander Logo" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('role')).toBe('img')
    expect(svg?.getAttribute('aria-label')).toBe('MC Commander Logo')
    expect(svg?.getAttribute('aria-hidden')).toBeNull()
  })

  it('命令符/光标组应用品牌 accent token（text-mcs-accent-fg）', () => {
    const { container } = render(<BrandLogo />)
    const accentGroup = container.querySelector('svg g.text-mcs-accent-fg')
    expect(accentGroup).toBeTruthy()
  })
})
