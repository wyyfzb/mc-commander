/**
 * 退出登录（本机侧）——一次性清除本浏览器持有的**全部**凭据：登录会话 + API Key。
 * 两者必须一起清：只清会话时，残留的 API Key 会让 connection.status 保持 ready，
 * 随后的 `/login` 被 requireUnconfigured 弹回（于是出现「toast 说已退出登录、人还在面板里」），
 * 而用户此刻也拿不到利落的出口——旧行为要靠顶栏菜单因会话已清而切成「API Key 直连状态」、
 * 再点一次登出才清得掉 Key（同一动作要点两次，菜单语义还前后不一）。
 * 与 API Key 直连分支的既有口径一致（该分支登出即清 Key）。
 * 不适用：40103 会话过期的全局处置（`stores/auth` 的 clearSessionAndDispatchExpired）——
 * 那条通道的语义是「Key 顶上继续用」，不是用户主动登出。
 */
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'

export function clearLocalCredentials(): void {
  useAuthStore.getState().clearSession()
  // setConfig 内部按剩余凭据重算 status（此处只剩空串 → unconfigured），无需再 refreshStatus
  useConnectionStore.getState().setConfig({ apiKey: '' })
}

/**
 * 主动登出的 toast 文案：登出会清掉本机保存的 API Key（不可从浏览器恢复），
 * 清到了就得说清——三处登出入口（顶栏两分支 + 账号面板）共用同一口径。
 */
export function logoutToastText(hadApiKey: boolean): string {
  return hadApiKey ? '已退出登录，本机保存的 API Key 已一并清除' : '已退出登录'
}
