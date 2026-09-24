/**
 * Card 基座测试：
 * - 卡片面四件套类存在（圆角/描边/卡片底色/卡阴影）
 * - className 透传且不被吞（布局与内边距档位由调用点持有）
 * - className 可覆盖基座同名属性（底色/描边按内容语义走），被覆盖基座类不残留
 * - as 保留调用点元素语义（section/div/main/button）
 * - CardHeader/CardTitle/CardBody 子块：默认类、className 透传、CardTitle 层级与两个角色配方（字号/字重/文字色）
 * mock 数据全部为测试占位，无真实服务器信息
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Card, CardBody, CardHeader, CardTitle } from '../card'

const SURFACE = [
  'rounded-mcs-md',
  'border',
  'border-mcs-border-muted',
  'bg-mcs-bg-muted',
  'shadow-mcs-card',
]

describe('Card', () => {
  it('默认渲染 section 并输出卡片面四件套类', () => {
    const { container } = render(<Card>内容</Card>)
    const el = container.querySelector('section') as HTMLElement
    expect(el).not.toBeNull()
    for (const c of SURFACE) expect(el.classList.contains(c)).toBe(true)
    expect(el.textContent).toBe('内容')
  })

  it('className 透传：布局与内边距类与基座类共存，不被吞', () => {
    const { container } = render(<Card className="flex min-w-0 flex-col gap-3 p-4">内容</Card>)
    const el = container.querySelector('section') as HTMLElement
    for (const c of ['flex', 'min-w-0', 'flex-col', 'gap-3', 'p-4', ...SURFACE]) {
      expect(el.classList.contains(c)).toBe(true)
    }
  })

  it('className 覆盖基座同名属性：调用点胜出且被覆盖的基座类不残留', () => {
    const { container } = render(
      <Card className="border-mcs-accent-border bg-mcs-bg-default p-5">内容</Card>,
    )
    const el = container.querySelector('section') as HTMLElement
    expect(el.classList.contains('border-mcs-accent-border')).toBe(true)
    expect(el.classList.contains('bg-mcs-bg-default')).toBe(true)
    expect(el.classList.contains('border-mcs-border-muted')).toBe(false)
    expect(el.classList.contains('bg-mcs-bg-muted')).toBe(false)
    // 未冲突的基座类保留
    expect(el.classList.contains('rounded-mcs-md')).toBe(true)
    expect(el.classList.contains('shadow-mcs-card')).toBe(true)
  })

  it('as 保留调用点元素语义（div/main/button）', () => {
    const { container } = render(
      <>
        <Card as="div">块</Card>
        <Card as="main">登录卡</Card>
        <Card as="button" type="button" role="radio" aria-checked>
          单选卡
        </Card>
      </>,
    )
    expect(container.querySelector('div')).not.toBeNull()
    expect(container.querySelector('main')).not.toBeNull()
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.getAttribute('role')).toBe('radio')
    expect(button.getAttribute('aria-checked')).toBe('true')
  })

  it('role/aria/data-* 钩子透传', () => {
    const { container } = render(
      <Card aria-label="统计加载中" role="status" data-testid="card-hook" data-instance-id="demo-1">
        内容
      </Card>,
    )
    const el = container.querySelector('[data-testid="card-hook"]') as HTMLElement
    expect(el).not.toBeNull()
    expect(el.getAttribute('aria-label')).toBe('统计加载中')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.dataset.instanceId).toBe('demo-1')
  })
})

describe('Card 子块', () => {
  it('CardHeader 输出横向居中标题行，className 追加', () => {
    const { container } = render(
      <CardHeader className="justify-between gap-2">
        <CardTitle>在线玩家</CardTitle>
      </CardHeader>,
    )
    const header = container.querySelector('header') as HTMLElement
    for (const c of ['flex', 'items-center', 'justify-between', 'gap-2']) {
      expect(header.classList.contains(c)).toBe(true)
    }
  })

  it('CardTitle 默认 h3，as 可指定层级，默认角色＝区块/内容标题配方（lg + semibold + default）', () => {
    const { container } = render(
      <>
        <CardTitle>默认层级</CardTitle>
        <CardTitle as="h2">页内层级</CardTitle>
      </>,
    )
    const h3 = container.querySelector('h3') as HTMLElement
    expect(h3.textContent).toBe('默认层级')
    // 配方三项齐全：字号档之外，字重与文字色也算配方（缺一项即与手写 h3 lg 不同观感）
    for (const c of ['text-mcs-lg', 'font-semibold', 'text-mcs-text-default']) {
      expect(h3.classList.contains(c)).toBe(true)
    }
    // 默认不再落标签档配方：真区块标题与数据卡标签行必须分档
    for (const c of ['text-mcs-sm', 'font-medium', 'text-mcs-text-muted']) {
      expect(h3.classList.contains(c)).toBe(false)
    }
    expect(container.querySelector('h2')).not.toBeNull()
  })

  it('CardTitle variant="label"（数据卡标签行）维持标签档配方（sm + medium + muted），三项都不得升档', () => {
    const { container } = render(
      <>
        <CardTitle>区块标题</CardTitle>
        <CardTitle as="h2" variant="label">
          数据卡标签
        </CardTitle>
      </>,
    )
    const heading = container.querySelector('h3') as HTMLElement
    const label = container.querySelector('h2') as HTMLElement
    for (const c of ['text-mcs-sm', 'font-medium', 'text-mcs-text-muted']) {
      expect(label.classList.contains(c)).toBe(true)
    }
    for (const c of ['text-mcs-lg', 'font-semibold', 'text-mcs-text-default']) {
      expect(label.classList.contains(c)).toBe(false)
      expect(heading.classList.contains(c)).toBe(true)
    }
  })

  it('CardTitle className 覆盖字号档（同组后写者胜），基座色档不被吞', () => {
    const { container } = render(<CardTitle className="text-mcs-2xs">小标题</CardTitle>)
    const el = container.querySelector('h3') as HTMLElement
    expect(el.classList.contains('text-mcs-2xs')).toBe(true)
    expect(el.classList.contains('text-mcs-lg')).toBe(false)
    expect(el.classList.contains('text-mcs-text-default')).toBe(true)
  })

  it('CardBody 零默认类：只带调用点给的类（基座不得改调用点布局）', () => {
    const { container } = render(<CardBody className="px-4 py-2">内容体</CardBody>)
    const el = container.querySelector('div') as HTMLElement
    expect([...el.classList].sort()).toEqual(['px-4', 'py-2'])
  })
  it('size 缺省时不给内距（基座代劳会把全站既有卡推离现状）', () => {
    const { container } = render(<Card>x</Card>)
    const el = container.querySelector('section') as HTMLElement
    expect([...el.classList].some((c) => /(^|:)p-\d/.test(c))).toBe(false)
    expect(el.classList.contains('shadow-mcs-card')).toBe(true)
  })

  it('size 取档＝CARD_SIZE_CLASSES 的档；className 的 p-* 仍覆盖它', () => {
    const { container } = render(
      <div>
        <Card size="compact" data-testid="a">
          x
        </Card>
        <Card size="panel" className="p-2" data-testid="b">
          x
        </Card>
      </div>,
    )
    const a = container.querySelector('[data-testid="a"]') as HTMLElement
    expect(a.classList.contains('p-3')).toBe(true)
    const b = container.querySelector('[data-testid="b"]') as HTMLElement
    expect(b.classList.contains('p-2')).toBe(true)
    expect(b.classList.contains('p-6')).toBe(false)
  })
})
