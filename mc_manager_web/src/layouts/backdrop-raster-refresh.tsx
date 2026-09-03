import { useEffect } from 'react'

/**
 * BackdropRasterRefresh —— 浏览器缩放后强制玻璃层重新栅格化
 * Chromium 系内核（含 Edge / webview 宿主）已知行为：backdrop-filter 合成层在
 * 页面缩放后沿用旧分辨率纹理，表现为玻璃层文字模糊（普通内容不受影响）。
 * 页面缩放必触发 window.resize，此时对玻璃层重放 backdrop-filter 迫使合成层
 * 按新缩放重建；防抖避免拖拽窗口尺寸时连续闪烁。
 */
export function BackdropRasterRefresh() {
  useEffect(() => {
    let timer: number | undefined
    const kick = () => {
      const els = document.querySelectorAll<HTMLElement>('.glass-chrome, .glass-overlay, .glass-toast')
      els.forEach((el) => {
        el.style.setProperty('backdrop-filter', 'none')
        el.style.setProperty('-webkit-backdrop-filter', 'none')
        // 同步 reflow 使层销毁生效，随后还原让浏览器按当前缩放重建
        void el.offsetWidth
        el.style.removeProperty('backdrop-filter')
        el.style.removeProperty('-webkit-backdrop-filter')
      })
    }
    const onResize = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(kick, 200)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(timer)
    }
  }, [])
  return null
}
