/**
 * MC 版本号解析与比较（共享唯一一份）。
 *
 * 为什么在契约包：版本比较若由 web 的物品域/游戏规则域/附魔域与服务端的 MSMP 版本门槛
 * 各写一份，各自的「不可解析时怎么办」又互不相同。判定口径可以不同，**解析器只该有一份**——
 * 否则同一串版本号在面板与服务端会得到不同结论（服务端会因此替不支持该能力的版本写配置）。
 *
 * 三条约定：
 * 1. 解析取**第一段连续数字**及其后的点分段（`v1.21.5`、`26.3-snapshot-2` 都能读），缺失段按 0；
 *    整串里没有数字才算不可解析 ⇒ 返回 null。
 * 2. **不返回 NaN 三元组**：NaN 参与比较会让所有分支静默为 false，把一个「读不懂」伪装成
 *    「比较结果是否」。
 * 3. 不可解析时的处置由调用方**显式**决定（`whenUnknown`）——物品可用性偏保守、其余以新版
 *    为准，这是各域的口径，不该由本模块替它们决定。
 */

/** 主 / 次 / 修订；缺失段为 0（不是 NaN） */
export type VersionTriple = readonly [number, number, number]

/**
 * 取版本三段；整串里找不到数字时返回 null。
 *
 * 周快照形态（`25w35a`、`26w14a`）同样返回 null：它的 `25` 是**年份后两位**，
 * 按点分版本读成 `25.0.0` 会排到 1.21.9 之后——把 2019 年的版本判成支持 MSMP、
 * 把 1.21.2 时代的周快照送进 26.x 的规则名表。读不懂就返回 null，由调用方按各自极性处置。
 */
export function parseVersion(version: string): VersionTriple | null {
  const text = String(version ?? '')
  if (/^\d{2}w\d{2}[a-z]$/.test(text)) return null
  const m = text.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
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
