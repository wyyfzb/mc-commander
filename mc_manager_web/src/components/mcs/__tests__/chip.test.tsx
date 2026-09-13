import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Chip } from '../chip'

/**
 * Chip 通用 chip：静态/切换/动作三态，全 token 语义
 */

describe('Chip', () => {
  it('无 onClick → 静态 span', () => {
    const { container } = render(<Chip>say 全服广播</Chip>)
    const el = screen.getByText('say 全服广播')
    expect(el.tagName).toBe('SPAN')
    expect(container.querySelector('button')).toBeNull()
  })

  it('有 onClick + selected → 切换按钮（aria-pressed）', () => {
    const onClick = vi.fn()
    render(
      <Chip onClick={onClick} selected>
        正午
      </Chip>,
    )
    const btn = screen.getByRole('button', { name: '正午' })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('onClick 无 selected → 动作按钮，无 aria-pressed', () => {
    render(<Chip onClick={() => {}}>模板</Chip>)
    const btn = screen.getByRole('button', { name: '模板' })
    expect(btn).not.toHaveAttribute('aria-pressed')
  })

  it('role=radio 选中 → 单选语义，不再输出 aria-pressed（两套语义互斥）', () => {
    render(
      <Chip role="radio" aria-checked tabIndex={0} selected onClick={() => {}}>
        晴天
      </Chip>,
    )
    const radio = screen.getByRole('radio', { name: '晴天' })
    expect(radio).toHaveAttribute('aria-checked', 'true')
    // 同元素同时宣告「已选中」与「已按下」会让读屏双重播报，正是单选组要消灭的形态
    expect(radio).not.toHaveAttribute('aria-pressed')
  })

  it('role=radio 未选中 → aria-checked=false，同样无 aria-pressed', () => {
    render(
      <Chip role="radio" aria-checked={false} tabIndex={-1} onClick={() => {}}>
        雨天
      </Chip>,
    )
    const radio = screen.getByRole('radio', { name: '雨天' })
    expect(radio).toHaveAttribute('aria-checked', 'false')
    expect(radio).not.toHaveAttribute('aria-pressed')
  })

  it('disabled → 按钮禁用', () => {
    const onClick = vi.fn()
    render(
      <Chip onClick={onClick} disabled>
        晴天
      </Chip>,
    )
    expect(screen.getByRole('button', { name: '晴天' })).toBeDisabled()
  })

  it('tone/seleceted 命中 token 语义类', () => {
    const { container } = render(<Chip tone="warning">OP 1/3</Chip>)
    expect(container.querySelector('span')?.className).toContain('text-mcs-warning-fg')
  })

  it('onPointerEnter/onPointerLeave 透传到 DOM', () => {
    const onEnter = vi.fn()
    const onLeave = vi.fn()
    render(<Chip onPointerEnter={onEnter} onPointerLeave={onLeave}>hover</Chip>)
    fireEvent.pointerEnter(screen.getByText('hover'))
    expect(onEnter).toHaveBeenCalledTimes(1)
    fireEvent.pointerLeave(screen.getByText('hover'))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })
})
