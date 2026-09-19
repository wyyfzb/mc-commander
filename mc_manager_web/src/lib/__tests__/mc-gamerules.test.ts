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
  { name: 'advanceTime', type: 'bool', defaultValue: true, category: '', desc: '' },
  { name: 'maxBlockModifications', type: 'int', defaultValue: '32768', category: '', desc: '' },
  { name: 'pvp', type: 'bool', defaultValue: true, category: '', desc: '' },
  { name: 'randomTickSpeed', type: 'int', defaultValue: '3', category: '', desc: '' },
  { name: 'spawnMobs', type: 'bool', defaultValue: true, category: '', desc: '' },
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

  it('新集 spawnMobs/doDaylightCycle 对应关系抽查（新名存在、旧名消失）', () => {
    expect(findNew('spawnMobs').type).toBe('bool')
    expect(MINECRAFT_GAMERULES.find((d) => d.name === 'doDaylightCycle')).toBeUndefined()
    expect(findLegacy('doDaylightCycle').defaultValue).toBe(true)
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
  it('标准多行解析：名字/值提取，输出规范名', () => {
    const out = [
      'advanceTime = true',
      'maxBlockModifications = 32768',
      'pvp = false',
      'randomTickSpeed = 3',
      'spawnMobs = true',
    ].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result).not.toBeNull()
    expect(result!.size).toBe(5)
    expect(result!.get('advanceTime')).toBe('true')
    expect(result!.get('maxBlockModifications')).toBe('32768')
    expect(result!.get('pvp')).toBe('false')
    expect(result!.get('randomTickSpeed')).toBe('3')
    expect(result!.get('spawnMobs')).toBe('true')
  })

  it('容忍首行提示/空行（非规则行跳过）', () => {
    const out = ['Game rules:', '', 'advanceTime = true', '   pvp = false   '].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result!.get('advanceTime')).toBe('true')
    expect(result!.get('pvp')).toBe('false')
  })

  it('名字大小写不敏感（值按原样保留），无等号间隔也兼容', () => {
    const out = ['ADVANCETIME = true', 'MaxBlockModifications=100', 'PVP = false'].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result!.get('advanceTime')).toBe('true')
    expect(result!.get('maxBlockModifications')).toBe('100')
    expect(result!.get('pvp')).toBe('false')
  })

  it('defs 没有的名字/非法值/乱码行跳过（旧版规则集小于前端 defs 场景）', () => {
    const out = [
      'unknownRule = 5',
      'time = 12',
      'badvalue = maybe',
      'noEqualsLine',
      'advanceTime = true',
      'randomTickSpeed = -3',
      'pvp = false',
      '',
    ].join('\n')
    const result = parseGameruleOutput(out, parseDefs)
    expect(result!.size).toBe(3)
    expect(result!.get('randomTickSpeed')).toBe('-3')
    expect(result!.has('unknownRule')).toBe(false)
    expect(result!.has('time')).toBe(false)
  })

  it('空输出 / 全未知行 → null（解析失败降级）', () => {
    expect(parseGameruleOutput('', parseDefs)).toBeNull()
    expect(parseGameruleOutput('no output at all\n', parseDefs)).toBeNull()
    expect(parseGameruleOutput('unknownRule = 5\nfoo = 1', parseDefs)).toBeNull()
    expect(parseGameruleOutput('advanceTime = true', [])).toBeNull()
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
    expect(buildGameruleSetCommand('keepInventory', 'true')).toBe('gamerule keepInventory true')
    expect(buildGameruleSetCommand('randomTickSpeed', '3')).toBe('gamerule randomTickSpeed 3')
    expect(buildGameruleSetCommand('pvp', 'false')).not.toMatch(/^\//)
  })

  it('当前值显示：undefined → 默认值 + 「默认」标记；有值 → 原值', () => {
    expect(gameruleDisplayValue(findNew('keepInventory'), undefined)).toBe('false（默认）')
    expect(gameruleDisplayValue(findNew('keepInventory'), 'true')).toBe('true')
    expect(gameruleDisplayValue(findNew('randomTickSpeed'), undefined)).toBe('3（默认）')
    expect(gameruleDisplayValue(findNew('randomTickSpeed'), '1')).toBe('1')
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
