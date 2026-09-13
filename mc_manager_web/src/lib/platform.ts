/**
 * 平台判定（展示层用）——快捷键提示必须按平台说人话：
 * handler 同时接受 metaKey 与 ctrlKey，但提示只写「Ctrl K」会让 macOS 用户按错键。
 * 判定优先取 UA-CH 的 `userAgentData.platform`（现代 Chromium），退回已废弃但仍在的
 * `navigator.platform`，最后退回 userAgent——SSR/无 navigator 环境一律按非 mac 处理。
 */

interface NavigatorWithUaData extends Navigator {
  userAgentData?: { platform?: string }
}

/** 是否为 Apple 平台（macOS / iOS / iPadOS） */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as NavigatorWithUaData
  // 取「第一个非空」而非「第一个非 null」：某些环境把 platform 置为空串，空串应继续下探
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** 主修饰键的展示名（macOS 用 ⌘，其余平台用 Ctrl） */
export function primaryModifierLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl'
}
