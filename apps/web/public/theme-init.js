/**
 * 首帧定色（在 React 挂载前执行）。
 *
 * 为什么是外链而不是 index.html 内联：服务端 helmet 的 CSP 只放行 `script-src 'self'`，
 * 内联脚本在真实部署下会被浏览器拒绝执行——本地 vite 与 e2e 不带 CSP，看不见这个失效。
 *
 * 为什么必须先于 React：zustand 的 persist 在挂载后才把偏好写回 DOM，
 * 持久化成亮色的用户会先看到一帧暗色（html 上的默认类名）。
 * 解析失败一律回退 dark——与 store 默认值一致。
 */
;(function () {
  try {
    var raw = localStorage.getItem('mcs-ui-preferences')
    var mode = raw ? JSON.parse(raw).state.theme : 'dark'
    var dark =
      mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : mode !== 'light'
    var root = document.documentElement
    root.classList.toggle('dark', dark)
    root.classList.toggle('light', !dark)
  } catch {
    /* 存储损坏/被禁用：保持 html 上的默认 dark */
  }
})()
