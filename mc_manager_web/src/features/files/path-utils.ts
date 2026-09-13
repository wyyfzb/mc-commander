/**
 * 文件路径工具（列表 dir 参数口径：'/' 前缀风格）。
 *
 * `parentDirOf` 是单一实现：files-page（返回上级、重命名拼新路径）与 files/queries
 * （操作后失效哪个目录的缓存）必须同规则——各写一份时缓存失效目录会与实际列表
 * 目录错位，表现为「操作成功但列表不刷新」，且两处不会同时报错、只在运行期显形。
 */
export function parentDirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}
