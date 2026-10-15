/**
 * 定位前端包根（门禁的判定对象）。
 *
 * 门禁住在 tools/gates/，判定对象是 apps/web/ ——两者不同层，所以扫描根不能由
 * 本文件位置推得（`import.meta.dirname/..` 会指向 tools/，门禁照常跑、却扫错树，
 * 属于「看起来在守门、实际全放行」的静默失效）。
 *
 * 取法两级：`--root=<路径>` 显式指定（CI 与本地一致用）；否则从仓库根推 apps/web。
 * 两条路径都校验目标含 src/，缺失即非 0 退出——宁可当场红，也不静默扫空目录。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function findRepoRoot(from) {
  let d = resolve(from)
  for (;;) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

export function resolveWebRoot() {
  const hit = process.argv.find((a) => a.startsWith('--root='))
  const root = hit
    ? resolve(hit.slice('--root='.length))
    : (() => {
        const repo = findRepoRoot(import.meta.dirname)
        return repo ? join(repo, 'apps', 'web') : null
      })()

  if (!root || !existsSync(join(root, 'src'))) {
    console.error(
      `[gates] 未定位到前端包根（试算：${root ?? '未找到仓库根'}）——用 --root=<apps/web 路径> 指定`,
    )
    process.exit(2)
  }
  return root
}
