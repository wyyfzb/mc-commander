/**
 * DeployDialog 工具函数
 */

/** 传输字节 → MB 文案（服务端 downloadProgress 单位为字节；整数档去小数） */
export function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)
}
