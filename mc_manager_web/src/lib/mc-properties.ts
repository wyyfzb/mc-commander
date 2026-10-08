/**
 * server.properties 71 属性元数据
 *
 * 服务端契约：mc_commander_server/services/instance-properties.service.js
 * - GET /properties 对 SENSITIVE_PROPERTIES 11 键返回 '********' 占位符
 * - PUT /properties 提交占位符视为未修改（沿用磁盘现值），提交其他值整批 400 拒绝
 * - 服务端 `SERVER_SETTING_METHODS`（15 键）可运行期热改：优先走 MSMP 结构化 setter，
 *   MSMP 不可用时其中 5 键退回原版等价命令，其余键退回「写文件 + 重启生效」
 * - WRITABLE_PROPERTIES 白名单（isWritable 依据）；未知键提交会被 400 拒绝
 *
 * 默认值以 vanilla server.properties 官方默认值为准（版本差异在属性注释中标注）。
 */

/** 属性元数据 */
export interface PropertyDef {
  /** server.properties 键名（唯一） */
  name: string
  /** 显示标签 */
  label: string
  /** 描述文案 */
  desc: string
  /** 分类：游戏玩法 / 世界生成 / 服务器设置 */
  category: 'gameplay' | 'worldGen' | 'serverSettings'
  /** 控件类型：复选框 / 文本输入 / 下拉选择 */
  type: 'checkbox' | 'input' | 'dropdown'
  /** 下拉选项（仅 dropdown 类型使用） */
  options?: string[]
  /**
   * vanilla `server.properties` 的官方默认值。
   *
   * ⚠️ **当前没有任何 UI 消费它**（属性页不渲染默认值、也没有「恢复默认」入口）——
   * 它的实际用途是① 作为「官方默认是什么」的单一事实源供测试钉住（`mc-properties.test.ts`
   * 逐条断言关键键），② 将来做「恢复默认」时的依据。**改官方默认值时必须同步改它**，
   * 否则这里会变成一份看着权威、实际已过期的数据（26.3 的 `white-list` 即此例）。
   */
  defaultValue: string
  /** 敏感键：读写均以占位符掩码，提交永远只回传占位符 */
  isSensitive: boolean
  /** 运行期热改：支持不重启通过斜杠命令立即生效 */
  isHotReload: boolean
  /** 可写：位于服务端 WRITABLE_PROPERTIES 白名单（+热改键并集） */
  isWritable: boolean
}

/** 敏感属性掩码占位符（与服务端 SENSITIVE_PLACEHOLDER 一致） */
export const SENSITIVE_PROPERTY_PLACEHOLDER = '********'

/** 敏感属性键（11 键，与服务端 SENSITIVE_PROPERTIES 保持一致） */
export const SENSITIVE_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'rcon.password',
  'rcon.port',
  'enable-rcon',
  'enable-query',
  'enable-status',
  'enable-command-block',
  'online-mode',
  'server-port',
  'server-ip',
  // MSMP 凭据：实测 26.3 要求恰好 40 位字母数字，留空或手填短串会让服务端**直接崩在启动期**
  // （`Invalid management server secret, must be 40 alphanumeric characters`），
  // 面板代开时自己生成，不要手改
  'management-server-secret',
  'management-server-tls-keystore-password',
])

/** 运行期热改键（15 键，与服务端 `SERVER_SETTING_METHODS` 一致；判据是逐条实测过的 setter 回读） */
export const HOT_RELOAD_KEYS: ReadonlySet<string> = new Set([
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
])

/** 判断属性值是否为布尔（server.properties 中布尔值为 "true"/"false"） */
export function isBoolValue(v: string): boolean {
  return v === 'true' || v === 'false'
}

/**
 * 已知 server.properties 属性的元数据（68 条）
 * 覆盖 vanilla 1.20.5 – 1.21+ 全部已知属性；保留少量废弃字段以兼容旧配置。
 * 分类分布：gameplay 18 / worldGen 17 / serverSettings 33。
 */
export const SERVER_PROPERTY_DEFS: PropertyDef[] = [
  // ── 游戏玩法（gameplay，18） ──
  {
    name: 'difficulty',
    label: '难度',
    desc: '设置游戏难度',
    category: 'gameplay',
    type: 'dropdown',
    options: ['peaceful', 'easy', 'normal', 'hard'],
    defaultValue: 'normal',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'gamemode',
    label: '游戏模式',
    desc: '设置默认游戏模式',
    category: 'gameplay',
    type: 'dropdown',
    options: ['survival', 'creative', 'adventure', 'spectator'],
    defaultValue: 'survival',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'hardcore',
    label: '极限模式',
    desc: '启用极限模式（死亡后封号）',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'pvp',
    label: 'PvP',
    desc: '允许玩家对战',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'allow-flight',
    label: '允许飞行',
    desc: '允许玩家在生存模式飞行（作弊类飞行会被踢）',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'spawn-protection',
    label: '出生点保护',
    desc: '设置出生点保护半径（方块，0=禁用）',
    category: 'gameplay',
    type: 'input',
    defaultValue: '16',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    // vanilla 默认 false
    name: 'force-gamemode',
    label: '强制游戏模式',
    desc: '玩家加入时强制使用默认游戏模式',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'announce-player-achievements',
    label: '成就广播',
    desc: '广播玩家获得成就',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'spawn-monsters',
    label: '生成怪物',
    desc: '是否生成怪物',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'spawn-npcs',
    label: '生成NPC',
    desc: '是否生成村民等 NPC',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'spawn-animals',
    label: '生成动物',
    desc: '是否生成动物',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'max-players',
    label: '最大玩家数',
    desc: '服务器最大玩家数',
    category: 'gameplay',
    type: 'input',
    defaultValue: '20',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'player-idle-timeout',
    label: '挂机超时',
    desc: '玩家挂机超时（分钟，0=禁用）',
    category: 'gameplay',
    type: 'input',
    defaultValue: '0',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    // vanilla 默认 true（1.19+）
    name: 'enforce-secure-profile',
    label: '强制安全档案',
    desc: '强制玩家聊天身份验证（可能影响非正版/Mod聊天）',
    category: 'gameplay',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'pause-when-empty-seconds',
    label: '无人时暂停',
    desc: '服务器无人时暂停 tick 的秒数（-1=禁用）',
    category: 'gameplay',
    type: 'input',
    defaultValue: '-1',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'max-chained-neighbor-updates',
    label: '连锁邻接更新',
    desc: '最大连锁邻接方块更新次数',
    category: 'gameplay',
    type: 'input',
    defaultValue: '1000000',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'function-permission-level',
    label: '函数权限等级',
    desc: '.mcfunction 脚本执行权限等级（1-4）',
    category: 'gameplay',
    type: 'dropdown',
    options: ['1', '2', '3', '4'],
    defaultValue: '2',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    // vanilla 默认 4
    name: 'op-permission-level',
    label: 'OP权限等级',
    desc: 'OP默认权限等级（1-4）',
    category: 'gameplay',
    type: 'dropdown',
    options: ['1', '2', '3', '4'],
    defaultValue: '4',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },

  // ── 世界生成（worldGen，17） ──
  {
    name: 'view-distance',
    label: '视距',
    desc: '设置服务器视距（区块）',
    category: 'worldGen',
    type: 'input',
    defaultValue: '10',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'simulation-distance',
    label: '模拟距离',
    desc: '设置实体模拟距离（区块）',
    category: 'worldGen',
    type: 'input',
    defaultValue: '10',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'max-world-size',
    label: '最大世界大小',
    desc: '设置世界边界半径（方块）',
    category: 'worldGen',
    type: 'input',
    defaultValue: '29999984',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'generate-structures',
    label: '生成结构',
    desc: '生成村庄、神殿等结构',
    category: 'worldGen',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    // vanilla 默认 false；同时为敏感键（不可写）
    name: 'enable-command-block',
    label: '命令方块',
    desc: '启用命令方块',
    category: 'worldGen',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'allow-nether',
    label: '允许下界',
    desc: '允许生成下界',
    category: 'worldGen',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'allow-end',
    label: '允许末地',
    desc: '允许生成末地',
    category: 'worldGen',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'level-name',
    label: '世界名称',
    desc: '世界文件夹名称',
    category: 'worldGen',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'level-seed',
    label: '世界种子',
    desc: '世界生成种子（留空随机）',
    category: 'worldGen',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    // vanilla 默认 minecraft:normal
    name: 'level-type',
    label: '世界类型',
    desc: '世界生成类型',
    category: 'worldGen',
    type: 'dropdown',
    options: [
      'minecraft:normal',
      'minecraft:flat',
      'minecraft:large_biomes',
      'minecraft:amplified',
      'minecraft:single_biome_surface',
      'default',
      'flat',
      'largeBiomes',
      'amplified',
    ],
    defaultValue: 'minecraft:normal',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'generator-settings',
    label: '生成器设置',
    desc: '自定义世界生成参数（JSON）',
    category: 'worldGen',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'region-file-compression',
    label: '区块文件压缩',
    desc: '区域文件压缩算法（1.20.5+）',
    category: 'worldGen',
    type: 'dropdown',
    options: ['deflate', 'lz4', 'none'],
    defaultValue: 'deflate',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'entity-broadcast-range-percentage',
    label: '实体广播范围',
    desc: '实体发送距离百分比（0-1000）',
    category: 'worldGen',
    type: 'input',
    defaultValue: '100',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'max-tick-time',
    label: '最大Tick时间',
    desc: '单 tick 最大耗时（毫秒，超时视为崩服）',
    category: 'worldGen',
    type: 'input',
    defaultValue: '60000',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    // vanilla 默认 true
    name: 'sync-chunk-writes',
    label: '同步区块写入',
    desc: '启用同步区块写入（关闭可提升性能）',
    category: 'worldGen',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'initial-enabled-packs',
    label: '初始启用数据包',
    desc: '服务器启动时启用的数据包（逗号分隔）',
    category: 'worldGen',
    type: 'input',
    defaultValue: 'vanilla',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'initial-disabled-packs',
    label: '初始禁用数据包',
    desc: '服务器启动时禁用的数据包（逗号分隔）',
    category: 'worldGen',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },

  // ── 服务器设置（serverSettings，33） ──
  {
    // 26.3 起官方默认值由 false 改为 **true**（26.3 发行说明 Server Properties 节
    // 原文：「The `white-list` property is now `true` by default」）⇒ 升级到 26.3 的
    // 既有实例可能**突然启用白名单**。此处只订正默认值本身；「升级后要不要提示用户」
    // 属交互决策，未做。热改键（whitelist on/off）
    name: 'white-list',
    label: '白名单',
    desc: '启用白名单',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'enforce-whitelist',
    label: '强制白名单',
    desc: '白名单开启时踢出非白名单玩家',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'online-mode',
    label: '在线验证',
    desc: '验证玩家账号（正版）',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'enable-query',
    label: 'GameSpy4查询',
    desc: '启用查询协议',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    // vanilla 默认 true；敏感键（不可写）
    name: 'enable-rcon',
    label: 'RCON远程控制',
    desc: '启用RCON远程命令',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'rcon.port',
    label: 'RCON端口',
    desc: 'RCON服务端口',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '25575',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'rcon.password',
    label: 'RCON密码',
    desc: 'RCON认证密码',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    // vanilla 默认与 server-port 同值 25565
    name: 'query.port',
    label: '查询端口',
    desc: '查询服务端口',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '25565',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'server-port',
    label: '服务器端口',
    desc: 'MC客户端连接端口',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '25565',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'server-ip',
    label: '服务器IP',
    desc: '绑定的IP地址（留空则所有接口）',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'max-build-height',
    label: '最大建筑高度',
    desc: '最大建筑高度（方块）',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '256',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'motd',
    label: 'MOTD',
    desc: '服务器欢迎消息（多人游戏列表显示）',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'resource-pack',
    label: '资源包URL',
    desc: '客户端自动下载的资源包',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'resource-pack-sha1',
    label: '资源包SHA1',
    desc: '资源包校验值',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'resource-pack-prompt',
    label: '资源包提示',
    desc: '资源包下载时的自定义提示消息',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'text-filtering-config',
    label: '文本过滤配置',
    desc: '聊天文本过滤配置的 URL',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'require-resource-pack',
    label: '强制资源包',
    desc: '拒绝加载资源包时踢出玩家',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'network-compression-threshold',
    label: '网络压缩阈值',
    desc: '网络包压缩阈值（字节，-1=禁用）',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '256',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'use-native-transport',
    label: 'Native传输',
    desc: 'Linux使用epoll优化网络',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'prevent-proxy-connections',
    label: '禁止代理连接',
    desc: '禁止通过代理连接（需 Mojang API 验证）',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'rate-limit',
    // 这里的「数据包」是**网络包**（packet），与 datapack 是两回事——本表
    // initial-enabled/disabled-datapacks 的「数据包」才是 datapack。中文同名，
    // 故 label 必须点明「网络」，否则会被读成「datapack 的速率限制」。
    label: '网络包速率限制',
    desc: '单个客户端每秒最大网络包数（0=禁用）',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '0',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'enable-status',
    label: '服务器状态响应',
    desc: '响应服务器列表 ping（关闭可隐藏服务器）',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: true,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'hide-online-players',
    label: '隐藏在线玩家',
    desc: '服务器列表只显示玩家数，不显示昵称',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: true,
    isWritable: true,
  },
  {
    name: 'enable-jmx-monitoring',
    label: 'JMX监控',
    desc: '启用 Java Mission Control JMX 监控',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'broadcast-console-to-ops',
    label: '控制台广播给OP',
    desc: '将控制台输出发送给在线 OP',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'broadcast-rcon-to-ops',
    label: 'RCON广播给OP',
    desc: '将 RCON 命令输出发送给在线 OP',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'log-ips',
    label: '记录玩家IP',
    desc: '在日志中记录玩家 IP 地址（1.20.5+）',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'true',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'accepts-transfers',
    label: '接受跨服转移',
    desc: '允许接收来自其他服务器的玩家转移（1.20.5+）',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'debug',
    label: '调试模式',
    desc: '启用调试日志（仅排错时开启）',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'bug-report-link',
    label: 'Bug报告链接',
    desc: '客户端上报 bug 的链接（留空禁用）',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'enable-code-of-conduct',
    label: '行为准则',
    desc: '启用微软行为准则提示',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
  {
    name: 'snooper-enabled',
    label: 'Snooper统计(废弃)',
    desc: '发送匿名统计信息（1.15+ 已废弃，保留兼容旧配置）',
    category: 'serverSettings',
    type: 'checkbox',
    defaultValue: 'false',
    isSensitive: false,
    isHotReload: false,
    isWritable: true,
  },
  {
    name: 'server-name',
    label: '服务器名称',
    desc: '服务器显示名称（1.21.6+）',
    category: 'serverSettings',
    type: 'input',
    defaultValue: '',
    isSensitive: false,
    isHotReload: false,
    isWritable: false,
  },
]

/** 已知属性索引（name → def，用于 O(1) 查找） */
export const SERVER_PROPERTY_DEF_MAP: ReadonlyMap<string, PropertyDef> = new Map(
  SERVER_PROPERTY_DEFS.map((def) => [def.name, def]),
)

/**
 * 未知属性定义（server.properties 中存在但不在 SERVER_PROPERTY_DEFS 中的设置项）。
 * - label = 键名、desc 固定文案、category serverSettings
 * - 值恰为 'true'/'false' → checkbox，否则 input
 * - 命中敏感集（如服务端新增敏感键而元数据未覆盖）同样标记，防明文旁路
 * - isWritable false：未知键不在服务端白名单，提交会被 400 拒绝
 */
export function buildUnknownPropertyDef(key: string, value: string): PropertyDef {
  const isBool = isBoolValue(value)
  return {
    name: key,
    label: key,
    // 这一族由面板的推送开关统一写（enabled/secret/TLS 三项必须同时写对，只改 enabled 会让
    // 服务器起不来），行上说明「谁管」，那句因果由推送卡的固定提示承担——行内说明是 2xs，
    // 按字号口径只放短语、放不下整句
    desc: isPanelManagedProperty(key) ? '由面板管理' : 'server.properties 设置项',
    category: 'serverSettings',
    type: isBool ? 'checkbox' : 'input',
    defaultValue: '',
    isSensitive: SENSITIVE_PROPERTY_KEYS.has(key),
    isHotReload: false,
    isWritable: false,
  }
}

/**
 * 面板**代写**的键（属性面板把它们渲染成只读行，行上要说明「这不是给你手改的」）。
 *
 * 只列服务端 `setPushChannel` 真正写的那三个：`management-server-host` /
 * `-allowed-origins` / `-port` 面板不写（非本机绑定的提示还要求用户自己改回 localhost），
 * 把它们也说成「由面板管理」会挡住用户改那几项——那才是新的不准确。
 */
const PANEL_MANAGED_PROPERTY_KEYS = new Set([
  'management-server-enabled',
  'management-server-secret',
  'management-server-tls-enabled',
])

export function isPanelManagedProperty(key: string): boolean {
  return PANEL_MANAGED_PROPERTY_KEYS.has(key)
}

/**
 * 构建 server.properties 提交载荷。
 * - 敏感键恒回传 '********' 占位符（服务端视为未修改、沿用磁盘现值；
 *   提交真实值会整批 400 拒绝），current 中残留的敏感明文也一并掩码覆盖
 * - 布尔值（'true'/'false'）规范化透传；其余值 String() 转换
 * - edited 未覆盖的键沿用 current 现值
 */
export function buildPropertiesPayload(
  edited: Record<string, string>,
  current: Record<string, string>,
): Record<string, string> {
  const payload: Record<string, string> = { ...current }
  for (const [key, raw] of Object.entries(edited)) {
    if (SENSITIVE_PROPERTY_KEYS.has(key)) {
      payload[key] = SENSITIVE_PROPERTY_PLACEHOLDER
      continue
    }
    payload[key] = String(raw)
  }
  // current 中残留的敏感明文（旧版服务端明文返回兜底）一并掩码
  for (const key of Object.keys(payload)) {
    if (SENSITIVE_PROPERTY_KEYS.has(key)) {
      payload[key] = SENSITIVE_PROPERTY_PLACEHOLDER
    }
  }
  return payload
}
