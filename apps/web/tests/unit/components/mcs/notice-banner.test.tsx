/**
 * NoticeBanner 语义色契约：四档语义只落在左缘导轨与图标，容器面始终中性；
 * 两形态（bar / card）的内距与图标对齐各一套，且 card 必须能承载块级 children。
 * 断言的是**类族契约**——「四档必须来自 token」由静态门禁（check-design-tokens）保证，
 * 本用例区分不了「引用 token」与「照抄一份恰好相同的字面量」
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Info, Loader2 } from 'lucide-react'
import { NoticeBanner, NoticeBannerAction } from '@/components/mcs/notice-banner'

const VARIANTS = ['info', 'warning', 'error', 'success'] as const

describe('NoticeBanner', () => {
  it('四档变体各带同档导轨/图标，容器面保持中性', () => {
    for (const variant of VARIANTS) {
      const { container } = render(
        <NoticeBanner variant={variant} icon={Info}>
          提示内容
        </NoticeBanner>,
      )
      const el = container.firstElementChild as HTMLElement
      expect(el.className, variant).toContain('border-mcs-border-container')
      expect(el.className, variant).toContain('bg-mcs-bg-muted')
      expect(el.className, variant).toContain('text-mcs-text-default')
      // 语义色只落在左缘导轨与图标两处，不得回到满宽内容面 tint
      expect(el.className, variant).toContain('border-l-2')
      expect(el.className, variant).toContain(`border-l-mcs-${variant}-fg`)
      const icon = el.querySelector('svg') as SVGElement
      expect(icon.getAttribute('class'), variant).toContain(`text-mcs-${variant}-fg`)
      expect(el.className, variant).not.toContain(`bg-mcs-${variant}-bg-subtle`)
      expect(el.className, variant).not.toContain(`text-mcs-${variant}-fg`)
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

  it('语义档不传 icon 时仍有默认图标：严重度不得只靠 2px 颜色轨', () => {
    for (const variant of VARIANTS) {
      const { container } = render(<NoticeBanner variant={variant}>提示</NoticeBanner>)
      const root = container.firstElementChild as HTMLElement
      const icon = root.querySelector('svg') as SVGElement
      expect(icon, variant).not.toBeNull()
      expect(icon.getAttribute('class'), variant).toContain(`text-mcs-${variant}-fg`)
    }
  })

  it('neutral 档连导轨也不给，不带任何语义色', () => {
    // 在途态用它（正在启动/正在部署）：染成任一语义色都会读成「有消息要看」
    const { container } = render(<NoticeBanner variant="neutral">正在启动…</NoticeBanner>)
    const el = container.firstElementChild as HTMLElement
    const cls = el.className
    expect(cls).toContain('border-mcs-border-container')
    expect(cls).toContain('bg-mcs-bg-muted')
    expect(cls).toContain('text-mcs-text-default')
    expect(cls).not.toContain('border-l-2')
    expect(el.querySelector('svg')).toBeNull()
    // 语义档一个都不许混进来（档表是按档取整串的，混入说明档表写错）
    for (const tone of VARIANTS) {
      expect(cls, tone).not.toContain(`text-mcs-${tone}-fg`)
      expect(cls, tone).not.toContain(`border-l-mcs-${tone}-fg`)
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

  it('横幅内动作按钮显式中性文字色，不随横幅语义档变化', () => {
    // 按钮基座不声明文字色，会继承横幅根节点；显式中性让按钮配方不随横幅语义色变化。
    const { container } = render(
      <NoticeBanner variant="error">
        <NoticeBannerAction onClick={() => {}}>重试</NoticeBannerAction>
      </NoticeBanner>,
    )
    const btn = container.querySelector('button')!
    const classes = new Set(btn.className.split(/\s+/))
    expect(classes.has('text-mcs-text-default')).toBe(true)
    expect(btn.className).not.toContain('text-mcs-error-fg')
    // 面必须是实底页面面（横幅底是中性容器面，透明按钮会与它融成一片）
    expect(classes.has('bg-mcs-bg-default!')).toBe(true)
    // 描边静止/悬停都固定中性档：基座的 hover:border-foreground/25 落到 error tint
    // 上实测 2.15:1（亮色 1.63:1），跌破交互边界 3:1
    expect(classes.has('border-mcs-border-default!')).toBe(true)
    expect(classes.has('hover:border-mcs-border-default!')).toBe(true)
  })
})
