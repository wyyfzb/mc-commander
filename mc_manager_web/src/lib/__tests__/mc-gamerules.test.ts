/**
 * gamerule 双版本数据 + 查询解析单测
 * 数据基准：中文 Minecraft Wiki
 * 重点防护：1.21.11 版本阈值数值化比较（1.21.2 vs 1.21.11 字符串坑）、disable 系语义反转、解析降级 1/3 阈值
 */
import { describe, expect, it } from 'vitest'
import {
  GAMERULE_CATEGORY_LABELS,
  GAMERULE_QUERY_COMMAND,
  LEGACY_GAMERULES,
  MINECRAFT_GAMERULES,
  buildGameruleSetCommand,
  gameruleDisplayValue,
  parseGameruleOutput,
  pickGameruleSet,
  type GameruleDef,
} from '../mc-gamerules'

/** 造一批同构 int 规则（阈值测试用） */
function makeDefs(names: string[]): GameruleDef[] {
  return names.map((name) => ({ name, type: 'int', defaultValue: '0', category: '', desc: '' }))
}

/** 解析测试用固定规则集（5 条 → 1/3 阈值 ≈ 1.67，≥2 条即成功） */
const parseDefs: GameruleDef[] = [
  { name: 'advance_time', type: 'bool', defaultValue: true, category: '', desc: '' },
  { name: 'max_block_modifications', type: 'int', defaultValue: '32768', category: '', desc: '' },
  { name: 'pvp', type: 'bool', defaultValue: true, category: '', desc: '' },
  { name: 'random_tick_speed', type: 'int', defaultValue: '3', category: '', desc: '' },
  { name: 'spawn_mobs', type: 'bool', defaultValue: true, category: '', desc: '' },
]

const findNew = (name: string): GameruleDef => MINECRAFT_GAMERULES.find((d) => d.name === name)!
const findLegacy = (name: string): GameruleDef => LEGACY_GAMERULES.find((d) => d.name === name)!

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

  it('数据质量：bool 默认值为布尔、int 默认值为数字字符串', () => {
    for (const defs of [MINECRAFT_GAMERULES, LEGACY_GAMERULES]) {
      for (const d of defs) {
        if (d.type === 'bool') {
          expect(typeof d.defaultValue).toBe('boolean')
        } else {
          expect(typeof d.defaultValue).toBe('string')
          expect(/^-?\d+$/.test(String(d.defaultValue))).toBe(true)
        }
      }
    }
  })

  it('新集分类仅含 7 个已知分类；旧集分类全部为空串', () => {
    expect(new Set(MINECRAFT_GAMERULES.map((d) => d.category))).toEqual(
      new Set(['世界更新', '掉落', '聊天', '杂项', '玩家', '生物', '生成']),
    )
    expect(new Set(LEGACY_GAMERULES.map((d) => d.category))).toEqual(new Set(['']))
  })

  it('旧集 disable 系默认 false（语义反转防护：disable 系描述为"停止/禁用"语义，默认应为 false）', () => {
    expect(findLegacy('disableElytraMovementCheck').defaultValue).toBe(false)
    expect(findLegacy('disablePlayerMovementCheck').defaultValue).toBe(false)
    expect(findLegacy('disableRaids').defaultValue).toBe(false)
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
    expect(findLegacy('doDaylightCycle').defaultValue).toBe(true)
  })

  it('三条语义取反规则：新集用正向名且默认 true，旧集用 disable 系且默认 false', () => {
    // raids / elytra_movement_check / player_movement_check 在 25w44a 由 disable* 取反而来；
    // 只换名不改语义方向会让开关效果整体反向
    expect(findNew('raids').defaultValue).toBe(true)
    expect(findNew('elytra_movement_check').defaultValue).toBe(true)
    expect(findNew('player_movement_check').defaultValue).toBe(true)
    expect(findLegacy('disableRaids').defaultValue).toBe(false)
    expect(findLegacy('disableElytraMovementCheck').defaultValue).toBe(false)
    expect(findLegacy('disablePlayerMovementCheck').defaultValue).toBe(false)
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

  it('查询命令常量（无参 RCON 查询）', () => {
    expect(GAMERULE_QUERY_COMMAND).toBe('gamerule')
  })
})

describe('parseGameruleOutput（RCON 响应解析）', () => {
  it('标准多行解析：名字/值提取，输出规范名（1.21.11+ snake_case 形状）', () => {
    const out = [
      'advance_time = true',
      'max_block_modifications = 32768',
      'pvp = false',
      'random_tick_speed = 3',
      'spawn_mobs = true',
    ].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result).not.toBeNull()
    expect(result!.size).toBe(5)
    expect(result!.get('advance_time')).toBe('true')
    expect(result!.get('max_block_modifications')).toBe('32768')
    expect(result!.get('pvp')).toBe('false')
    expect(result!.get('random_tick_speed')).toBe('3')
    expect(result!.get('spawn_mobs')).toBe('true')
  })

  it('带命名空间的名字（minecraft:advance_time）同样命中', () => {
    // 1.21.11-pre1 起规则名默认命名空间为 minecraft，响应可能带前缀
    const out = ['minecraft:advance_time = true', 'minecraft:pvp = false'].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result!.get('advance_time')).toBe('true')
    expect(result!.get('pvp')).toBe('false')
  })

  it('容忍首行提示/空行（非规则行跳过）', () => {
    const out = ['Game rules:', '', 'advance_time = true', '   pvp = false   '].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result!.get('advance_time')).toBe('true')
    expect(result!.get('pvp')).toBe('false')
  })

  it('名字大小写不敏感（值按原样保留），无等号间隔也兼容', () => {
    const out = ['ADVANCE_TIME = true', 'Max_Block_Modifications=100', 'PVP = false'].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result!.get('advance_time')).toBe('true')
    expect(result!.get('max_block_modifications')).toBe('100')
    expect(result!.get('pvp')).toBe('false')
  })

  it('defs 没有的名字/非法值/乱码行跳过（旧版规则集小于前端 defs 场景）', () => {
    const out = [
      'unknown_rule = 5',
      'time = 12',
      'badvalue = maybe',
      'noEqualsLine',
      'advance_time = true',
      'random_tick_speed = -3',
      'pvp = false',
      '',
    ].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result!.size).toBe(3)
    expect(result!.get('random_tick_speed')).toBe('-3')
    expect(result!.has('unknown_rule')).toBe(false)
    expect(result!.has('time')).toBe(false)
  })

  it('空输出 / 全未知行 → null（解析失败降级）', () => {
    expect(parseGameruleOutput('', parseDefs)).toBeNull()
    expect(parseGameruleOutput('no output at all\n', parseDefs)).toBeNull()
    expect(parseGameruleOutput('unknown_rule = 5\nfoo = 1', parseDefs)).toBeNull()
    expect(parseGameruleOutput('advance_time = true', [])).toBeNull()
  })

  it('1/3 阈值：解析不足 defs 1/3 → null，恰好 1/3 → 成功', () => {
    const defs12 = makeDefs(Array.from({ length: 12 }, (_, i) => `rule${i}`))
    const three = ['rule0 = 1', 'rule1 = 2', 'rule2 = 3']
    expect(parseGameruleOutput(three.join('\n'), defs12)).toBeNull()
    // 恰好 12/3 = 4 条 → 非 null
    const four = [...three, 'rule3 = 4']
    const result = parseGameruleOutput(four.join('\n'), defs12)
    expect(result).not.toBeNull()
    expect(result!.size).toBe(4)
  })

  it('真实新集集成：25 条输出 → 非 null 且值正确', () => {
    const subset = MINECRAFT_GAMERULES.slice(0, 25)
    const out = subset.map((d) => `${d.name} = ${String(d.defaultValue)}`).join('\n')
    const result = parseGameruleOutput(out, MINECRAFT_GAMERULES)
    expect(result).not.toBeNull()
    expect(result!.size).toBe(25)
    expect(result!.get(subset[0]!.name)).toBe(String(subset[0]!.defaultValue))
  })
})

describe('buildGameruleSetCommand / gameruleDisplayValue / 分类标签', () => {
  it('拼装命令无前导 /（与 buildGiveCommand 一致）', () => {
    expect(buildGameruleSetCommand('keep_inventory', 'true')).toBe('gamerule keep_inventory true')
    expect(buildGameruleSetCommand('random_tick_speed', '3')).toBe('gamerule random_tick_speed 3')
    expect(buildGameruleSetCommand('pvp', 'false')).not.toMatch(/^\//)
  })

  it('当前值显示：undefined → 默认值 + 「默认」标记；有值 → 原值', () => {
    expect(gameruleDisplayValue(findNew('keep_inventory'), undefined)).toBe('false（默认）')
    expect(gameruleDisplayValue(findNew('keep_inventory'), 'true')).toBe('true')
    expect(gameruleDisplayValue(findNew('random_tick_speed'), undefined)).toBe('3（默认）')
    expect(gameruleDisplayValue(findNew('random_tick_speed'), '1')).toBe('1')
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
