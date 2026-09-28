/**
 * 单选组方向键模型（纯函数）：循环移动、Home/End 边界、与组无关的键一律放行
 */
import { describe, it, expect } from 'vitest'
import { nextRadioIndex } from '../radio-group'

describe('nextRadioIndex', () => {
  it('左右/上下在组内循环移动', () => {
    expect(nextRadioIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextRadioIndex('ArrowDown', 1, 3)).toBe(2)
    expect(nextRadioIndex('ArrowLeft', 1, 3)).toBe(0)
    expect(nextRadioIndex('ArrowUp', 2, 3)).toBe(1)
    // 首尾回绕
    expect(nextRadioIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(nextRadioIndex('ArrowRight', 2, 3)).toBe(0)
  })

  it('Home/End 跳首末项', () => {
    expect(nextRadioIndex('Home', 2, 3)).toBe(0)
    expect(nextRadioIndex('End', 0, 3)).toBe(2)
  })

  it('与单选组无关的键返回 null（调用方据此放行，不得吞掉 Tab）', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape', 'PageDown']) {
      expect(nextRadioIndex(key, 1, 3)).toBeNull()
    }
  })

  it('空组返回 null（契约约定，非现网防线——两个调用点都传非空 length）', () => {
    expect(nextRadioIndex('ArrowRight', 0, 0)).toBeNull()
    expect(nextRadioIndex('Home', 0, 0)).toBeNull()
  })
})
