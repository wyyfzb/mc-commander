/**
 * 数据包（datapack）官方命令面：命令拼装 + `list` 响应解析。
 *
 * **与 mods 的区别是根本性的**：`datapacks/` 有官方命令面，可**运行期**启停与排序；
 * `mods/` 只能改文件 + 重启。两条实现路径不通用，不要互相套用。
 *
 * 全部形态依据来自 **MC 26.3 实机实测**（下文的返回原文均为逐字存档）：
 *
 * - 条目形态是 `[<名字> (<来源>)]`，多条之间用 `, ` 连接：
 *   `There are 2 data pack(s) enabled: [vanilla (built-in)], [file/uatpack.zip (world)]`
 * - ⚠️ **两段之间没有任何分隔符**（RCON 把多行返回值拼成一行）：
 *   `…(world)]There are no more data packs available`
 *   ⇒ 解析**不能**按行或按空白切分，必须按 `There are …` 二次匹配。
 * - 报错措辞：`Unknown data pack '<名>'`、`Pack '<名>' is already enabled!`
 * - `create` 的描述**必须带引号**（多词不加引号 → `Incorrect argument for command`），
 *   且名字有服务端字符校验（`Invalid characters in new pack name '<名>'`）。
 */
import { isVersionAtLeast } from '@/lib/mc-version'

/** `/datapack create` 的引入版本（实测边界，见下方 supportsDatapackCreate） */
const DATAPACK_CREATE_SINCE_VERSION = '1.21.6'

/** 列表里的一个数据包：名字 + 来源限定（`built-in` / `world` / …） */
export interface DatapackEntry {
  /** 传给 `enable`/`disable` 的名字（**不含**来源限定），如 `file/uatpack.zip` */
  name: string
  /** 来源限定，如 `built-in` / `world`；列表未给出时为 null */
  source: string | null
}

export interface DatapackListResult {
  /** 已启用；null = 本次响应里没有这一段（如 `list available`） */
  enabled: DatapackEntry[] | null
  /** 可启用但未启用；null = 本次响应里没有这一段（如 `list enabled`）；`[]` = 确实没有更多 */
  available: DatapackEntry[] | null
  /** 解析失败时保留原文（如实展示，不静默给空）；成功时为 null */
  unparsed: string | null
}

export type DatapackBuildError = 'invalid-name' | 'invalid-id' | 'invalid-description'

export interface DatapackBuildResult {
  command: string | null
  error: DatapackBuildError | null
}

/**
 * 名字/ID 的字符集：与列表里出现的形态一致（`vanilla`、`file/uatpack.zip`）。
 * 收得比服务端严——服务端会拒非法字符，但**命令注入**必须在拼装层就挡住。
 */
const NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/

/** 描述里不放行的字符：引号会闭合命令参数，反斜杠是转义起点，控制字符可换行注入 */
function isSafeDescription(text: string): boolean {
  if (!text.trim()) return false
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '"' || ch === '\\') return false
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** 名字统一加引号：实测含 `/` 的名字必须加引号，给 `vanilla` 这类加引号同样被接受 */
function quote(name: string): string {
  return `"${name}"`
}

/** `datapack list [available|enabled]` */
export function buildDatapackListCommand(scope?: 'available' | 'enabled'): string {
  return scope ? `datapack list ${scope}` : 'datapack list'
}

/**
 * `datapack enable <name> [(first|last)|(before|after) <existing>]`
 *
 * `position` 省略即由服务端决定（实测不传也生效）；`before`/`after` 的参照包必须已启用。
 */
export function buildDatapackEnableCommand(
  name: string,
  position?: { at: 'first' | 'last' } | { at: 'before' | 'after'; existing: string },
): DatapackBuildResult {
  if (!NAME_REGEX.test(name)) return { command: null, error: 'invalid-name' }
  let suffix = ''
  if (position) {
    // 用 `'existing' in position` 收窄而不是比字面量：`at` 的两组取值靠 `||` 判不出 else 分支
    if ('existing' in position) {
      if (!NAME_REGEX.test(position.existing)) return { command: null, error: 'invalid-name' }
      suffix = ` ${position.at} ${quote(position.existing)}`
    } else {
      suffix = ` ${position.at}`
    }
  }
  return { command: `datapack enable ${quote(name)}${suffix}`, error: null }
}

/** `datapack disable <name>`（实测 `disable vanilla` 服务端也允许，故不额外拦） */
export function buildDatapackDisableCommand(name: string): DatapackBuildResult {
  if (!NAME_REGEX.test(name)) return { command: null, error: 'invalid-name' }
  return { command: `datapack disable ${quote(name)}`, error: null }
}

/**
 * `datapack create <id> <description>`。
 *
 * `create` 是**较新版本**才有的子命令：1.21.6+（op 4），本次实机只在 26.3 上
 * 验证过它存在，**未取到边界版本**——是否可用应由调用方按目标版本判断，本函数只负责拼装。
 *
 * 描述一律加引号：实测不加引号的多词描述直接被拒（`Incorrect argument for command`）。
 */
export function buildDatapackCreateCommand(id: string, description: string): DatapackBuildResult {
  if (!NAME_REGEX.test(id)) return { command: null, error: 'invalid-id' }
  if (!isSafeDescription(description)) return { command: null, error: 'invalid-description' }
  return { command: `datapack create ${id} ${quote(description)}`, error: null }
}

/** 从 `[<名字> (<来源>)]` 形态的一段里取出条目 */
function parseEntries(section: string): DatapackEntry[] {
  const entries: DatapackEntry[] = []
  for (const m of section.matchAll(/\[([^\]]+)\]/g)) {
    const inner = (m[1] ?? '').trim()
    if (!inner) continue
    // 来源限定是末尾的 `(<来源>)`，名字本身可能带括号（如 `(1)`）——故只剥**末尾**那一处
    const src = /\(([^()]*)\)\s*$/.exec(inner)
    if (src && src.index !== undefined) {
      entries.push({ name: inner.slice(0, src.index).trim(), source: (src[1] ?? '').trim() })
    } else {
      entries.push({ name: inner, source: null })
    }
  }
  return entries
}

/**
 * 解析 `datapack list [available|enabled]` 的返回。
 *
 * 一句话的形态有四种（实测全部取到）：
 * ```text
 * There are N data pack(s) enabled: [a (x)], [b (y)]
 * There are N data pack(s) available: [b (y)]
 * There are no more data packs available
 * （`list` 会同时给出前两段的拼接，中间**没有分隔符**）
 * ```
 * 两种失败都如实返回：整句都不认识 → `unparsed` 保留原文；识别到段名但条目为空 → 空数组。
 */
export function parseDatapackList(response: string): DatapackListResult {
  const text = (response ?? '').trim()
  if (!text) return { enabled: null, available: null, unparsed: '' }

  const enabledAt = text.indexOf('data pack(s) enabled:')
  const availableAt = text.indexOf('data pack(s) available:')
  const noMore = text.includes('There are no more data packs available')

  if (enabledAt === -1 && availableAt === -1 && !noMore) {
    return { enabled: null, available: null, unparsed: text }
  }

  const sectionFrom = (start: number): string => {
    // 段落正文从段名之后开始，到「下一段的段名」或「no more 那句」为止
    const bodyStart = start
    const candidates = [text.length]
    for (const marker of ['There are', 'data pack(s) enabled:', 'data pack(s) available:']) {
      const at = text.indexOf(marker, bodyStart)
      if (at > bodyStart) candidates.push(at)
    }
    if (noMore) {
      const at = text.indexOf('There are no more data packs available', bodyStart)
      if (at > bodyStart) candidates.push(at)
    }
    return text.slice(bodyStart, Math.min(...candidates))
  }

  const enabled =
    enabledAt === -1 ? null : parseEntries(sectionFrom(enabledAt + 'data pack(s) enabled:'.length))
  const available =
    availableAt === -1
      ? noMore
        ? []
        : null
      : parseEntries(sectionFrom(availableAt + 'data pack(s) available:'.length))

  return { enabled, available, unparsed: null }
}

/**
 * 一条 `enable`/`disable`/`create` 的返回分类。
 *
 * 措辞全部取自 **MC 26.3 实机返回原文**（逐字存档）：
 * ```text
 * Enabling data pack [file/uatpack.zip (world)]      启用成功
 * Disabling data pack [vanilla (built-in)]           禁用成功（vanilla 也允许禁）
 * Pack 'file/uatpack.zip' is already enabled!        重复启用——幂等提示，不是失败
 * Unknown data pack 'file/nope.zip'                  名字不存在（enable/disable 同措辞）
 * Created new empty pack with name 'uatcreated'      创建成功
 * Invalid characters in new pack name 'Bad Id!'      名字非法（服务端校验）
 * Incorrect argument for command…                    参数不合法（如描述没加引号）
 * ```
 *
 * 分成逐档而不是「成功/失败」两档：**「已是启用状态」既不是失败也不是成功**——
 * 把它当失败会弹红报错，当成功又会让用户以为这次操作真改了排序。界面据此给出不同反馈。
 *
 * 实测（MC 26.3）：对**已启用**的包执行 `datapack enable <名> first|last`，服务端只回
 * `Pack '<名>' is already enabled!` 且**不动加载顺序** ⇒ 排序只在「尚未启用」时生效。
 * 故「置顶/置底」类的入口只该出现在「可用未启用」一侧。
 */
export type DatapackActionOutcome =
  | { outcome: 'enabled'; entry: DatapackEntry }
  | { outcome: 'disabled'; entry: DatapackEntry }
  /** 已经处于目标状态：幂等提示，不改排序 */
  | { outcome: 'already-enabled'; name: string }
  | { outcome: 'unknown-pack'; name: string }
  | { outcome: 'created'; name: string }
  | { outcome: 'invalid-name'; name: string }
  | { outcome: 'bad-arguments'; detail: string }
  /** 措辞不认识：保留原文让界面如实展示，不猜 */
  | { outcome: 'unrecognized'; raw: string }

/** 从 `Pack '<名>' …` / `Unknown data pack '<名>'` 这类引号形态里取名 */
function quotedName(text: string): string | null {
  const m = /'([^']+)'/.exec(text)
  return m ? (m[1] ?? null) : null
}

export function parseDatapackAction(response: string): DatapackActionOutcome {
  const text = (response ?? '').trim()
  if (!text) return { outcome: 'unrecognized', raw: '' }

  for (const [prefix, outcome] of [
    ['Enabling data pack ', 'enabled'],
    ['Disabling data pack ', 'disabled'],
  ] as const) {
    if (text.startsWith(prefix)) {
      const entries = parseEntries(text.slice(prefix.length))
      // 措辞认识但条目解析不出来 ⇒ 不猜，按未识别处理
      if (entries.length === 1 && entries[0]) return { outcome, entry: entries[0] }
    }
  }

  if (text.startsWith('Pack ') && text.endsWith(' is already enabled!')) {
    const name = quotedName(text)
    if (name) return { outcome: 'already-enabled', name }
  }
  if (text.startsWith('Unknown data pack ')) {
    const name = quotedName(text)
    if (name) return { outcome: 'unknown-pack', name }
  }
  if (text.startsWith('Created new empty pack with name ')) {
    const name = quotedName(text)
    if (name) return { outcome: 'created', name }
  }
  if (text.startsWith('Invalid characters in new pack name ')) {
    const name = quotedName(text)
    if (name) return { outcome: 'invalid-name', name }
  }
  // 参数错误：服务端会把出错位置用 `<--[HERE]` 标出，原文里带这一串
  if (text.startsWith('Incorrect argument for command') || text.includes('<--[HERE]')) {
    return { outcome: 'bad-arguments', detail: text }
  }

  return { outcome: 'unrecognized', raw: text }
}

/**
 * `/datapack create` 是否可用（**实测边界：1.21.6**）。
 *
 * 判据直接取自服务端 jar 本身，不靠猜：jar 内层 `server-<版本>.jar` 里
 * `commands.datapack.create.*` 这组翻译键**只在子命令注册时存在**——1.21.5 只有
 * list/enable/disable/modify 的键，1.21.6 起才有 create（键集与 26.3 逐字一致）。
 * 边界用例连同 jar 的 size/sha1 一起留在 `__tests__/mc-datapack.test.ts`，可复核。
 *
 * 版本比较复用既有的 `compareVersions`（逐段数值），不另写一份解析——字符串比较会把
 * `1.9` 排在 `1.10` 之后，那不是版本序。
 * 版本不可解析（空串/非版本文本）按**支持**处置，与 `pickGameruleSet` 同口径：
 * 未知时不隐藏能力，最坏结果只是服务端回一句措辞（已由 parseDatapackAction 如实分类）。
 */
export function supportsDatapackCreate(mcVersion: string): boolean {
  // 版本不可解析（空串/非版本文本）按「支持」处置：未知时不隐藏能力
  return isVersionAtLeast(mcVersion, DATAPACK_CREATE_SINCE_VERSION, true)
}
