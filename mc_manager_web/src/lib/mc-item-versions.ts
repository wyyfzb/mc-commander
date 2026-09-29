/**
 * 物品版本元数据的**权威来源**（条目 9）。
 *
 * 数据不是手写的，由 `scripts/gen-item-versions.mjs` 从官方注册表生成：
 *   ① Mojang `version_manifest_v2.json` —— 权威「哪些 id 是正式发布版」列表
 *   ② `misode/mcmeta` 各版本的 `item/data.json` —— 该版本的物品注册表
 *      （mcmeta 是社区对官方 data generator 输出的处理后快照，逐版本一 tag）
 *
 * 为什么不用源码注释里的版本标注：那些注释是**行内标注**，只覆盖 35/212 条，
 * 且作用域不可机械判定——按「注释当分组长」解析会把 `bread`/`cake`/`torch` 等
 * 12 条远古物品误标为 1.21，在旧版服上被隐藏。改用官方注册表后，每个 id 的
 * 「首见版本」是**算出来的**，不依赖任何人维护注释。
 *
 * 覆盖面：面板支持 1.20.5 起的服务端，故只记录**晚于 1.20.5** 的物品。
 * 起点即存在的物品不在此表内，按「全版本可用」处理（面板下限就是 1.20.5）。
 */

/**
 * 面板支持的最低 MC 版本。此版本即存在的物品不标注版本。
 * 与 `mc-schemas` 的 Data Components 门槛（1.20.5）一致——低于它的服务端本面板不支持。
 */
export const ITEM_VERSION_FLOOR = '1.20.5'

/**
 * 物品 id → 最早出现的正式版。仅含**晚于** `ITEM_VERSION_FLOOR` 的物品。
 *
 * 由 `node scripts/gen-item-versions.mjs` 生成，勿手改；更新时机是新 MC 正式版发布。
 * 未列出的 id 表示在 `ITEM_VERSION_FLOOR` 即已存在。
 */
export const ITEM_SINCE_VERSION: Readonly<Record<string, string>> = {
  // 26.1
  golden_dandelion: '26.1',
  // 26.2
  chiseled_cinnabar: '26.2',
  chiseled_sulfur: '26.2',
  cinnabar: '26.2',
  cinnabar_bricks: '26.2',
  cinnabar_slab: '26.2',
  cinnabar_stairs: '26.2',
  cinnabar_wall: '26.2',
  music_disc_bounce: '26.2',
  polished_cinnabar: '26.2',
  polished_sulfur: '26.2',
  potent_sulfur: '26.2',
  sulfur: '26.2',
  sulfur_bricks: '26.2',
  sulfur_cube_bucket: '26.2',
  sulfur_cube_spawn_egg: '26.2',
  sulfur_slab: '26.2',
  sulfur_spike: '26.2',
  sulfur_stairs: '26.2',
  sulfur_wall: '26.2',
}

/** 版本号三元组（缺失段为 0，便于比较） */
function triple(v: string): [number, number, number] {
  const p = v.split('.').map((x) => Number.parseInt(x, 10))
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]
}

/**
 * 比较两个点分版本号。返回 <0 / 0 / >0，语义同 `Array.prototype.sort` 的比较器。
 *
 * 逐段数值比较而非字符串比较：字符串比较会把 `1.9` 排在 `1.10` 之后。
 */
export function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = triple(a)
  const [b1, b2, b3] = triple(b)
  if (a1 !== b1) return a1 - b1
  if (a2 !== b2) return a2 - b2
  return a3 - b3
}

/**
 * 该物品是否在目标版本可用。
 *
 * 未在 `ITEM_SINCE_VERSION` 中的物品按「起点即存在」处理 ⇒ 可用。
 * 含义是「**已知**不早于此版本」，不是「已核实适用」——注册表只覆盖正式版，
 * 快照版与模组物品不在其列。
 */
export function isItemAvailableIn(itemId: string, mcVersion: string): boolean {
  const since = ITEM_SINCE_VERSION[itemId]
  if (!since) return true
  return compareVersions(mcVersion, since) >= 0
}

/**
 * 该物品需要的**最低**版本（起点即存在者返回 `null`，表示无版本要求）。
 *
 * 返回 null 而非 `ITEM_VERSION_FLOOR`：调用方需要区分「无要求」与「要求 1.20.5」——
 * 前者不该显示任何版本徽章，后者才要。
 */
export function requiredVersionFor(itemId: string): string | null {
  return ITEM_SINCE_VERSION[itemId] ?? null
}
