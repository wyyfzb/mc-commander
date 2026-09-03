/**
 * @mc-commander/schemas — 共享 zod 契约定义
 * API/WS/通知三方同源，根治契约漂移
 */

// 信封
export {
  paginationSchema,
  apiEnvelopeSchema,
  apiErrorEnvelopeSchema,
  makeApiEnvelopeSchema,
  nullDataSchema,
  type Pagination,
  type ApiEnvelope,
  type ApiErrorEnvelope,
  type NullData,
} from './envelope'

// 玩家
export {
  playerSchema,
  playerListSchema,
  playerDetailsResponseSchema,
  banRecordSchema,
  banRecordListSchema,
  banResponseBodySchema,
  banRequestBodySchema,
  spawnPointSchema,
  playerPositionSchema,
  playerEventSchema,
  playerSessionSchema,
  playerStatsSchema,
  playerPotionEffectSchema,
  ipHistoryEntrySchema,
  inventoryItemSchema,
  playerInventorySchema,
  playerDimensionSchema,
  playerGameModeSchema,
  weatherTypeSchema,
  type Player,
  type PlayerList,
  type PlayerDetailsResponse,
  type BanRecord,
  type BanRecordList,
  type BanResponseBody,
  type BanRequestBody,
  type SpawnPoint,
  type PlayerPosition,
  type PlayerDimension,
  type PlayerGameMode,
  type WeatherType,
  type PlayerEvent,
  type PlayerSession,
  type PlayerStats,
  type PlayerPotionEffect,
  type IpHistoryEntry,
  type InventoryItem,
  type PlayerInventory,
} from './player'

// 实例
export {
  instanceSummarySchema,
  instanceStatusSchema,
  instanceStatusListSchema,
  instanceUpdatePayloadSchema,
  overviewDataSchema,
  logEntrySchema,
  logEntriesSchema,
  commandResponseSchema,
  type InstanceSummary,
  type InstanceStatus,
  type InstanceStatusList,
  type InstanceUpdatePayload,
  type OverviewData,
  type LogEntry,
  type LogEntries,
  type CommandResponse,
} from './instance'

// 备份
export {
  backupItemSchema,
  backupCreateRequestSchema,
  type BackupItem,
  type BackupCreateRequest,
} from './backup'

// 定时任务
export {
  scheduledTaskSchema,
  scheduledTaskTypeSchema,
  taskCreatePayloadSchema,
  taskUpdatePayloadSchema,
  taskRunHistorySchema,
  taskRunStatusSchema,
  type ScheduledTask,
  type ScheduledTaskType,
  type TaskCreatePayload,
  type TaskRunHistory,
  type TaskRunStatus,
  type TaskUpdatePayload,
} from './task'

// WebSocket
export {
  WS_EVENT_TYPES,
  wsEventTypeSchema,
  wsMessageSchema,
  wsStatusSnapshotSchema,
  wsPerformancePayloadSchema,
  wsLogPayloadSchema,
  wsStatusEventPayloadSchema,
  wsPlayerEventPayloadSchema,
  wsWeatherPayloadSchema,
  wsBackupPayloadSchema,
  NOTIFICATION_EVENT_TYPES,
  type WsEventType,
  type WsMessage,
  type WsStatusSnapshot,
  type WsPerformancePayload,
  type WsLogPayload,
  type WsStatusEventPayload,
  type WsPlayerEventPayload,
  type WsWeatherPayload,
  type WsBackupPayload,
} from './ws'

// 世界
export {
  worldInfoSchema,
  worldDimensionSchema,
  serverPropertiesSchema,
  updatePropertiesResponseSchema,
  type WorldInfo,
  type WorldDimension,
  type ServerPropertiesMap,
  type ServerProperties,
  type UpdatePropertiesResponse,
} from './world'

// 文件
export {
  fileEntrySchema,
  fileListResponseSchema,
  fileInfoResponseSchema,
  fileContentResponseSchema,
  fileSaveResponseSchema,
  fileListRequestSchema,
  filePathRequestSchema,
  fileSaveRequestSchema,
  fileMkdirRequestSchema,
  fileRenameRequestSchema,
  fileUploadQuerySchema,
  type FileEntry,
  type FileListResponse,
  type FileInfoResponse,
  type FileContentResponse,
  type FileSaveResponse,
  type FileListRequest,
  type FilePathRequest,
  type FileSaveRequest,
  type FileMkdirRequest,
  type FileRenameRequest,
  type FileUploadQuery,
} from './files'

// 审计
export {
  auditLogItemSchema,
  commandHistoryItemSchema,
  auditLogsQuerySchema,
  commandHistoryQuerySchema,
  type AuditLogItem,
  type CommandHistoryItem,
} from './audit'

// Webhook
export {
  webhookSchema,
  webhookCreatePayloadSchema,
  webhookDeliverySchema,
  webhookTestResultSchema,
  type Webhook,
  type WebhookCreatePayload,
  type WebhookDelivery,
  type WebhookTestResult,
} from './webhook'

// 部署/升级
export {
  versionsResponseSchema,
  deployRequestSchema,
  deployResultSchema,
  deployProgressSchema,
  upgradeStageSchema,
  upgradeProgressSchema,
  upgradeRequestSchema,
  upgradeStartResponseSchema,
  type VersionsResponse,
  type DeployRequest,
  type DeployResult,
  type DeployProgress,
  type UpgradeStage,
  type UpgradeProgress,
  type UpgradeRequest,
  type UpgradeStartResponse,
} from './deploy'

// 插件
export {
  pluginMetaSchema,
  pluginInfoSchema,
  pluginListSchema,
  pluginUpdateStatusSchema,
  pluginUpdateCheckResultSchema,
  pluginToggleResultSchema,
  pluginUploadResultSchema,
  marketSearchHitSchema,
  marketSearchResultSchema,
  marketVersionFileSchema,
  marketVersionSchema,
  marketVersionsResultSchema,
  marketInstallResultSchema,
  marketSearchRequestSchema,
  marketVersionsRequestSchema,
  pluginOverwriteQuerySchema,
  marketInstallRequestSchema,
  pluginEnabledRequestSchema,
  type PluginMeta,
  type PluginInfo,
  type PluginList,
  type PluginUpdateStatus,
  type PluginUpdateCheckResult,
  type PluginToggleResult,
  type PluginUploadResult,
  type MarketSearchHit,
  type MarketSearchResult,
  type MarketVersionFile,
  type MarketVersion,
  type MarketVersionsResult,
  type MarketInstallResult,
  type MarketSearchRequest,
  type MarketVersionsRequest,
  type PluginOverwriteQuery,
  type MarketInstallRequest,
  type PluginEnabledRequest,
} from './plugin'

// 系统
export {
  diskInfoSchema,
  diskUsageSchema,
  systemStatsSchema,
  updateCheckResultSchema,
  type DiskInfo,
  type DiskUsage,
  type SystemStats,
  type UpdateCheckResult,
} from './system'
