import { isVersionAtLeast } from '@/lib/mc-version'

/**
 * gamerule 双版本**文案资源**（中文名/描述/分类）+ 命令拼装与取值校验
 *
 * 名单不在这里：一台服务器有哪些规则只能由服务器自述（MSMP 的 minecraft:gamerules 或
 * 命令 help gamerule），面板表按版本分叉却没有任何版本等于真机集合（1.21.4 实测 57 条里
 * 有 7 条该版本并不存在，同时漏掉从 1.0 就有的 doFireTick）。故本文件只提供可选装饰：
 * 查得到就显示中文名与描述，查不到显示原始名——**不影响该行是否出现、是否可编辑**。
 *
 * 26.x 不做映射：运行时名（advance_time）与语言文件文案键（doDaylightCycle）是两套无关
 * 标识符，58 条里只有 pvp 一个交集，故 26.x 一律显示原始名（实测，见上表口径）。
 *
 * 数据源：https://zh.minecraft.wiki/游戏规则 + /Java版1.21.11前
 * 双版本兼容：1.21.11 起规则名是 snake_case 资源位置（advance_time/spawn_mobs…，
 * 命名空间缺省为 minecraft）；1.21.11 前是 camelCase（doDaylightCycle/doMobSpawning…）。
 */

export interface GameruleDef {
  name: string
  type: 'bool' | 'int'
  category: string
  desc: string
}

/** 1.21.11+ 新命名体系（含 26.x） */
export const MINECRAFT_GAMERULES: GameruleDef[] = [
  {
    name: 'advance_time',
    type: 'bool',
    category: '世界更新',
    desc: '是否进行昼夜更替和月相变化。',
  },
  {
    name: 'advance_weather',
    type: 'bool',
    category: '世界更新',
    desc: '天气是否变化。',
  },
  {
    name: 'allow_entering_nether_using_portals',
    type: 'bool',
    category: '杂项',
    desc: '实体是否能通过下界传送门进入下界。',
  },
  {
    name: 'block_drops',
    type: 'bool',
    category: '掉落',
    desc: '方块被破坏时是否掉落物品。',
  },
  {
    name: 'block_explosion_drop_decay',
    type: 'bool',
    category: '掉落',
    desc: '由床或重生锚爆炸炸毁的方块是否会有概率不掉落。',
  },
  {
    name: 'command_block_output',
    type: 'bool',
    category: '聊天',
    desc: '命令方块执行命令时是否在聊天框中向管理员显示。',
  },
  {
    name: 'command_blocks_work',
    type: 'bool',
    category: '杂项',
    desc: '命令方块在游戏中是否被启用。',
  },
  {
    name: 'drowning_damage',
    type: 'bool',
    category: '玩家',
    desc: '玩家是否承受窒息伤害。',
  },
  {
    name: 'elytra_movement_check',
    type: 'bool',
    category: '玩家',
    desc: '是否让服务器检查使用鞘翅玩家的移动速度。关闭时有助于减轻因服务器延迟而导致的飞行卡顿，但有可能导致生存模式下玩家飞行过快（作弊）。',
  },
  {
    name: 'ender_pearls_vanish_on_death',
    type: 'bool',
    category: '玩家',
    desc: '被掷出的末影珍珠是否会在掷出它的玩家死亡后消失。',
  },
  {
    name: 'entity_drops',
    type: 'bool',
    category: '掉落',
    desc: '非生物实体是否掉落物品。',
  },
  {
    name: 'fall_damage',
    type: 'bool',
    category: '玩家',
    desc: '玩家是否承受伤害。',
  },
  {
    name: 'fire_damage',
    type: 'bool',
    category: '玩家',
    desc: '玩家是否承受火焰伤害。',
  },
  {
    name: 'fire_spread_radius_around_player',
    type: 'int',
    category: '世界更新',
    desc: '决定了玩家周围会发生火的蔓延、自然熄灭及熔岩生成火的范围。将其设为0将禁用火的更新，设为-1则即使火在附近没有玩家时也可更新。',
  },
  {
    name: 'forgive_dead_players',
    type: 'bool',
    category: '生物',
    desc: '当被激怒的条件敌对生物的目标玩家死亡时，该生物是否恢复未激怒状态。',
  },
  {
    name: 'freeze_damage',
    type: 'bool',
    category: '玩家',
    desc: '玩家是否承受冰冻伤害。',
  },
  {
    name: 'global_sound_events',
    type: 'bool',
    category: '杂项',
    desc: '玩家是否能听到可无视距离播放给全部玩家的特定游戏事件音效。',
  },
  {
    name: 'immediate_respawn',
    type: 'bool',
    category: '玩家',
    desc: '玩家死亡时是否不显示死亡界面直接重生。',
  },
  {
    name: 'keep_inventory',
    type: 'bool',
    category: '玩家',
    desc: '玩家死亡后是否保留物品栏物品、经验（死亡时物品不掉落、经验不清空）。',
  },
  {
    name: 'lava_source_conversion',
    type: 'bool',
    category: '世界更新',
    desc: '流动的熔岩是否可产生熔岩源。',
  },
  {
    name: 'limited_crafting',
    type: 'bool',
    category: '玩家',
    desc: '玩家的合成配方是否需要解锁才能使用。',
  },
  {
    name: 'locator_bar',
    type: 'bool',
    category: '玩家',
    desc: '是否启用定位栏和路径点。',
  },
  {
    name: 'log_admin_commands',
    type: 'bool',
    category: '聊天',
    desc: '是否在服务器日志中记录管理员使用过的命令。',
  },
  {
    name: 'max_block_modifications',
    type: 'int',
    category: '杂项',
    desc: '指定单次命令执行可更改的最大方块数。',
  },
  {
    name: 'max_command_forks',
    type: 'int',
    category: '杂项',
    desc: '决定了命令能使用的命令上下文的总数量。',
  },
  {
    name: 'max_command_sequence_length',
    type: 'int',
    category: '杂项',
    desc: '决定了连锁型命令方块和函数能连锁执行的总数量。',
  },
  {
    name: 'max_entity_cramming',
    type: 'int',
    category: '生物',
    desc: '控制挤压机制。同一位置的可推动实体的上限超过该游戏规则的数量时会引发挤压伤害。设置成0可以停用挤压机制。',
  },
  {
    name: 'max_snow_accumulation_height',
    type: 'int',
    category: '世界更新',
    desc: '下雪时可在一格方块空间内堆积的雪的最高层数。',
  },
  {
    name: 'mob_drops',
    type: 'bool',
    category: '掉落',
    desc: '生物在死亡时是否掉落物品。',
  },
  {
    name: 'mob_explosion_drop_decay',
    type: 'bool',
    category: '掉落',
    desc: '由生物源爆炸炸毁的方块是否会有概率不掉落。',
  },
  {
    name: 'mob_griefing',
    type: 'bool',
    category: '生物',
    desc: '生物是否能够进行破坏性行为，包括苦力怕、硫方怪、僵尸、末影人、恶灵、凋灵、末影龙、兔子、绵羊、村民和雪傀儡是否能放置、修改或破坏方块，生物是否能捡拾物品，以及唤魔者是否能将蓝色的绵羊变为红色。这个规则也会影响生物（如僵尸猪灵和溺尸）寻找海龟蛋的能力。这还将会阻止村民的繁殖。这一游戏规则不会影响TNT和末地水晶。',
  },
  {
    name: 'natural_health_regeneration',
    type: 'bool',
    category: '玩家',
    desc: '玩家是否能在饥饿值足够时自然恢复生命值（不影响外部治疗效果，如金苹果、生命恢复状态效果等）。',
  },
  {
    name: 'player_movement_check',
    type: 'bool',
    category: '玩家',
    desc: '是否让服务器检查并限制玩家的移动速度。',
  },
  {
    name: 'players_nether_portal_creative_delay',
    type: 'int',
    category: '玩家',
    desc: '创造模式下的玩家需要待在下界传送门内多少游戏刻才能进入另一个维度。',
  },
  {
    name: 'players_nether_portal_default_delay',
    type: 'int',
    category: '玩家',
    desc: '非创造模式下的玩家需要待在下界传送门内多少游戏刻才能进入另一个维度。',
  },
  {
    name: 'players_sleeping_percentage',
    type: 'int',
    category: '玩家',
    desc: '设置跳过夜晚所需的入睡玩家所占百分比。设置为0时，1个玩家入睡即可跳过夜晚。设置为大于100的值会使玩家无法通过入睡跳过夜晚。',
  },
  {
    name: 'projectiles_can_break_blocks',
    type: 'bool',
    category: '掉落',
    desc: '弹射物能否破坏紫颂花、滴水石锥以及饰纹陶罐。',
  },
  {
    name: 'pvp',
    type: 'bool',
    category: '玩家',
    desc: '玩家之间能否造成伤害。',
  },
  { name: 'raids', type: 'bool', category: '生物', desc: '是否启用袭击。' },
  {
    name: 'random_tick_speed',
    type: 'int',
    category: '世界更新',
    desc: '每游戏刻每区段中随机的方块刻发生的频率（例如植物生长，树叶腐烂等）。为0时禁用随机刻，较高的数字将增大随机刻频率。',
  },
  {
    name: 'reduced_debug_info',
    type: 'bool',
    category: '杂项',
    desc: '调试屏幕是否简化而非显示详细信息；同时影响实体碰撞箱（通过查看）和区块边界（通过查看）效果的显示。',
  },
  {
    name: 'respawn_radius',
    type: 'int',
    category: '玩家',
    desc: '首次进入服务器的玩家和没有重生点的死亡玩家在重生时与世界出生点坐标的距离。',
  },
  {
    name: 'send_command_feedback',
    type: 'bool',
    category: '聊天',
    desc: '玩家执行命令的返回信息是否在聊天框中显示。同时影响命令方块是否保存命令输出文本。',
  },
  {
    name: 'show_advancement_messages',
    type: 'bool',
    category: '聊天',
    desc: '是否在聊天框中公告玩家进度的达成。',
  },
  {
    name: 'show_death_messages',
    type: 'bool',
    category: '聊天',
    desc: '是否在聊天框中显示玩家的死亡消息。同样影响是否在宠物死亡时通知它的主人。',
  },
  {
    name: 'spawn_mobs',
    type: 'bool',
    category: '生成',
    desc: '生物是否自然生成。不影响刷怪笼及/summon生成生物。',
  },
  {
    name: 'spawn_monsters',
    type: 'bool',
    category: '生成',
    desc: '敌对生物是否能自然生成。',
  },
  {
    name: 'spawn_patrols',
    type: 'bool',
    category: '生成',
    desc: '控制灾厄巡逻队的生成。',
  },
  {
    name: 'spawn_phantoms',
    type: 'bool',
    category: '生成',
    desc: '幻翼是否在夜晚生成。',
  },
  {
    name: 'spawn_wandering_traders',
    type: 'bool',
    category: '生成',
    desc: '控制流浪商人的生成。',
  },
  {
    name: 'spawn_wardens',
    type: 'bool',
    category: '生成',
    desc: '监守者是否生成。',
  },
  {
    name: 'spawner_blocks_work',
    type: 'bool',
    category: '杂项',
    desc: '是否允许刷怪笼与试炼刷怪笼运作。',
  },
  {
    name: 'spectators_generate_chunks',
    type: 'bool',
    category: '玩家',
    desc: '是否允许旁观模式的玩家生成区块。',
  },
  {
    name: 'spread_vines',
    type: 'bool',
    category: '世界更新',
    desc: '决定藤蔓是否会向周围扩散，不影响洞穴藤蔓、缠怨藤和垂泪藤。',
  },
  {
    name: 'tnt_explodes',
    type: 'bool',
    category: '杂项',
    desc: 'TNT是否会爆炸。',
  },
  {
    name: 'tnt_explosion_drop_decay',
    type: 'bool',
    category: '掉落',
    desc: '由TNT爆炸炸毁的方块是否会有概率不掉落。',
  },
  {
    name: 'universal_anger',
    type: 'bool',
    category: '生物',
    desc: '被激怒的条件敌对生物是否攻击附近任何玩家（而非只攻击激怒它们的玩家）。当关闭时会有更好的效果。',
  },
  {
    name: 'water_source_conversion',
    type: 'bool',
    category: '世界更新',
    desc: '流动的水是否可产生水源。',
  },
]

/** 1.21.11 前旧命名体系（含语义相反的 disable 系规则，值按旧语义） */
export const LEGACY_GAMERULES: GameruleDef[] = [
  {
    name: 'allowEnteringNetherUsingPortals',
    type: 'bool',
    category: '',
    desc: '实体是否能通过下界传送门进入下界。',
  },
  {
    name: 'announceAdvancements',
    type: 'bool',
    category: '',
    desc: '是否在聊天框中公告玩家进度的达成。',
  },
  {
    name: 'blockExplosionDropDecay',
    type: 'bool',
    category: '',
    desc: '由床或重生锚爆炸炸毁的方块是否会有概率不掉落。',
  },
  {
    name: 'commandBlockOutput',
    type: 'bool',
    category: '',
    desc: '命令方块执行命令时是否在聊天框中向管理员显示。',
  },
  {
    name: 'commandBlocksEnabled',
    type: 'bool',
    category: '',
    desc: '命令方块在游戏中是否被启用。',
  },
  {
    name: 'commandModificationBlockLimit',
    type: 'int',
    category: '',
    desc: '指定单次命令执行可更改的最大方块数。',
  },
  {
    name: 'disableElytraMovementCheck',
    type: 'bool',
    category: '',
    desc: '是否让服务器停止检查使用鞘翅玩家的移动速度。有助于减轻因服务器延迟而导致的飞行卡顿，但有可能导致生存模式下玩家飞行过快（作弊）。',
  },
  {
    name: 'disablePlayerMovementCheck',
    type: 'bool',
    category: '',
    desc: '是否让服务器停止检查并限制玩家的移动速度。',
  },
  {
    name: 'disableRaids',
    type: 'bool',
    category: '',
    desc: '是否禁用袭击。',
  },
  {
    name: 'doDaylightCycle',
    type: 'bool',
    category: '',
    desc: '是否进行昼夜更替和月相变化。',
  },
  {
    name: 'doEntityDrops',
    type: 'bool',
    category: '',
    desc: '非生物实体是否掉落物品。',
  },
  {
    name: 'doImmediateRespawn',
    type: 'bool',
    category: '',
    desc: '玩家死亡时是否不显示死亡界面直接重生。',
  },
  {
    name: 'doInsomnia',
    type: 'bool',
    category: '',
    desc: '幻翼是否在夜晚生成。',
  },
  {
    name: 'doLimitedCrafting',
    type: 'bool',
    category: '',
    desc: '玩家的合成配方是否需要解锁才能使用。',
  },
  {
    name: 'doMobLoot',
    type: 'bool',
    category: '',
    desc: '生物在死亡时是否掉落物品。',
  },
  {
    name: 'doMobSpawning',
    type: 'bool',
    category: '',
    desc: '生物是否自然生成。不影响刷怪笼及/summon生成生物。',
  },
  {
    name: 'doPatrolSpawning',
    type: 'bool',
    category: '',
    desc: '控制灾厄巡逻队的生成。',
  },
  {
    name: 'doTileDrops',
    type: 'bool',
    category: '',
    desc: '方块被破坏时是否掉落物品。',
  },
  {
    name: 'doTraderSpawning',
    type: 'bool',
    category: '',
    desc: '控制流浪商人的生成。',
  },
  {
    name: 'doVinesSpread',
    type: 'bool',
    category: '',
    desc: '决定藤蔓是否会向周围扩散，不影响洞穴藤蔓、缠怨藤和垂泪藤。',
  },
  {
    name: 'doWardenSpawning',
    type: 'bool',
    category: '',
    desc: '监守者是否生成。',
  },
  {
    name: 'doWeatherCycle',
    type: 'bool',
    category: '',
    desc: '天气是否变化。',
  },
  {
    name: 'drowningDamage',
    type: 'bool',
    category: '',
    desc: '玩家是否承受窒息伤害。',
  },
  {
    name: 'enderPearlsVanishOnDeath',
    type: 'bool',
    category: '',
    desc: '被掷出的末影珍珠是否会在掷出它的玩家死亡后消失。',
  },
  {
    name: 'fallDamage',
    type: 'bool',
    category: '',
    desc: '玩家是否承受摔落伤害。',
  },
  {
    name: 'fireDamage',
    type: 'bool',
    category: '',
    desc: '玩家是否承受火焰伤害。',
  },
  {
    name: 'forgiveDeadPlayers',
    type: 'bool',
    category: '',
    desc: '当被激怒的条件敌对生物的目标玩家死亡时，该生物是否恢复未激怒状态。',
  },
  {
    name: 'freezeDamage',
    type: 'bool',
    category: '',
    desc: '玩家是否承受冰冻伤害。',
  },
  {
    name: 'globalSoundEvents',
    type: 'bool',
    category: '',
    desc: '玩家是否能听到可无视距离播放给全部玩家的特定游戏事件音效。',
  },
  {
    name: 'keepInventory',
    type: 'bool',
    category: '',
    desc: '玩家死亡后是否保留物品栏物品、经验（死亡时物品不掉落、经验不清空）。',
  },
  {
    name: 'lavaSourceConversion',
    type: 'bool',
    category: '',
    desc: '流动的熔岩是否可产生熔岩源。',
  },
  {
    name: 'locatorBar',
    type: 'bool',
    category: '',
    desc: '是否启用定位栏和路径点。',
  },
  {
    name: 'logAdminCommands',
    type: 'bool',
    category: '',
    desc: '是否在服务器日志中记录管理员使用过的命令。',
  },
  {
    name: 'maxCommandChainLength',
    type: 'int',
    category: '',
    desc: '决定了连锁型命令方块和函数能连锁执行的总数量。',
  },
  {
    name: 'maxCommandForkCount',
    type: 'int',
    category: '',
    desc: '决定了命令能使用的命令上下文的总数量。',
  },
  {
    name: 'maxEntityCramming',
    type: 'int',
    category: '',
    desc: '控制挤压机制。同一位置的可推动实体的上限超过该游戏规则的数量时会引发挤压伤害。设置成0可以停用挤压机制。',
  },
  {
    name: 'mobExplosionDropDecay',
    type: 'bool',
    category: '',
    desc: '由生物源爆炸炸毁的方块是否会有概率不掉落。',
  },
  {
    name: 'mobGriefing',
    type: 'bool',
    category: '',
    desc: '生物是否能够进行破坏性行为，包括苦力怕、僵尸、末影人、恶灵、凋灵、末影龙、兔子、绵羊、村民和雪傀儡是否能放置、修改或破坏方块，生物是否能捡拾物品，以及唤魔者是否能将蓝色的绵羊变为红色。这个规则也会影响生物（如僵尸猪灵和溺尸）寻找海龟蛋的能力。这还将会阻止村民的繁殖。这一游戏规则不会影响TNT和末地水晶。',
  },
  {
    name: 'naturalRegeneration',
    type: 'bool',
    category: '',
    desc: '玩家是否能在饥饿值足够时自然恢复生命值（不影响外部治疗效果，如金苹果、生命恢复状态效果等）。',
  },
  {
    name: 'playersNetherPortalCreativeDelay',
    type: 'int',
    category: '',
    desc: '创造模式下的玩家需要待在下界传送门内多少游戏刻才能进入另一个维度。',
  },
  {
    name: 'playersNetherPortalDefaultDelay',
    type: 'int',
    category: '',
    desc: '非创造模式下的玩家需要待在下界传送门内多少游戏刻才能进入另一个维度。',
  },
  {
    name: 'playersSleepingPercentage',
    type: 'int',
    category: '',
    desc: '设置跳过夜晚所需的入睡玩家所占百分比。设置为0时，1个玩家入睡即可跳过夜晚。设置为大于100的值会使玩家无法通过入睡跳过夜晚。',
  },
  {
    name: 'projectilesCanBreakBlocks',
    type: 'bool',
    category: '',
    desc: '弹射物能否破坏紫颂花、滴水石锥以及饰纹陶罐。',
  },
  { name: 'pvp', type: 'bool', category: '', desc: '玩家之间能否造成伤害。' },
  {
    name: 'randomTickSpeed',
    type: 'int',
    category: '',
    desc: '每游戏刻每区段中随机的方块刻发生的频率（例如植物生长，树叶腐烂等）。为0时禁用随机刻，较高的数字将增大随机刻频率。',
  },
  {
    name: 'reducedDebugInfo',
    type: 'bool',
    category: '',
    desc: '调试屏幕是否简化而非显示详细信息；同时影响实体碰撞箱（通过F3+B查看）和区块边界（通过F3+G查看）效果的显示。',
  },
  {
    name: 'sendCommandFeedback',
    type: 'bool',
    category: '',
    desc: '玩家执行命令的返回信息是否在聊天框中显示。同时影响命令方块是否保存命令输出文本。',
  },
  {
    name: 'showDeathMessages',
    type: 'bool',
    category: '',
    desc: '是否在聊天框中显示玩家的死亡消息。同样影响是否在宠物死亡时通知它的主人。',
  },
  {
    name: 'snowAccumulationHeight',
    type: 'int',
    category: '',
    desc: '下雪时可在一格方块空间内堆积的雪的最高层数。',
  },
  {
    name: 'spawnMonsters',
    type: 'bool',
    category: '',
    desc: '敌对生物是否能自然生成。',
  },
  {
    name: 'spawnRadius',
    type: 'int',
    category: '',
    desc: '首次进入服务器的玩家和没有重生点的死亡玩家在重生时与世界出生点坐标的距离。',
  },
  {
    name: 'spawnerBlocksEnabled',
    type: 'bool',
    category: '',
    desc: '是否允许刷怪笼与试炼刷怪笼运作。',
  },
  {
    name: 'spectatorsGenerateChunks',
    type: 'bool',
    category: '',
    desc: '是否允许旁观模式的玩家生成区块。',
  },
  {
    name: 'tntExplodes',
    type: 'bool',
    category: '',
    desc: 'TNT是否会爆炸。',
  },
  {
    name: 'tntExplosionDropDecay',
    type: 'bool',
    category: '',
    desc: '由TNT爆炸炸毁的方块是否会有概率不掉落。',
  },
  {
    name: 'universalAnger',
    type: 'bool',
    category: '',
    desc: '被激怒的条件敌对生物是否攻击附近任何玩家（而非只攻击激怒它们的玩家）。当forgiveDeadPlayers关闭时会有更好的效果。',
  },
  {
    name: 'waterSourceConversion',
    type: 'bool',
    category: '',
    desc: '流动的水是否可产生水源。',
  },
]

/**
 * 按服务器版本选择**文案表**（新旧版本兼容；版本比较走数值化防 1.21.2 > 1.21.11 字符串坑）。
 * 只决定中文名/描述/分类从哪一册取，**不决定显示哪些行**——名单来自服务器自述；
 * 版本未知/空串按最新（与 NBT 三格式判定策略一致）。
 */
export function pickGameruleSet(mcVersion: string): GameruleDef[] {
  return isVersionAtLeast(mcVersion, '1.21.11', true) ? MINECRAFT_GAMERULES : LEGACY_GAMERULES
}

// ── 命令拼装与取值校验 ──

/** 拼装 gamerule 设置命令（无前导 /，与 buildGiveCommand 一致） */
export function buildGameruleSetCommand(ruleName: string, value: string): string {
  return `gamerule ${ruleName} ${value}`
}

// ── 数值型规则的取值区间与值校验 ─────────────────────────
//
// 区间数据**全部实测自服务端**（官方 server.jar，本机一次性实例），不是文档抄录；
// 1.21.11 与 26.3 两次独立取样逐条一致（11 条 × min-1/min/max/max+1 共 44 次下发全同）：
//   gamerule random_tick_speed -1              → Integer must not be less than 0: found -1
//   gamerule random_tick_speed 0               → 放行
//   gamerule max_snow_accumulation_height 9    → Integer must not be more than 8: found 9
//   gamerule max_snow_accumulation_height 2000000000 → 同上（硬上限 8）
// 与 25w44a changelog 冲突处以实测为准：changelog 记 max_command_forks / max_entity_cramming
// 最小 1，两次实测都对 0 放行、对 -1 报「must not be less than 0」⇒ 实际 min 是 0。
// 另两点反直觉的实测结论：players_sleeping_percentage 接受 101（**没有** 0–100 上限）；
// fire_spread_radius_around_player 接受 -1（语义是「无玩家附近也更新火」，故下界为 -1 而非 0）。

/** 命令整数参数的解析上界：实测 2147483647 放行、2147483648 回 `Invalid integer` */
export const GAMERULE_INT_MAX = 2147483647

/**
 * 数值型规则的实测区间，键为面板规则的规范名（1.21.11+ 命名体系）。
 * 上界等于 `GAMERULE_INT_MAX` 的条目＝**规则级无额外上限**（实测这些规则接受 2000000000），
 * 上界只由命令的整数解析决定；`max_snow_accumulation_height` 是唯一有硬上限的规则。
 * 定域是 1.21.11 起（含 26.x）：该区间内的 release（1.21.11 / 26.1 / 26.1.1 / 26.1.2 /
 * 26.2 / 26.3）逐版取样后，11 条键全部存在且边界一致，故本表可直接用于整个区间。
 * 旧命名体系（1.21.11 前）没有本表：1.21.10 实测那 10 条 camelCase 规则对 -1 与 256
 * 都放行（旧体系不设规则级边界），新旧键名不可互相映射，故一律不猜。
 */
export const GAMERULE_INT_RANGES: Readonly<Record<string, { min: number; max: number }>> = {
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
 * 判断一条规则的值能否下发，返回中文原因（null = 放行）。
 *
 * 为什么必须在客户端拦：服务端对越界值的回包（`Integer must not be less than 0: found -1`、
 * `Invalid integer '…'`、`Expected integer`）**不在**服务端命令失败短语表里，会被判成执行成功；
 * 面板随即 toast「已更新」并乐观写上本地值，而服务器其实一个都没改——正是「界面显示已改、
 * 服务器毫无变化」的成因。能拦的都是能证明的边界：区间表里没有的规则**不猜**，一律放行。
 *
 * 类型由端点给出（`type: boolean|integer`），查不到类型时传 null：只按区间表拦，
 * 不拿静态表去猜布尔——猜错会把合法值判成非法。
 */
export function gameruleValueError(
  rule: { name: string; type: 'bool' | 'int' | null },
  rawValue: string,
): string | null {
  const value = String(rawValue).trim()
  if (rule.type === 'bool') {
    return value === 'true' || value === 'false' ? null : `布尔规则只接受 true / false：${value}`
  }
  if (!/^-?\d+$/.test(value)) return `数值规则要求十进制整数：${value}`
  const range = GAMERULE_INT_RANGES[rule.name]
  if (!range) return null
  const n = Number(value)
  if (n < range.min) return `不得小于 ${range.min}：${value}`
  if (n > range.max) return `不得大于 ${range.max}：${value}`
  return null
}

/** 分类中文标签（新集 7 分类；旧集 category 为空串 → 「其他」） */
export const GAMERULE_CATEGORY_LABELS: Record<string, string> = {
  '': '其他',
  世界更新: '世界更新',
  掉落: '掉落',
  聊天: '聊天',
  杂项: '杂项',
  玩家: '玩家',
  生物: '生物',
  生成: '生成',
}
