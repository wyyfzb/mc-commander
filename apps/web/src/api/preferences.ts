/** 面板级偏好（跨设备一致的配置）读写 */
import { apiGet, apiPut, type ConnectionConfig } from './client'
import type { PanelPreferences, PanelPreferencesPatch } from '@mc-commander/schemas'

/** 读出全部偏好；从未写过的项不出现（由调用方回退默认值） */
export function apiGetPreferences(config: ConnectionConfig) {
  return apiGet<PanelPreferences>('/api/v1/preferences', config)
}

/** 整份写入若干项；未出现的键保持原值 */
export function apiPutPreferences(config: ConnectionConfig, patch: PanelPreferencesPatch) {
  return apiPut<PanelPreferences>('/api/v1/preferences', config, patch)
}
