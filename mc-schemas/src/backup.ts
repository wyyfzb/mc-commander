import { z } from 'zod'

export const backupItemSchema = z.object({
  id: z.number(),
  instanceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  type: z.literal('manual'),
  size: z.number(),
  status: z.enum(['completed', 'failed', 'creating', 'restoring']),
  worldName: z.string(),
  /** 非空 = 该条目由「挂载归档快照」登记：快照不在本实例的备份目录内，而在原归档实例目录下 */
  sourceArchiveId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** 创建备份请求体（服务端缺省 name/description，故均可选） */
export const backupCreateRequestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
})

/**
 * POST /backups/:id/restore 请求契约。
 * confirmName 必须是该备份所属实例的名称（服务端 trim 后全等比对）：恢复会用快照整体
 * 覆盖实例目录，前端弹窗的实例名输入此前是唯一闸门，直连 API 的调用方可无确认覆盖。
 */
export const backupRestoreRequestSchema = z.object({
  confirmName: z.string({
    error: (iss) => (iss.input === undefined ? 'confirmName 必填' : undefined),
  }),
})

/**
 * POST /instances/:instanceId/backups/cancel 响应：取消命中的进行中操作。
 * kind=create 时备份记录与半成品快照一并清除（主动取消不留 failed 记录）；
 * kind=restore 时走既有回滚（pre_restore rename 回来），备份记录回 completed 可再次恢复。
 */
export const backupCancelResponseSchema = z.object({
  kind: z.enum(['create', 'restore']),
  backupId: z.number(),
})

/**
 * 恢复确认的目标串（服务端校验与前端输入提示的唯一派生口径）。
 * 优先实例名；实例没有名称时退到备份名，备份名也为空再退到备份 id——确认串必须
 * 始终非空：空串天然匹配会让这道闸门空转（与卸载侧空名实例的加固同源问题），
 * 两处各写一份回退链则必然分叉，故放在契约层共用。
 */
export function restoreConfirmTarget(input: {
  instanceName?: string | null
  backupName?: string | null
  backupId: number | string
}): string {
  const instanceName = (input.instanceName ?? '').trim()
  if (instanceName !== '') return instanceName
  const backupName = (input.backupName ?? '').trim()
  if (backupName !== '') return backupName
  return String(input.backupId)
}

/**
 * 归档快照组：磁盘上存在、但**备份表里没有索引**的实例级快照目录（清单 #27）。
 *
 * 来源是「卸载实例时快照按设计保留」——卸载会删掉备份表记录，目录留在
 * `backupsDir/<原实例 id>/`，此后 UI 完全看不到它们，只能靠人工去磁盘里翻，
 * 且会随保留期孤儿清扫被删。契约把这一面暴露出来，让管理员能在面板里把它们
 * **挂载**（登记回备份表）到某个实例上，随后即可正常恢复/下载/删除。
 */
export const archivedSnapshotGroupSchema = z.object({
  /** 备份目录名（原实例 id 形态：`<type>-<8 位 hex>`） */
  archiveId: z.string(),
  /** 同名实例当前是否仍存在（false = 已卸载的遗留归档） */
  instanceExists: z.boolean(),
  /** 该目录下**尚未建立索引**的快照份数（已挂载的不计入；清点的是「看不见的那部分」） */
  snapshotCount: z.number(),
  /** 其中能认出世界数据的份数（挂载时会跳过认不出的） */
  usableCount: z.number(),
  /** 组内最近一次快照时间（ISO） */
  latestMtime: z.string(),
})

export const archivedSnapshotListSchema = z.array(archivedSnapshotGroupSchema)

/**
 * 挂载归档快照到目标实例：把这些快照登记进备份表（**只建索引，不复制、不移动磁盘内容**），
 * 挂载后它们会出现在该实例的备份列表里，可正常恢复/下载/删除。
 *
 * 生命周期口径（UI 文案与服务端行为必须一致）：挂载后不再随孤儿清扫被删，但作为该实例的
 * 普通备份条目，仍计入该实例的备份配额——超出保留策略（数量/天数上限，按 `createdAt`
 * 最旧优先）或手工删除都会清掉它；删除条目会连带删除磁盘上的原归档快照（不复制 = 该目录
 * 就是唯一副本）。
 */
export const backupAttachRequestSchema = z.object({
  archiveId: z
    .string({ error: (iss) => (iss.input === undefined ? 'archiveId 必填' : undefined) })
    .min(1, 'String must contain at least 1 character(s)'),
})

export const backupAttachResponseSchema = z.object({
  /** 本次新登记的快照数 */
  attached: z.number(),
  /** 跳过的份数（已在索引中 / 认不出世界数据） */
  skipped: z.number(),
})

export type BackupItem = z.infer<typeof backupItemSchema>
export type BackupCreateRequest = z.infer<typeof backupCreateRequestSchema>
export type BackupRestoreRequest = z.infer<typeof backupRestoreRequestSchema>
export type BackupCancelResponse = z.infer<typeof backupCancelResponseSchema>
export type ArchivedSnapshotGroup = z.infer<typeof archivedSnapshotGroupSchema>
export type BackupAttachRequest = z.infer<typeof backupAttachRequestSchema>
export type BackupAttachResponse = z.infer<typeof backupAttachResponseSchema>
