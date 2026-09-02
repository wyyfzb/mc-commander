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
  format: z.enum(['snapshot', 'zip']),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type BackupItem = z.infer<typeof backupItemSchema>
