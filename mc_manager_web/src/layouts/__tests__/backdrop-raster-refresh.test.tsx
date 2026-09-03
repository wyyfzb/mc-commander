import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { BackdropRasterRefresh } from '../backdrop-raster-refresh'

/**
 * BackdropRasterRefresh 组件测试：resize 防抖后对玻璃层重放 backdrop-filter
 * （修复浏览器缩放后 backdrop-filter 合成层沿用旧分辨率纹理导致的模糊）
 * kick 同步完成（置 none → reflow → 还原），中间态不可观测，
 * 故以 style.setProperty 调用为断言点
 */

function makeGlassElement(className: string): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  document.body.appendChild(el)
  return el
}

describe('BackdropRasterRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('resize 防抖 200ms 后才对玻璃层 kick（置 none 再还原）', async () => {
    const glass = makeGlassElement('glass-chrome')
    render(<BackdropRasterRefresh />)
    const setSpy = vi.spyOn(glass.style, 'setProperty')

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(setSpy).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(setSpy).toHaveBeenCalledWith('backdrop-filter', 'none')
    expect(setSpy).toHaveBeenCalledWith('-webkit-backdrop-filter', 'none')
    // 同步还原完成
    expect(glass.style.getPropertyValue('backdrop-filter')).toBe('')
  })

  it('连续 resize 只在静默 200ms 后 kick 一次', async () => {
    const glass = makeGlassElement('glass-overlay')
    render(<BackdropRasterRefresh />)
    const setSpy = vi.spyOn(glass.style, 'setProperty')

    act(() => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    })
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(setSpy).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(setSpy).toHaveBeenCalledTimes(2) // 标准 + webkit 前缀各一次
  })

  it('覆盖三类玻璃层（chrome / overlay / toast）', async () => {
    const targets = ['glass-chrome', 'glass-overlay', 'glass-toast'].map(makeGlassElement)
    render(<BackdropRasterRefresh />)
    const spies = targets.map((el) => vi.spyOn(el.style, 'setProperty'))

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledWith('backdrop-filter', 'none')
    }
  })
})
