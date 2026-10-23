/**
 * 内置 HTTPS 状态（认证域内）。
 *
 * 服务端只能回答「装了哪张证书」，回答不了「这台设备信不信它」——后者是浏览器
 * 自己的状态，只能由前端探测（见 https-panel 的信任检测）。两者分开，是因为
 * 把它们合成一个字段会让「已启用」被误读成「已加密生效」。
 */
import { apiGet } from './client'
import type { ConnectionConfig } from './client'
import type { HttpsStatus } from '@mc-commander/schemas'

export type HttpsStatusData = HttpsStatus

/** GET /https（认证）：内置 HTTPS 是否在监听、CA 指纹、证书覆盖的地址 */
export function fetchHttpsStatus(
  config: ConnectionConfig,
  signal?: AbortSignal,
): Promise<HttpsStatusData> {
  return apiGet<HttpsStatusData>('/api/v1/https', config, signal)
}
