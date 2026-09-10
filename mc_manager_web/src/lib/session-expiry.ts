/**
 * 会话过期（40103）后的落点决策 —— routes.tsx 的全局监听用，抽成纯函数以便直测。
 * 关键一条：本机仍持有 API Key 时 connection.status 仍是 ready，此时跳 /login 会被
 * requireUnconfigured 弹回仪表盘（用户被无声挪页、returnTo 也丢）——而双通道设计本就是
 * 「会话没了由 Key 顶上继续用」，故这种情况不跳转。
 */
import type { ConnectionStatus } from '@/stores/connection'

/** @returns 是否应把用户送到登录页 */
export function shouldRedirectToLoginAfterSessionExpiry(
  status: ConnectionStatus,
  currentPath: string,
): boolean {
  if (status === 'ready') return false
  // 已在登录页/引导页时不再跳转（避免循环）
  return currentPath !== '/login' && currentPath !== '/onboarding'
}
