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

export type FileEntry = z.infer<typeof fileEntrySchema>
export type FileListResponse = z.infer<typeof fileListResponseSchema>
export type FileInfoResponse = z.infer<typeof fileInfoResponseSchema>
export type FileContentResponse = z.infer<typeof fileContentResponseSchema>
export type FileSaveResponse = z.infer<typeof fileSaveResponseSchema>
