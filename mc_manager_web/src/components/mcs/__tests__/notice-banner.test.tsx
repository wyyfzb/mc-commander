/**
 * NoticeBanner 语义色契约：四档变体的底/边/前景是同档三元组，档位不与语义名串色。
 * 断言的是**类族契约**——「四档必须来自 tone.ts」由静态门禁（check-design-tokens）保证，
 * 本用例区分不了「调用 toneClasses」与「照抄一份恰好相同的字面量」
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { NoticeBanner } from '../notice-banner'

const VARIANTS = ['info', 'warning', 'error', 'success'] as const

describe('NoticeBanner', () => {
  it('四档变体各带同档 border / bg-subtle / fg，且档位与语义名一致', () => {
    for (const variant of VARIANTS) {
      const { container } = render(<NoticeBanner variant={variant}>提示内容</NoticeBanner>)
      const el = container.firstElementChild as HTMLElement
      expect(el.className, variant).toContain(`border-mcs-${variant}-border`)
      expect(el.className, variant).toContain(`bg-mcs-${variant}-bg-subtle`)
      expect(el.className, variant).toContain(`text-mcs-${variant}-fg`)
    }
  })
})
