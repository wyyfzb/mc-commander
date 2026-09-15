/**
 * API 契约类型 —— 单源 zod schema 推导（@mc-commander/schemas）
 * 新增/修改字段只改 mc-schemas/ 对应 .ts 文件，两端自动同步。
 */

// ── 信封 ──
export type { Pagination, ApiErrorEnvelope } from '@mc-commander/schemas'

/** 泛型信封（类型层面，运行时用 makeApiEnvelopeSchema） */
export interface ApiEnvelope<T> {
  status: 'ok'
  code: 0
  message: string
  data: T
  pagination?: import('@mc-commander/schemas').Pagination
  timestamp: string
}

// ── 系统统计 ──
export type { DiskInfo, DiskUsage, SystemStats, UpdateCheckResult } from '@mc-commander/schemas'

// ── 实例 ──
export type { InstanceSummary, InstanceStatus, InstanceUpdatePayload, OverviewData, LogEntry } from '@mc-commander/schemas'

// ── 天气（从 player 模块导出） ──
export type { WeatherType } from '@mc-commander/schemas'

// ── 玩家 ──
export type {
  SpawnPoint, PlayerPosition, PlayerDimension, PlayerGameMode,
  PlayerEvent, PlayerSession, PlayerStats, PlayerPotionEffect,
  IpHistoryEntry, InventoryItem, PlayerInventory,
  Player, BanRecord, BanRequestBody,
} from '@mc-commander/schemas'

// ── WS 事件 ──
export {
  WS_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPES,
} from '@mc-commander/schemas'
export type { WsEventType, WsMessage, WsStatusSnapshot, WsPerformancePayload, WsLogPayload, WsStatusEventPayload, WsPlayerEventPayload, WsWeatherPayload, WsBackupPayload } from '@mc-commander/schemas'

// ── 备份 ──
export type { BackupItem } from '@mc-commander/schemas'

// ── 世界 ──
export type { WorldDimension, WorldInfo, ServerProperties, UpdatePropertiesResponse } from '@mc-commander/schemas'

// ── 文件 ──
export type { FileEntry, FileListResponse, FileInfoResponse, FileContentResponse, FileSaveResponse } from '@mc-commander/schemas'

// ── 定时任务 ──
export type { ScheduledTaskType, ScheduledTask, TaskCreatePayload, TaskUpdatePayload, TaskRunHistory } from '@mc-commander/schemas'

// ── 部署/升级 ──
export type { VersionsResponse, DeployRequest, DeployResult, DeployProgress, DeployStatusResponse, UpgradeStage, UpgradeProgress, UpgradeRequest, UpgradeStartResponse } from '@mc-commander/schemas'

// ── 审计 ──
export type { AuditLogItem, CommandHistoryItem } from '@mc-commander/schemas'

// ── Webhook ──
export type { Webhook, WebhookCreatePayload, WebhookDelivery, WebhookTestResult } from '@mc-commander/schemas'

// ── 插件 ──
export type {
  PluginMeta, PluginInfo, PluginList,
  PluginUpdateStatus, PluginUpdateCheckResult,
  PluginToggleResult, PluginUploadResult,
  MarketSearchHit, MarketSearchResult,
  MarketVersionFile, MarketVersion,
  MarketVersionsResult, MarketInstallResult,
} from '@mc-commander/schemas'
