/**
 * 危险语义色「唯一声明源＝变体」契约
 *
 * 背景：危险按钮的着色（描边 + 文字，浅档另加悬停底）只在 `components/ui/button.tsx` 的
 * variant 里声明一份。曾经的现场是在调用点写 `variant="outline"` + `className="border-mcs-error-border
 * text-mcs-error-fg …"` —— 双轨并存时改一次危险色必然静默掉队，
 * 而对比度门禁只看 token 定义、结构上发现不了这类绕过。
 *
 * 本用例守两件事（新增危险按钮时请在此补一条）：
 * 1. 两档危险变体各自的语义边界：实底档常驻危险底，浅档只在悬停出现危险底；
 * 2. 已收编的调用点不得回退成手写色类。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button, buttonVariants } from '@/components/ui/button'

/** mc_manager_web/（本文件位于 src/components/ui/__tests__/） */
const WEB_DIR = join(import.meta.dirname, '..', '..', '..', '..')

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean)
}

/** 弱档危险描边：25% 装饰线，不得作为控件边界（`-strong` 是它的后缀扩展，须排除） */
const WEAK_ERROR_BORDER = /border-mcs-error-border(?!-strong)/

/** 浅档现场：低频危险次操作（删除 / 踢出 / 清空背包 / 告警条内的修复动作） */
const SHALLOW_CALL_SITES = [
  'src/features/players/components/batch-bar.tsx',
  'src/features/players/components/overview-actions.tsx',
  'src/features/webhooks/webhook-page.tsx',
  'src/layouts/degradation-banners.tsx',
]

describe('危险按钮变体（唯一声明源）', () => {
  it('浅档 destructive-outline：危险描边 + 危险文字，危险底只在悬停出现（明暗两态都成立）', () => {
    const cls = tokens(buttonVariants({ variant: 'destructive-outline' }))
    expect(cls).toContain('border-mcs-error-border-strong')
    expect(cls).toContain('text-mcs-error-fg')
    expect(cls).toContain('hover:bg-mcs-state-hover-error')
    // 悬停必须走覆盖层档，不得回落到内容面 tint（*-bg-subtle 承载文字，按
    // 「交互悬浮只走覆盖层」不得当 hover 态用——基座破例会被调用点忠实复制）
    expect(cls).not.toContain('hover:bg-mcs-error-bg-subtle')
    // 面与中性次操作同源（--mcs-bg-secondary 即 chip 面），不因换档而退掉按钮面
    expect(cls).toContain('bg-mcs-bg-secondary')
    // 面档必须走 token：dark: 前缀类在 ui/ 外被门禁拦，且它排在 hover:* 之后会吃掉悬停危险底
    expect(cls.filter((c) => c.startsWith('dark:'))).toEqual([])
    // 浅档的边界：不得常驻危险底、不得带实底档的辉光（否则低频次操作被升格成实底红）
    expect(cls).not.toContain('bg-mcs-error-bg-subtle')
    expect(cls).not.toContain('hover:shadow-mcs-glow-error')
  })

  it('实底档 destructive 与浅档分工不重叠：常驻危险底 + 辉光', () => {
    const solid = tokens(buttonVariants({ variant: 'destructive' }))
    expect(solid).toContain('bg-mcs-error-bg-subtle')
    expect(solid).toContain('border-mcs-error-border-strong')
    expect(solid).toContain('hover:shadow-mcs-glow-error')
    expect(solid).not.toContain('border-mcs-error-border')
  })

  it('渲染时 data-variant 落到 DOM（结构可断言，不依赖色值计算）', () => {
    render(<Button variant="destructive-outline">删除</Button>)
    const btn = screen.getByRole('button', { name: '删除' })
    expect(btn).toHaveAttribute('data-variant', 'destructive-outline')
    expect(tokens(btn.className)).toContain('border-mcs-error-border-strong')
  })

  it('实例卡「停止」走实底档（中断服务的后果重于导航）', () => {
    const code = readFileSync(
      join(WEB_DIR, 'src/features/instances/components/instance-cards.tsx'),
      'utf-8',
    )
    expect(code).toContain('variant="destructive"')
  })

  it.each(SHALLOW_CALL_SITES)('%s 走浅档变体，未回退手写危险描边', (relPath) => {
    const code = readFileSync(join(WEB_DIR, relPath), 'utf-8')
    expect(code).toContain('variant="destructive-outline"')
    expect(WEAK_ERROR_BORDER.test(code), `${relPath} 仍手写弱档危险描边`).toBe(false)
  })
})
