import { z } from 'zod'

export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['directory', 'file']),
  size: z.number(),
  modifiedAt: z.string(),
  isDirectory: z.boolean(),
})

export const fileListResponseSchema = z.object({
  path: z.string(),
  isDirectory: z.boolean(),
  files: z.array(fileEntrySchema),
  /**
   * 结果被服务端截断（条目数超过上限）。
   * 与 `playerInventorySchema.partial` 同口径：截断必须**明说**——
   * 少列出来的文件与「本来就没有」在 UI 上无法区分。
   * 可选以兼容旧客户端（缺省即未截断）。
   */
  truncated: z.boolean().optional(),
})

export const fileInfoResponseSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.literal('file'),
  size: z.number(),
  modifiedAt: z.string(),
  isDirectory: z.literal(false),
})

export const fileContentResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number(),
  content: z.string(),
  encoding: z.enum(['utf-8', 'gbk']),
  modifiedAt: z.string(),
})

export const fileSaveResponseSchema = z.object({
  path: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
})

export const fileMkdirResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
})

export const fileRenameResponseSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
  name: z.string(),
})

export const fileUploadResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
  isDirectory: z.literal(false),
})

// ── 请求侧契约（issue 391：路由层 zod 契约统一）──

/** GET /instances/:id/files 目录列表查询：path 缺省归一为 '/'（与既有行为一致） */
export const fileListRequestSchema = z.object({
  path: z.string().optional().default('/'),
})

/** GET download / GET content / DELETE files 查询：path 必填非空 */
export const filePathRequestSchema = z.object({
  path: z
    .string({ error: (iss) => (iss.input === undefined ? 'File path is required' : undefined) })
    .min(1, 'File path is required'),
})

/** PUT /instances/:id/files/content 保存内容请求体 */
export const fileSaveRequestSchema = z.object({
  path: z
    .string({
      error: (iss) => (iss.input === undefined ? 'File path and content are required' : undefined),
    })
    .min(1, 'File path is required'),
  content: z.string({
    error: (iss) => (iss.input === undefined ? 'File path and content are required' : undefined),
  }),
})

/** POST /instances/:id/files/mkdir 新建目录请求体 */
export const fileMkdirRequestSchema = z.object({
  path: z
    .string({
      error: (iss) => (iss.input === undefined ? 'Directory path is required' : undefined),
    })
    .min(1, 'Directory path is required'),
})

/** POST /instances/:id/files/rename 重命名请求体 */
export const fileRenameRequestSchema = z.object({
  path: z
    .string({
      error: (iss) => (iss.input === undefined ? 'Old path and new path are required' : undefined),
    })
    .min(1, 'Old path and new path are required'),
  newPath: z
    .string({
      error: (iss) => (iss.input === undefined ? 'Old path and new path are required' : undefined),
    })
    .min(1, 'Old path and new path are required'),
})

/**
 * POST /instances/:id/files/upload 查询（?targetDir=，可选缺省 '/'）。
 * 归一化语义与既有路由一致：拒绝控制字符、空串非法、补全前导 '/'；
 * 控制字符判定用完整 [^\x00-\x1f] 类（原路由内联正则缺方括号为字面
 * 三字符序列匹配，收敛到 schema 顺带修正，安全性只增不减）。
 */
export const fileUploadQuerySchema = z.object({
  targetDir: z
    .string()
    .min(1, 'Invalid targetDir')
    // 控制字符校验是安全面刻意为之（拒绝 \x00-\x1f），非误用正则
    // oxlint-disable-next-line no-control-regex
    .refine((v) => !/[\x00-\x1f]/.test(v), 'Invalid targetDir')
    .transform((v) => (v.startsWith('/') ? v : `/${v}`))
    .optional()
    .default('/'),
})

export type FileEntry = z.infer<typeof fileEntrySchema>
export type FileListResponse = z.infer<typeof fileListResponseSchema>
export type FileInfoResponse = z.infer<typeof fileInfoResponseSchema>
export type FileContentResponse = z.infer<typeof fileContentResponseSchema>
export type FileSaveResponse = z.infer<typeof fileSaveResponseSchema>
export type FileMkdirResponse = z.infer<typeof fileMkdirResponseSchema>
export type FileRenameResponse = z.infer<typeof fileRenameResponseSchema>
export type FileUploadResponse = z.infer<typeof fileUploadResponseSchema>
export type FileListRequest = z.infer<typeof fileListRequestSchema>
export type FilePathRequest = z.infer<typeof filePathRequestSchema>
export type FileSaveRequest = z.infer<typeof fileSaveRequestSchema>
export type FileMkdirRequest = z.infer<typeof fileMkdirRequestSchema>
export type FileRenameRequest = z.infer<typeof fileRenameRequestSchema>
export type FileUploadQuery = z.infer<typeof fileUploadQuerySchema>
