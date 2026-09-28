/**
 * NoticeBanner 语义色契约：四档变体的底/边/前景是同档三元组，档位不与语义名串色。
 * 两形态（bar / card）的内距与图标对齐各一套，且 card 必须能承载块级 children。
 * 断言的是**类族契约**——「四档必须来自 tone.ts」由静态门禁（check-design-tokens）保证，
 * 本用例区分不了「调用 toneClasses」与「照抄一份恰好相同的字面量」
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Loader2 } from 'lucide-react'
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

  it('两形态载荷不同的内距/字号/图标对齐：bar 是元数据级短语、card 是正文块', () => {
    const bar = render(<NoticeBanner variant="info">短语</NoticeBanner>).container
      .firstElementChild as HTMLElement
    const card = render(
      <NoticeBanner variant="info" form="card">
        <p>正文</p>
      </NoticeBanner>,
    ).container.firstElementChild as HTMLElement

    // 内距与字号成对：条走紧凑档、卡走正文档
    expect(bar.className).toContain('px-2.5')
    expect(bar.className).toContain('py-1.5')
    expect(bar.className).toContain('text-mcs-xs')
    expect(card.className).toContain('p-3')
    expect(card.className).toContain('text-mcs-sm')

    // 图标对齐随内容形态：卡会折行故贴首行（items-start），条是单行故居中
    expect(bar.className).toContain('items-center')
    expect(card.className).toContain('items-start')
  })

  it('card 承载块级 children 不产生 span>div 无效嵌套', () => {
    const { container } = render(
      <NoticeBanner variant="warning" form="card">
        <div>块级内容</div>
      </NoticeBanner>,
    )
    // 内容槽位必须是 div：span 里塞 div 会被浏览器重排，DOM 结构与源码意图不符
    const slot = container.querySelector('.min-w-0')
    expect(slot?.tagName).toBe('DIV')
    expect(slot?.querySelector('div')).not.toBeNull()
  })

  it('neutral 档三件套全取中性面，不带任何语义色', () => {
    // 在途态用它（正在启动/正在部署）：染成任一语义色都会读成「有消息要看」
    const { container } = render(<NoticeBanner variant="neutral">正在启动…</NoticeBanner>)
    const cls = (container.firstElementChild as HTMLElement).className
    expect(cls).toContain('border-mcs-border-muted')
    expect(cls).toContain('bg-mcs-bg-muted')
    expect(cls).toContain('text-mcs-text-muted')
    // 语义档一个都不许混进来（VARIANT_CLASSES 是按档取整串的，混入说明档表写错）
    for (const tone of VARIANTS) {
      expect(cls, tone).not.toContain(`text-mcs-${tone}-fg`)
      expect(cls, tone).not.toContain(`bg-mcs-${tone}-bg-subtle`)
    }
  })

  it('iconClassName 追加到图标而非根节点（在途态的 animate-spin 落点）', () => {
    const { container } = render(
      <NoticeBanner variant="neutral" icon={Loader2} iconClassName="animate-spin">
        在途
      </NoticeBanner>,
    )
    const root = container.firstElementChild as HTMLElement
    const icon = root.querySelector('svg')
    expect(icon?.getAttribute('class')).toContain('animate-spin')
    // 根节点不得带上它：动画落在整条横幅上会连边框一起脉冲
    expect(root.className).not.toContain('animate-spin')
  })
})
