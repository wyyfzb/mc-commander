/**
 * gamerule 双版本**文案资源** + 命令拼装与取值校验单测
 * 数据基准：中文 Minecraft Wiki；官方名单与取值边界另有一份**实测 oracle**（见文件末尾夹具）
 * 重点防护：1.21.11 版本阈值数值化比较（1.21.2 vs 1.21.11 字符串坑）、文案表键名对齐、
 * 取值区间边界（越界值在服务端是静默成功，只能在客户端拦）
 *
 * 名单不在这张表里：一台服务器有哪些规则由服务器自述，本表只提供中文名/描述/分类。
 */
import { describe, expect, it } from 'vitest'
import {
  GAMERULE_CATEGORY_LABELS,
  GAMERULE_INT_MAX,
  GAMERULE_INT_RANGES,
  LEGACY_GAMERULES,
  MINECRAFT_GAMERULES,
  buildGameruleSetCommand,
  gameruleValueError,
  pickGameruleSet,
  type GameruleDef,
} from '@/lib/mc-gamerules'

const findNew = (name: string): GameruleDef => MINECRAFT_GAMERULES.find((d) => d.name === name)!
const findLegacy = (name: string): GameruleDef => LEGACY_GAMERULES.find((d) => d.name === name)!

// ── 官方 oracle 夹具（**实测样本**，非文档抄录）──────────────────────────────
//
// 版本：Minecraft **26.3**（官方 server.jar，java 25，`-Xmx1G`，一次性 /tmp 实例，flat 新世界）
// 取法（两个命令的原文，均经 RCON 下发）：
//   ① 全量规则名 —— `help gamerule`
//      回的是 Brigadier 用法列表（每条形如 `/gamerule advance_time [<value>]`，带
//      `minecraft:` 前缀的重复项去掉后共 **58 条**）。裸 `gamerule` 在 26.3 上不是合法
//      命令（回 `Unknown or incomplete command`），全量名字只能这样取。
//   ② 每条当前值 —— `gamerule <name>`
//      回包形状 `Game rule <name> is currently set to <true|false|-?\d+>`；值的形状同时
//      给出 bool/int 的事实判定。读取发生在**空世界首启之后**，故这些值即 26.3 的默认值。
// 采集方式：起一个一次性 MC 服务端（官方 server.jar、flat 新世界），用 RCON 下发上面两条
// 命令取回结果，重采后整体替换本夹具。
// 刷新时机：升 MC 版本、或给面板表加规则时，重采一次并整体替换本夹具——
//   转红是提示「夹具该更新了」，不是回归。
const OFFICIAL_26_3: ReadonlyArray<readonly [name: string, type: 'bool' | 'int', value: string]> = [
  ['advance_time', 'bool', 'true'],
  ['advance_weather', 'bool', 'true'],
  ['allow_entering_nether_using_portals', 'bool', 'true'],
  ['block_drops', 'bool', 'true'],
  ['block_explosion_drop_decay', 'bool', 'true'],
  ['command_block_output', 'bool', 'true'],
  ['command_blocks_work', 'bool', 'true'],
  ['drowning_damage', 'bool', 'true'],
  ['elytra_movement_check', 'bool', 'true'],
  ['ender_pearls_vanish_on_death', 'bool', 'true'],
  ['entity_drops', 'bool', 'true'],
  ['fall_damage', 'bool', 'true'],
  ['fire_damage', 'bool', 'true'],
  ['fire_spread_radius_around_player', 'int', '128'],
  ['forgive_dead_players', 'bool', 'true'],
  ['freeze_damage', 'bool', 'true'],
  ['global_sound_events', 'bool', 'true'],
  ['immediate_respawn', 'bool', 'false'],
  ['keep_inventory', 'bool', 'false'],
  ['lava_source_conversion', 'bool', 'false'],
  ['limited_crafting', 'bool', 'false'],
  ['locator_bar', 'bool', 'true'],
  ['log_admin_commands', 'bool', 'true'],
  ['max_block_modifications', 'int', '32768'],
  ['max_command_forks', 'int', '65536'],
  ['max_command_sequence_length', 'int', '65536'],
  ['max_entity_cramming', 'int', '24'],
  ['max_snow_accumulation_height', 'int', '1'],
  ['mob_drops', 'bool', 'true'],
  ['mob_explosion_drop_decay', 'bool', 'true'],
  ['mob_griefing', 'bool', 'true'],
  ['natural_health_regeneration', 'bool', 'true'],
  ['player_movement_check', 'bool', 'true'],
  ['players_nether_portal_creative_delay', 'int', '0'],
  ['players_nether_portal_default_delay', 'int', '80'],
  ['players_sleeping_percentage', 'int', '100'],
  ['projectiles_can_break_blocks', 'bool', 'true'],
  ['pvp', 'bool', 'true'],
  ['raids', 'bool', 'true'],
  ['random_tick_speed', 'int', '3'],
  ['reduced_debug_info', 'bool', 'false'],
  ['respawn_radius', 'int', '10'],
  ['send_command_feedback', 'bool', 'true'],
  ['show_advancement_messages', 'bool', 'true'],
  ['show_death_messages', 'bool', 'true'],
  ['spawn_mobs', 'bool', 'true'],
  ['spawn_monsters', 'bool', 'true'],
  ['spawn_patrols', 'bool', 'true'],
  ['spawn_phantoms', 'bool', 'true'],
  ['spawn_wandering_traders', 'bool', 'true'],
  ['spawn_wardens', 'bool', 'true'],
  ['spawner_blocks_work', 'bool', 'true'],
  ['spectators_generate_chunks', 'bool', 'true'],
  ['spread_vines', 'bool', 'true'],
  ['tnt_explodes', 'bool', 'true'],
  ['tnt_explosion_drop_decay', 'bool', 'false'],
  ['universal_anger', 'bool', 'false'],
  ['water_source_conversion', 'bool', 'true'],
]

/**
 * 26.3 数值型规则的实测边界（探法：对每条先试下界-1、再试下界，上界同理）。
 * 判据是服务端自己的回包，例如：
 *   gamerule random_tick_speed -1 → `Integer must not be less than 0: found -1`
 *   gamerule max_snow_accumulation_height 9 → `Integer must not be more than 8: found 9`
 * `GAMERULE_INT_MAX` ＝ 规则级无额外上限（实测接受 2000000000），上界只由命令的整数解析给出。
 * 与 25w44a changelog 冲突处以实测为准：它记 max_command_forks / max_entity_cramming 最小 1，
 * 实测 26.3 对 0 放行、对 -1 报「less than 0」。
 */
const OFFICIAL_26_3_INT_BOUNDS: Readonly<Record<string, { min: number; max: number }>> = {
  fire_spread_radius_around_player: { min: -1, max: GAMERULE_INT_MAX },
  max_block_modifications: { min: 1, max: GAMERULE_INT_MAX },
  max_command_forks: { min: 0, max: GAMERULE_INT_MAX },
  max_command_sequence_length: { min: 0, max: GAMERULE_INT_MAX },
  max_entity_cramming: { min: 0, max: GAMERULE_INT_MAX },
  max_snow_accumulation_height: { min: 0, max: 8 },
  players_nether_portal_creative_delay: { min: 0, max: GAMERULE_INT_MAX },
  players_nether_portal_default_delay: { min: 0, max: GAMERULE_INT_MAX },
  players_sleeping_percentage: { min: 0, max: GAMERULE_INT_MAX },
  random_tick_speed: { min: 0, max: GAMERULE_INT_MAX },
  respawn_radius: { min: 0, max: GAMERULE_INT_MAX },
}

/**
 * 1.21.11 实测边界（官方 server.jar，一次性 flat 实例，RCON；新命名体系的最早 release）。
 * 探法与 26.3 同：每条键试 min-1 / min / max / max+1，判据是服务端回包
 * （`Integer must not be less than N` / `must not be more than N` / `Invalid integer`）。
 * 规则名：`help gamerule` 回 116 条用法 = 58 条裸 snake_case 名 + 58 条 `minecraft:` 前缀重复项，
 * 去掉前缀后与 26.3 是同一集合（含本表 11 条）；裸名与带前缀两种写法都能下发命令。
 */
const OFFICIAL_1_21_11_INT_BOUNDS: Readonly<Record<string, { min: number; max: number }>> = {
  fire_spread_radius_around_player: { min: -1, max: GAMERULE_INT_MAX },
  max_block_modifications: { min: 1, max: GAMERULE_INT_MAX },
  max_command_forks: { min: 0, max: GAMERULE_INT_MAX },
  max_command_sequence_length: { min: 0, max: GAMERULE_INT_MAX },
  max_entity_cramming: { min: 0, max: GAMERULE_INT_MAX },
  max_snow_accumulation_height: { min: 0, max: 8 },
  players_nether_portal_creative_delay: { min: 0, max: GAMERULE_INT_MAX },
  players_nether_portal_default_delay: { min: 0, max: GAMERULE_INT_MAX },
  players_sleeping_percentage: { min: 0, max: GAMERULE_INT_MAX },
  random_tick_speed: { min: 0, max: GAMERULE_INT_MAX },
  respawn_radius: { min: 0, max: GAMERULE_INT_MAX },
}

describe('双版本数据（计数/类型/唯一性）', () => {
  it('新集 58 条 / 旧集 57 条', () => {
    expect(MINECRAFT_GAMERULES.length).toBe(58)
    expect(LEGACY_GAMERULES.length).toBe(57)
  })

  it('类型分布：新集 bool 47 + int 11，旧集 bool 47 + int 10', () => {
    expect(MINECRAFT_GAMERULES.filter((d) => d.type === 'bool').length).toBe(47)
    expect(MINECRAFT_GAMERULES.filter((d) => d.type === 'int').length).toBe(11)
    expect(LEGACY_GAMERULES.filter((d) => d.type === 'bool').length).toBe(47)
    expect(LEGACY_GAMERULES.filter((d) => d.type === 'int').length).toBe(10)
  })

  it('两集内部名字唯一（大小写不敏感）', () => {
    for (const defs of [MINECRAFT_GAMERULES, LEGACY_GAMERULES]) {
      const lower = defs.map((d) => d.name.toLowerCase())
      expect(new Set(lower).size).toBe(defs.length)
    }
  })

  it('数据质量：每条都有名字/分类/描述（文案资源不得留空壳）', () => {
    for (const defs of [MINECRAFT_GAMERULES, LEGACY_GAMERULES]) {
      for (const d of defs) {
        expect(d.name, '名字为空').not.toBe('')
        expect(typeof d.category, `${d.name} 的分类`).toBe('string')
        // 描述缺失时面板那一列会整列空白——文案表的存在意义就是填这一列
        expect(d.desc.length, `${d.name} 缺描述`).toBeGreaterThan(0)
      }
    }
  })

  it('新集分类仅含 7 个已知分类；旧集分类全部为空串', () => {
    expect(new Set(MINECRAFT_GAMERULES.map((d) => d.category))).toEqual(
      new Set(['世界更新', '掉落', '聊天', '杂项', '玩家', '生物', '生成']),
    )
    expect(new Set(LEGACY_GAMERULES.map((d) => d.category))).toEqual(new Set(['']))
  })

  it('旧集 disable 系描述写的是「停止/禁用」语义（换名时语义方向不得跟着反向）', () => {
    // 1.21.11 把 disable* 取反成正向名（disableRaids → raids）；旧册的描述若被顺手改成
    // 「是否启用」，两册对同一条规则的说法就互相矛盾
    expect(findLegacy('disableElytraMovementCheck').desc).toContain('停止检查')
    expect(findLegacy('disablePlayerMovementCheck').desc).toContain('停止检查并限制')
    expect(findLegacy('disableRaids').desc).toContain('禁用袭击')
  })

  it('1.21.11+ 上所有规则名必须是 snake_case 资源位置（改名后不得退回 camelCase）', () => {
    for (const d of MINECRAFT_GAMERULES) {
      // 官方 25w44a 起规则迁入注册表并改为 snake_case；camelCase 名在 1.21.11+ 会被
      // 判为未知规则，命令静默失败而界面仍显示成功
      expect(d.name, `${d.name} 不是 snake_case`).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
    }
  })

  it('旧集保留 camelCase（1.21.11 前确实是 camelCase，不得误改为 snake_case）', () => {
    // 计数即守卫：若旧集被误改，含下划线的条目会 > 0
    const snakeLike = LEGACY_GAMERULES.filter((d) => d.name.includes('_'))
    expect(snakeLike.map((d) => d.name)).toEqual([])
  })

  it('新集 spawn_mobs/doDaylightCycle 对应关系抽查（新名存在、旧名消失）', () => {
    expect(findNew('spawn_mobs').type).toBe('bool')
    expect(MINECRAFT_GAMERULES.find((d) => d.name === 'doDaylightCycle')).toBeUndefined()
    // 同一语义两册描述一致：昼夜更替在 26.x 改叫 advance_time，语义没变
    expect(findLegacy('doDaylightCycle').desc).toBe(findNew('advance_time').desc)
  })

  it('三条语义取反规则：新集是正向名，旧集是 disable 系，两册描述同源', () => {
    // raids / elytra_movement_check / player_movement_check 在 25w44a 由 disable* 取反而来；
    // 名字换了，描述说的是同一件事
    const pairs: Array<[string, string]> = [
      ['raids', 'disableRaids'],
      ['elytra_movement_check', 'disableElytraMovementCheck'],
      ['player_movement_check', 'disablePlayerMovementCheck'],
    ]
    for (const [newName, oldName] of pairs) {
      expect(findNew(newName).type, newName).toBe('bool')
      expect(findLegacy(oldName).type, oldName).toBe('bool')
    }
  })
})

describe('pickGameruleSet（1.21.11 数值化阈值）', () => {
  it('1.21.11 及以上 → 新集', () => {
    for (const v of ['1.21.11', '1.21.12', '1.21.20', '1.22', '1.23', '2.0', '26.1', '26.1.1']) {
      expect(pickGameruleSet(v)).toBe(MINECRAFT_GAMERULES)
    }
  })

  it('1.21.11 以下 → 旧集（含字符串坑「1.21.2」）', () => {
    for (const v of [
      '1.21.10',
      '1.21.9',
      '1.21.2',
      '1.21',
      '1.21.1',
      '1.20.5',
      '1.20.1',
      '1.16.5',
      '1.12.2',
    ]) {
      expect(pickGameruleSet(v)).toBe(LEGACY_GAMERULES)
    }
  })

  it('空串/非版本 → 新集（未知按最新，与 NBT 三格式判定一致）', () => {
    expect(pickGameruleSet('')).toBe(MINECRAFT_GAMERULES)
    expect(pickGameruleSet('abc')).toBe(MINECRAFT_GAMERULES)
    expect(pickGameruleSet('latest')).toBe(MINECRAFT_GAMERULES)
  })
})

describe('buildGameruleSetCommand / 分类标签', () => {
  it('拼装命令无前导 /（与 buildGiveCommand 一致）', () => {
    expect(buildGameruleSetCommand('keep_inventory', 'true')).toBe('gamerule keep_inventory true')
    expect(buildGameruleSetCommand('random_tick_speed', '3')).toBe('gamerule random_tick_speed 3')
    expect(buildGameruleSetCommand('pvp', 'false')).not.toMatch(/^\//)
  })

  it('分类标签：旧集空串 → 「其他」，新集分类映射自身', () => {
    expect(GAMERULE_CATEGORY_LABELS['']).toBe('其他')
    for (const category of new Set(MINECRAFT_GAMERULES.map((d) => d.category))) {
      expect(GAMERULE_CATEGORY_LABELS[category]).toBe(category)
    }
    for (const d of LEGACY_GAMERULES) {
      expect(GAMERULE_CATEGORY_LABELS[d.category]).toBe('其他')
    }
  })
})

describe('守卫一：文案表覆盖 26.3 官方名单（oracle = 26.3 实测，见上方夹具）', () => {
  // 名单由服务器自述，漏一条不会再让用户改不到它；但文案表缺一条就意味着那一行
  // 只剩原始名、没有中文描述，故仍按 26.3 的实测名单对齐文案覆盖
  it('新集每一条都在 26.3 官方名单里（名字写错/陈旧 → 红）', () => {
    const official = new Set(OFFICIAL_26_3.map(([name]) => name))
    const orphans = MINECRAFT_GAMERULES.filter((d) => !official.has(d.name)).map((d) => d.name)
    expect(orphans).toEqual([])
  })

  it('反向覆盖：26.3 官方每一条都有文案条目（缺一条 = 那一行只剩原始名）', () => {
    const panel = new Set(MINECRAFT_GAMERULES.map((d) => d.name))
    const missing = OFFICIAL_26_3.filter(([name]) => !panel.has(name)).map(([name]) => name)
    expect(missing).toEqual([])
  })

  it('类型与 26.3 实测一致（把规则的 bool/int 标错 → 红）', () => {
    for (const [name, type] of OFFICIAL_26_3) {
      const row = findNew(name)
      expect(row, `${name} 不在文案表里`).toBeDefined()
      expect(row.type, `${name} 的类型`).toBe(type)
    }
  })

  it('夹具自身完整：58 条且名字唯一（与 26.3 的 help gamerule 条数一致）', () => {
    expect(OFFICIAL_26_3.length).toBe(58)
    expect(new Set(OFFICIAL_26_3.map(([name]) => name)).size).toBe(58)
  })

  it('旧集（1.20.5–1.21.10）无 oracle：57 条里只有 pvp 与 26.3 同名，本夹具判不了它', () => {
    // 旧集是 camelCase 的另一套命名体系（改名时只有 pvp 没被改），26.3 的名单判不了其余 56 条。
    // 该区间的集合断言需要另采一次 1.21.8 / 1.20.5 服务端 oracle，本轮未做——
    // 这里把「未覆盖」显式钉住，避免被当成「已通过」。
    const official = new Set(OFFICIAL_26_3.map(([name]) => name))
    const shared = LEGACY_GAMERULES.filter((d) => official.has(d.name)).map((d) => d.name)
    expect(shared).toEqual(['pvp'])
  })
})

describe('守卫二：数值型规则的取值区间（边界来自 1.21.11 与 26.3 两次实测）', () => {
  it('区间表完整覆盖新集里的 int 规则（新增 int 规则必须同时给出实测区间）', () => {
    const intRuleNames = MINECRAFT_GAMERULES.filter((d) => d.type === 'int')
      .map((d) => d.name)
      .sort()
    expect(Object.keys(GAMERULE_INT_RANGES).sort()).toEqual(intRuleNames)
  })

  it('区间表与 26.3 实测边界逐条一致（边界值改错 → 红）', () => {
    for (const [name, bounds] of Object.entries(OFFICIAL_26_3_INT_BOUNDS)) {
      expect(GAMERULE_INT_RANGES[name], `${name} 缺区间`).toEqual(bounds)
    }
  })

  it('区间表与 1.21.11 实测边界逐条一致（两次取样口径相同，任一侧改动都会红）', () => {
    for (const [name, bounds] of Object.entries(OFFICIAL_1_21_11_INT_BOUNDS)) {
      expect(GAMERULE_INT_RANGES[name], `${name} 在 1.21.11 上缺区间`).toEqual(bounds)
    }
    // 两份夹具若漂移，上一条会失去"同一张表同时覆盖两个版本"的意义
    expect(Object.keys(OFFICIAL_1_21_11_INT_BOUNDS).sort()).toEqual(
      Object.keys(OFFICIAL_26_3_INT_BOUNDS).sort(),
    )
  })

  it('1.21.11 命名体系：实测 11 条整数规则全为 snake_case 资源位置（改回 camelCase → 红）', () => {
    // 1.21.11 起规则名是注册表资源位置；camelCase 名该版本已不接受（命令回
    // Incorrect argument），界面却照常显示成功。故这一侧只锁名字形状与类型。
    for (const name of Object.keys(OFFICIAL_1_21_11_INT_BOUNDS)) {
      expect(name, `${name} 不是 snake_case 资源位置`).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
      expect(findNew(name).type, `${name} 的规则类型`).toBe('int')
    }
  })

  it('边界值放行、越界值拦下（每条 int 规则双向验证）', () => {
    for (const [name, bounds] of Object.entries(OFFICIAL_26_3_INT_BOUNDS)) {
      const def = findNew(name)
      expect(gameruleValueError(def, String(bounds.min)), `${name} 下界`).toBeNull()
      expect(gameruleValueError(def, String(bounds.max)), `${name} 上界`).toBeNull()
      expect(gameruleValueError(def, String(bounds.min - 1)), `${name} 下界-1`).not.toBeNull()
      if (bounds.max < GAMERULE_INT_MAX) {
        expect(gameruleValueError(def, String(bounds.max + 1)), `${name} 上界+1`).not.toBeNull()
      }
    }
  })

  it('逐条对照服务端回包里的越界实例（random_tick_speed -1 / 雪高 9）', () => {
    expect(gameruleValueError(findNew('random_tick_speed'), '-1')).toContain('不得小于 0')
    expect(gameruleValueError(findNew('max_snow_accumulation_height'), '9')).toContain('不得大于 8')
    // 实测反例：players_sleeping_percentage 接受 101（没有 0–100 上限）、火蔓延半径接受 -1
    expect(gameruleValueError(findNew('players_sleeping_percentage'), '101')).toBeNull()
    expect(gameruleValueError(findNew('fire_spread_radius_around_player'), '-1')).toBeNull()
  })

  it('bool 规则只接受 true / false，非整数的 int 值拦下', () => {
    expect(gameruleValueError(findNew('keep_inventory'), 'true')).toBeNull()
    expect(gameruleValueError(findNew('keep_inventory'), 'false')).toBeNull()
    expect(gameruleValueError(findNew('keep_inventory'), '1')).not.toBeNull()
    // 服务端对这些形状的回包（Expected integer / Invalid integer）同样不在失败短语表里
    expect(gameruleValueError(findNew('random_tick_speed'), '3.5')).not.toBeNull()
    expect(gameruleValueError(findNew('random_tick_speed'), 'abc')).not.toBeNull()
    expect(gameruleValueError(findNew('random_tick_speed'), String(GAMERULE_INT_MAX))).toBeNull()
    expect(gameruleValueError(findNew('random_tick_speed'), '2147483648')).not.toBeNull()
  })

  it('区间表里没有的规则不猜区间（旧命名体系一律放行）', () => {
    for (const d of LEGACY_GAMERULES.filter((x) => x.type === 'int')) {
      expect(gameruleValueError(d, '-1')).toBeNull()
      expect(gameruleValueError(d, '999999999')).toBeNull()
    }
  })
})
