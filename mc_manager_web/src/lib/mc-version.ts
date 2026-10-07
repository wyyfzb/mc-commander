/**
 * MC 版本号解析与比较（中立模块）。
 *
 * 为什么独立成模块：版本比较散落在物品域、gamerule 域与附魔域各写一份，各自的「不可解析时怎么办」
 * 又互不相同。判定口径可以不同，**解析器只该有一份**——否则同一串版本号在不同面板上得到不同结论。
 *
 * 三条约定：
 * 1. 解析取**第一段连续数字**及其后的点分段（`v1.21.5`、`26.3-snapshot-2` 都能读），缺失段按 0；
 *    整串里没有数字才算不可解析 ⇒ 返回 null。
 * 2. **不返回 NaN 三元组**：NaN 参与比较会让所有分支静默为 false，把一个「读不懂」伪装成
 *    「比较结果是否」。
 * 3. 不可解析时的处置由调用方**显式**传入（`whenUnknown`）——物品可用性偏保守、其余以新版
 *    为准，这是各域的口径，不该由本模块替它们决定。
 */

/** 主 / 次 / 修订；缺失段为 0（不是 NaN） */
export type VersionTriple = readonly [number, number, number]

/** 取版本三段；整串里找不到数字时返回 null */
export function parseVersion(version: string): VersionTriple | null {
  const m = version.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** 逐段数值比较（返回 <0 / 0 / >0）。任一侧不可解析返回 null ⇒ 调用方必须显式处置未知 */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i]! - y[i]!
  }
  return 0
}

/** `a >= b`？任一侧不可解析时返回 `whenUnknown` */
export function isVersionAtLeast(a: string, min: string, whenUnknown: boolean): boolean {
  const cmp = compareVersions(a, min)
  return cmp === null ? whenUnknown : cmp >= 0
}
