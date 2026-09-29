/**
 * 物品查缴的**谓词拼装**（条目 8 的可离线交付部分）。
 *
 * 范围界定（重要）：本模块只拼 `clear <玩家> <物品谓词> [maxCount]` 的**命令文本**，
 * 不解析 RCON 返回。原因：探测结果的真实措辞（「谁有、有几个」）尚未实测确认，
 * 而**照臆想的形状写解析器正是条目 27/31 的失效模式**（夹具把不存在的响应形状固化成
 * 契约，测试全绿而真实环境失效）。故「查」的那一半留待实机取样后再做；本模块交付的
 * 「清缴」那一半不依赖任何响应解析——命令发出去即生效。
 *
 * 官方语法依据（1.13+ `/clear`，`<物品谓词>` 与 `/give` 同源）：
 *   - `clear <targets> <item_predicate> [maxCount]`，`maxCount` 省略 = 清空全部匹配项，
 *     显式 `0` = **只查不删**（返回命中数量）
 *   - 物品谓词 = 物品 ID + 可选的 Data Components 谓词（1.20.5+）
 *   - `enchantments` 是**数组**，每项含 `enchantments`（ID 或 ID 数组）+ `levels`；
 *     `levels` 为 `[Int]` 精确值或 `[Compound]` 带 `min`/`max`
 *     ⇒ 「≥N 级」写作 `levels:{min:N}`，**无需读背包本地比对**
 *
 * 注意几处易错点（已按官方形态固定，勿照抄网上流传的错形）：
 *   ① `enchantments` 是数组，**不是** `{levels:{"minecraft:x":{min,max}}}` 那种嵌套对象
 *   ② 1.20.4 及以下没有 Data Components，谓词语法不存在 ⇒ 必须版本门控
 *   ③ `count` 谓词不用在这里：查缴关心的是「有没有」，不是堆叠数
 */
import { supportsDataComponents } from './mc-enchantments'

/** 谓词里的单个附魔条件 */
export interface EnchantPredicate {
  /** 附魔 id（不含命名空间），如 `sharpness` */
  id: string
  /** 只匹配等级 ≥ 此值（挂端附魔的典型判据：原版上限之上即为异常） */
  minLevel?: number
  /** 只匹配等级 ≤ 此值（与 minLevel 合用可表达区间） */
  maxLevel?: number
}

/** 一次查缴的谓词定义 */
export interface ClearPredicateSpec {
  /** 物品 id（不含命名空间）；省略 = 不按物品过滤（仅按组件） */
  itemId?: string
  /** 附魔条件（任一命中即可，OR 语义） */
  enchantments?: EnchantPredicate[]
}

/** 谓词拼装失败的原因（供 UI 提示；不抛异常，便于组件渲染） */
export type PredicateBuildError =
  | 'empty-predicate'
  | 'unsupported-version'
  | 'invalid-level-range'
  | 'invalid-id'

export interface PredicateBuildResult {
  /** 拼好的谓词文本（成功时非空） */
  predicate: string | null
  error: PredicateBuildError | null
}

/** 物品/附魔 id 白名单：与其它命令拼装层同款（小写字母数字与下划线/点/连字符） */
const ID_REGEX = /^[a-z0-9][a-z0-9_./-]*$/

/** 附魔条件 → `levels` 组件值；两级/单级/无上界三种形态 */
function levelsClause({ minLevel, maxLevel }: EnchantPredicate): string | null {
  const hasMin = typeof minLevel === 'number'
  const hasMax = typeof maxLevel === 'number'
  if (!hasMin && !hasMax) return null
  // 精确值：官方写法是裸整数（`levels:5`），不是 `{min:5,max:5}`
  if (hasMin && hasMax && minLevel === maxLevel) return String(minLevel)
  const parts: string[] = []
  if (hasMin) parts.push(`min:${minLevel}`)
  if (hasMax) parts.push(`max:${maxLevel}`)
  return `{${parts.join(',')}}`
}

/**
 * 拼装 `<物品谓词>`。
 *
 * 返回 `{ predicate, error }` 而不是抛异常：调用方是组件，需要把「为什么拼不出来」
 * 渲染成用户可读的提示（抛异常会让整个面板白屏）。
 */
export function buildClearPredicate(
  spec: ClearPredicateSpec,
  mcVersion: string,
): PredicateBuildResult {
  const { itemId, enchantments = [] } = spec

  // 空谓词会把 `clear <玩家>` 退化成「清空整个背包」——那是另一个动作（已有入口），
  // 静默退化会让用户以为在「查缴某个物品」而实际全清了
  if (!itemId && enchantments.length === 0) {
    return { predicate: null, error: 'empty-predicate' }
  }
  if (itemId && !ID_REGEX.test(itemId)) {
    return { predicate: null, error: 'invalid-id' }
  }

  // 附魔条件需要 Data Components；低版本没有谓词语法，只能按物品 id 查缴
  if (enchantments.length > 0 && !supportsDataComponents(mcVersion)) {
    return { predicate: null, error: 'unsupported-version' }
  }

  const base = itemId ? `minecraft:${itemId}` : 'minecraft:*'

  const entries: string[] = []
  for (const e of enchantments) {
    if (!ID_REGEX.test(e.id)) return { predicate: null, error: 'invalid-id' }
    const levels = levelsClause(e)
    // min > max 的区间永远匹配不到任何东西——报错而不是发一条注定无效的命令
    if (
      typeof e.minLevel === 'number' &&
      typeof e.maxLevel === 'number' &&
      e.minLevel > e.maxLevel
    ) {
      return { predicate: null, error: 'invalid-level-range' }
    }
    entries.push(
      levels
        ? `{enchantments:"minecraft:${e.id}",levels:${levels}}`
        : `{enchantments:"minecraft:${e.id}"}`,
    )
  }

  // 单条件时无需数组包裹（官方两种写法等价，短的那个更易读）
  const component =
    entries.length === 0 ? '' : entries.length === 1 ? `[${entries[0]}]` : `[${entries.join(',')}]`
  return { predicate: `${base}${component}`, error: null }
}

/**
 * 拼装完整 `clear` 命令。
 *
 * `mode`：
 * - `probe`：`maxCount 0` —— **只查不删**，用于「谁有这东西」
 * - `clear`：省略 maxCount —— 清空全部匹配项
 * - `limit`：`maxCount n` —— 只清前 n 个（部分清缴）
 *
 * ⚠️ `/clear` **只对在线玩家生效**（离线目标直接失败）；离线玩家只能读 `.dat` 快照来
 * 「查」，不能清。调用方需自行保证目标是玩家名且在线（本函数不做在线判定——那需要
 * 实例状态，属调用方的上下文）。
 */
export function buildClearCommand(
  playerName: string,
  spec: ClearPredicateSpec,
  mcVersion: string,
  mode: 'probe' | 'clear' | 'limit' = 'clear',
  limit?: number,
): PredicateBuildResult & { command: string | null } {
  const built = buildClearPredicate(spec, mcVersion)
  if (built.error) return { ...built, command: null }

  const player = String(playerName ?? '').trim()
  // 玩家名白名单：官方允许 [A-Za-z0-9_]{3,16}；命令注入面必须挡在拼装层
  if (!/^[A-Za-z0-9_]{3,16}$/.test(player)) {
    return { predicate: null, error: 'invalid-id', command: null }
  }

  let suffix = ''
  if (mode === 'probe') {
    suffix = ' 0'
  } else if (mode === 'limit') {
    // 非正整数会让命令语义变成「只查」或非法。
    // 先判 undefined 再判其余：`Number.isInteger(undefined)` 为 false，但 TS 不会
    // 据此收窄类型，故必须显式排除——否则 `limit` 仍是 `number | undefined`。
    if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
      return { predicate: null, error: 'invalid-level-range', command: null }
    }
    suffix = ` ${limit}`
  }

  return {
    predicate: built.predicate,
    error: null,
    command: `clear ${player} ${built.predicate}${suffix}`,
  }
}

/**
 * 由「原版上限」生成挂端附魔判据：等级 ≥ maxLevel + 1 即为超限。
 *
 * 这是条目 8「非法物品识别」的核心判据：`mc-enchantments.ts` 的 `maxLevel` 是原版
 * 上限，超出即为刷物/挂端产物。用 `min` 表达「≥上限+1」，**纯命令即可匹配**，
 * 无需把玩家背包拉回本地逐格比对。
 */
export function overLimitEnchantments(
  enchantments: Array<{ id: string; maxLevel: number }>,
): EnchantPredicate[] {
  return enchantments
    .filter((e) => Number.isFinite(e.maxLevel) && e.maxLevel > 0)
    .map((e) => ({ id: e.id, minLevel: e.maxLevel + 1 }))
}
