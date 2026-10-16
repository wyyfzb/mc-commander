/**
 * server.properties 属性元数据单测（键集合口径对照服务端
 * services/instance-properties.service.js 的 WRITABLE_PROPERTIES / SENSITIVE_PROPERTIES，
 * 热改键对照 mc-server/msmp-methods.js 的 SERVER_SETTING_METHODS）
 */
import { describe, expect, it } from 'vitest'
import {
  buildPropertiesPayload,
  buildUnknownPropertyDef,
  HOT_RELOAD_KEYS,
  isPanelManagedProperty,
  isBoolValue,
  SENSITIVE_PROPERTY_KEYS,
  SENSITIVE_PROPERTY_PLACEHOLDER,
  SERVER_PROPERTY_DEFS,
  SERVER_PROPERTY_DEF_MAP,
} from '@/lib/mc-properties'

describe('SERVER_PROPERTY_DEFS 总量与分类分布（73 条 = 18/17/38）', () => {
  it('共 73 条且键名唯一', () => {
    expect(SERVER_PROPERTY_DEFS).toHaveLength(73)
    const names = SERVER_PROPERTY_DEFS.map((d) => d.name)
    expect(new Set(names).size).toBe(73)
  })

  it('三分类分布 gameplay 18 / worldGen 17 / serverSettings 38', () => {
    const count = (cat: string) => SERVER_PROPERTY_DEFS.filter((d) => d.category === cat).length
    expect(count('gameplay')).toBe(18)
    expect(count('worldGen')).toBe(17)
    expect(count('serverSettings')).toBe(38)
  })

  it('分类取值合法（无其他类别）', () => {
    for (const def of SERVER_PROPERTY_DEFS) {
      expect(['gameplay', 'worldGen', 'serverSettings']).toContain(def.category)
    }
  })
})

describe('敏感键（11 键）与热改键（4 键）', () => {
  it('敏感键集合与服务端 SENSITIVE_PROPERTIES 完全一致', () => {
    expect([...SENSITIVE_PROPERTY_KEYS].sort()).toEqual(
      [
        'rcon.password',
        'rcon.port',
        'enable-rcon',
        'enable-query',
        'enable-status',
        'enable-command-block',
        'online-mode',
        'server-port',
        'server-ip',
        'management-server-secret',
        'management-server-tls-keystore-password',
      ].sort(),
    )
    expect(SENSITIVE_PROPERTY_KEYS.size).toBe(11)
  })

  it('热改键集合与服务端 SERVER_SETTING_METHODS 一致（15 键）', () => {
    // 判据是服务端逐条实测过的 setter 回读（值不生效的 setter 不纳入）
    expect([...HOT_RELOAD_KEYS].sort()).toEqual(
      [
        'white-list',
        'enforce-whitelist',
        'difficulty',
        'gamemode',
        'force-gamemode',
        'max-players',
        'motd',
        'view-distance',
        'simulation-distance',
        'spawn-protection',
        'allow-flight',
        'player-idle-timeout',
        'hide-online-players',
        'op-permission-level',
        'entity-broadcast-range-percentage',
      ].sort(),
    )
    expect(HOT_RELOAD_KEYS.size).toBe(15)
  })

  it('敏感键与热改键均为已知属性，或走未知键定义（仍标记敏感）', () => {
    for (const key of [...SENSITIVE_PROPERTY_KEYS, ...HOT_RELOAD_KEYS]) {
      const def = SERVER_PROPERTY_DEF_MAP.get(key)
      if (def) {
        expect(def.name).toBe(key)
      } else {
        // management-server-* 这类官方键面板未建静态定义，由 buildUnknownPropertyDef
        // 兜底；该路径同样按敏感集标记，防明文旁路
        expect(buildUnknownPropertyDef(key, 'x').isSensitive, `${key} 应标敏感`).toBe(true)
      }
    }
  })

  it('占位符常量与服务端 SENSITIVE_PLACEHOLDER 一致', () => {
    expect(SENSITIVE_PROPERTY_PLACEHOLDER).toBe('********')
  })

  it('三个集合的不变量（面板的生效方式标识依赖它们）', () => {
    // ① 敏感键与热改键不相交：面板按「热改 ⇒ 即时生效 / 否则可写 ⇒ 重启生效」出标，
    //    交集非空时同一行会同时具备两种语义（当前靠短路兜底，但语义本身就是错的）
    expect([...HOT_RELOAD_KEYS].filter((k) => SENSITIVE_PROPERTY_KEYS.has(k))).toEqual([])
    // ② 热改键必须可写：不可写却标「即时生效」＝宣称一件做不到的事
    for (const key of HOT_RELOAD_KEYS) {
      expect(SERVER_PROPERTY_DEF_MAP.get(key)?.isWritable, key).toBe(true)
    }
    // ③ 存在「已知、可写、非热改」的键：面板的「重启生效」标才有落点
    //    （若将来全表变热改，这条会红，提示重新审视该标识是否还有意义）
    const restartOnly = [...SERVER_PROPERTY_DEF_MAP.values()].filter(
      (d) => d.isWritable && !d.isHotReload && !d.isSensitive,
    )
    expect(restartOnly.length).toBeGreaterThan(0)
  })
})

describe('每条属性定义合法性', () => {
  it('dropdown 必有 options 且非空；非 dropdown 无 options', () => {
    for (const def of SERVER_PROPERTY_DEFS) {
      if (def.type === 'dropdown') {
        expect(def.options && def.options.length > 0, `${def.name} 缺 options`).toBeTruthy()
      } else {
        expect(def.options, `${def.name} 不应有 options`).toBeUndefined()
      }
    }
  })

  it('checkbox 的默认值必为 true/false（bool 规范）', () => {
    for (const def of SERVER_PROPERTY_DEFS) {
      if (def.type === 'checkbox') {
        expect(['true', 'false'], `${def.name} 默认值非 bool`).toContain(def.defaultValue)
      }
    }
  })

  it('敏感键定义均标记 isSensitive；非敏感键不标记', () => {
    for (const def of SERVER_PROPERTY_DEFS) {
      expect(def.isSensitive).toBe(SENSITIVE_PROPERTY_KEYS.has(def.name))
    }
  })

  it('热改键定义均标记 isHotReload；非热改键不标记', () => {
    for (const def of SERVER_PROPERTY_DEFS) {
      expect(def.isHotReload).toBe(HOT_RELOAD_KEYS.has(def.name))
    }
  })

  it('敏感键一律不可写（已知定义不标可写；未知键走兜底定义亦不可写）', () => {
    for (const key of SENSITIVE_PROPERTY_KEYS) {
      const def = SERVER_PROPERTY_DEF_MAP.get(key)
      if (def) {
        expect(def.isWritable, `${key} 不应可写`).toBe(false)
      } else {
        expect(buildUnknownPropertyDef(key, 'x').isWritable, `${key} 不应可写`).toBe(false)
      }
    }
  })
})

describe('isBoolValue', () => {
  it('仅接受小写 true/false', () => {
    expect(isBoolValue('true')).toBe(true)
    expect(isBoolValue('false')).toBe(true)
    expect(isBoolValue('TRUE')).toBe(false)
    expect(isBoolValue('1')).toBe(false)
    expect(isBoolValue('')).toBe(false)
    expect(isBoolValue('survival')).toBe(false)
  })
})

describe('buildUnknownPropertyDef（未知属性追加）', () => {
  it('bool 值 → checkbox，非 bool 值 → input', () => {
    const boolDef = buildUnknownPropertyDef('demo-bool', 'true')
    expect(boolDef.type).toBe('checkbox')
    const boolDef2 = buildUnknownPropertyDef('demo-bool2', 'false')
    expect(boolDef2.type).toBe('checkbox')
    const inputDef = buildUnknownPropertyDef('demo-str', 'some value')
    expect(inputDef.type).toBe('input')
    const numDef = buildUnknownPropertyDef('demo-num', '42')
    expect(numDef.type).toBe('input')
  })

  it('label=键名、desc/category 固定、isWritable=false', () => {
    const def = buildUnknownPropertyDef('demo-prop', 'x')
    expect(def.label).toBe('demo-prop')
    expect(def.name).toBe('demo-prop')
    expect(def.desc).toBe('server.properties 设置项')
    expect(def.category).toBe('serverSettings')
    expect(def.isWritable).toBe(false)
    expect(def.isHotReload).toBe(false)
  })

  it('面板接管的键族（management-server-*）行上说明「由面板管理」，不当成普通设置项', () => {
    // 用户真正想手改的位置就是这几行：只写「server.properties 设置项」等于这里一句提醒都没有
    expect(buildUnknownPropertyDef('management-server-enabled', 'false').desc).toBe('由面板管理')
    expect(buildUnknownPropertyDef('management-server-secret', 'x').desc).toBe('由面板管理')
    expect(buildUnknownPropertyDef('management-server-tls-enabled', 'false').desc).toBe(
      '由面板管理',
    )
    // host / allowed-origins / port 面板不写（非本机提示还要求用户自己改回 localhost），
    // 说成「由面板管理」会挡住用户改它们
    expect(buildUnknownPropertyDef('management-server-host', 'localhost').desc).toBe(
      'server.properties 设置项',
    )
    expect(isPanelManagedProperty('management-server-host')).toBe(false)
    expect(isPanelManagedProperty('server-port')).toBe(false)
  })

  it('未知键命中敏感集时标记 isSensitive（防明文旁路）', () => {
    const def = buildUnknownPropertyDef('server-port', '25566')
    expect(def.isSensitive).toBe(true)
    const normal = buildUnknownPropertyDef('custom-key', 'v')
    expect(normal.isSensitive).toBe(false)
  })
})

describe('buildPropertiesPayload（提交载荷：只回传改动键）', () => {
  it('敏感键有改动时只回传占位符（真实值永不出前端）；未改动键不回传', () => {
    const edited: Record<string, string> = { 'server-port': '25599' }
    const current: Record<string, string> = { 'server-port': '25565', motd: 'hello' }
    const payload = buildPropertiesPayload(edited, current)
    expect(payload['server-port']).toBe(SENSITIVE_PROPERTY_PLACEHOLDER)
    // motd 未改动 ⇒ 不回传（整份回传会连带带上 'hello'）
    expect(payload.motd).toBeUndefined()
  })

  it('未改动的敏感键不回传 ⇒ current 里的残留明文无从流出（比掩码更严）', () => {
    const current: Record<string, string> = { 'rcon.password': 'realpass', motd: 'hi' }
    const payload = buildPropertiesPayload({}, current)
    expect(payload).toEqual({})
    expect(JSON.stringify(payload)).not.toContain('realpass')
  })

  it('非敏感值透传，未编辑键不回传', () => {
    const edited: Record<string, string> = { pvp: 'false', motd: '新世界' }
    const current: Record<string, string> = { pvp: 'true', motd: '旧欢迎语', difficulty: 'hard' }
    const payload = buildPropertiesPayload(edited, current)
    expect(payload.pvp).toBe('false')
    expect(payload.motd).toBe('新世界')
    expect(payload.difficulty).toBeUndefined()
  })

  it('面板管不到的键一个都不回传（否则服务端逐键白名单会整批 400）', () => {
    // 真实实例的 server.properties 含面板管不到的键：引擎首启补齐的 26.3 键、
    // 模板写入的 texture-pack、由面板其它入口管理的 management-server-*
    const current: Record<string, string> = {
      motd: '旧欢迎语',
      'management-server-host': 'localhost',
      'texture-pack': '',
      'max-chained-neighbor-updates': '1000000',
    }
    const payload = buildPropertiesPayload({ ...current, motd: '新欢迎语' }, current)
    expect(payload).toEqual({ motd: '新欢迎语' })
  })

  it('快照里没有的键（新增）会回传', () => {
    expect(buildPropertiesPayload({ 'chat-spam-threshold-seconds': '10' }, {})).toEqual({
      'chat-spam-threshold-seconds': '10',
    })
  })

  it('不修改入参（纯函数）', () => {
    const edited: Record<string, string> = { pvp: 'false' }
    const current: Record<string, string> = { 'server-port': '25565' }
    const snapshotEdited = { ...edited }
    const snapshotCurrent = { ...current }
    buildPropertiesPayload(edited, current)
    expect(edited).toEqual(snapshotEdited)
    expect(current).toEqual(snapshotCurrent)
  })
})

describe('vanilla 官方默认值', () => {
  it('force-gamemode=false', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('force-gamemode')?.defaultValue).toBe('false')
  })

  it('enforce-secure-profile=true', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('enforce-secure-profile')?.defaultValue).toBe('true')
  })

  it('op-permission-level=4', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('op-permission-level')?.defaultValue).toBe('4')
  })

  it('sync-chunk-writes=true', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('sync-chunk-writes')?.defaultValue).toBe('true')
  })

  // 26.3 起官方把 white-list 默认值改为 true（发行说明 Server Properties 节原文：
  // 「The `white-list` property is now `true` by default」）⇒ 升级到 26.3 的既有实例
  // 可能突然启用白名单，故该值必须跟随官方而非沿用旧的 false
  it('white-list=true（26.3 官方新默认）', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('white-list')?.defaultValue).toBe('true')
  })

  it('query.port=25565', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('query.port')?.defaultValue).toBe('25565')
  })

  it('enable-rcon=true', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('enable-rcon')?.defaultValue).toBe('true')
  })

  it('enable-command-block=false', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('enable-command-block')?.defaultValue).toBe('false')
  })

  it('level-type=minecraft:normal', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('level-type')?.defaultValue).toBe('minecraft:normal')
  })

  // 26.3 官方默认清单里 difficulty 是 easy（wiki Server.properties 的 Default content 段与
  // Keys 表同列 easy；实例模板 routes/server-jar.js 亦写 easy）——不是旧认知的 normal
  it('difficulty=easy（26.3 官方默认）', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('difficulty')?.defaultValue).toBe('easy')
  })

  // 26.3 官方默认清单里该键是 60（wiki Default content 段与 Keys 表同列 60）——
  // -1 是「不自动暂停」的取值，不是默认值
  it('pause-when-empty-seconds=60（26.3 官方默认）', () => {
    expect(SERVER_PROPERTY_DEF_MAP.get('pause-when-empty-seconds')?.defaultValue).toBe('60')
  })
})

describe('26.3 官方默认清单补入的 5 个键', () => {
  // 默认值一律取自 https://minecraft.wiki/w/Server.properties 的 26.3 Default content 段
  const KEYS_ADDED_FOR_263: ReadonlyArray<[string, string, string]> = [
    ['chat-spam-threshold-seconds', '聊天刷屏阈值', '10'],
    ['command-spam-threshold-seconds', '命令刷屏阈值', '10'],
    ['resource-pack-id', '资源包ID', ''],
    ['status-heartbeat-interval', '状态心跳间隔', '0'],
    ['text-filtering-version', '文本过滤版本', '0'],
  ]

  it.each(KEYS_ADDED_FOR_263)('%s：默认值/分组/控件类型与中文说明', (name, label, defaultValue) => {
    const def = SERVER_PROPERTY_DEF_MAP.get(name)
    expect(def, `${name} 未入属性表`).toBeTruthy()
    expect(def?.label).toBe(label)
    expect(def?.defaultValue).toBe(defaultValue)
    expect(def?.category).toBe('serverSettings')
    expect(def?.type).toBe('input')
    expect(def?.desc.length ?? 0).toBeGreaterThan(0)
  })

  // 服务端 WRITABLE_PROPERTIES 已含这 5 键（整数项亦在 NUMERIC_PROPERTIES）⇒ 面板可写；
  // 「面板可写 ⊆ 服务端白名单」这条跨包不变量由服务端侧
  // 服务端跨包守卫断言守住
  it('服务端白名单已含 ⇒ 可写、非热改、非敏感', () => {
    for (const [name] of KEYS_ADDED_FOR_263) {
      const def = SERVER_PROPERTY_DEF_MAP.get(name)
      expect(def?.isWritable, `${name} 应标可写`).toBe(true)
      expect(def?.isHotReload, `${name} 不应标热改`).toBe(false)
      expect(def?.isSensitive, `${name} 不应标敏感`).toBe(false)
    }
  })
})
