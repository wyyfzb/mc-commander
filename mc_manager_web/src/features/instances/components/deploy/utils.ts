/**
 * DeployDialog 工具函数（从 deploy-dialog.tsx 行为不变迁移）
 */
import { MEMORY_OPTIONS } from './constants'

/** 内存档位 → GB 数值 */
export function memoryToGB(memory: string): number {
  return Number.parseInt(memory, 10)
}

/**
 * 系统总内存 → 推荐档位：
 * total×0.5 clamp [1, total] → 0.5 步进取整 → 映射到最近档位（Web Select 化）
 */
export function recommendedMemoryGB(totalMemory: number): number {
  const recommended = Math.min(Math.max(totalMemory * 0.5, 1), totalMemory)
  const stepped = Math.max(Math.round(recommended * 2) / 2, 1)
  return MEMORY_OPTIONS.map(memoryToGB).reduce((best, v) =>
    Math.abs(v - stepped) < Math.abs(best - stepped) ? v : best,
  )
}

/** 传输字节 → MB 文案（服务端 got downloadProgress 单位字节；整数档去小数） */
export function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)
}
