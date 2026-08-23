/**
 * gamerule 双版本数据 + 查询解析
 * 数据源：https://zh.minecraft.wiki/游戏规则 + /Java版1.21.11前
 * 双版本兼容：1.21.11+ 用新名（advanceTime/spawnMobs…），1.21.11 前用旧名（doDaylightCycle/doMobSpawning…）
 * 布尔默认值在数据里存布尔字面量（int 存字符串），展示/命令拼装时统一 String() 转字符串
 */

export interface GameruleDef {
  name: string
  type: 'bool' | 'int'
  defaultValue: string | boolean
  category: string
  desc: string
}

/** 1.21.11+ 新命名体系（含 26.x） */
export const MINECRAFT_GAMERULES: GameruleDef[] = [
  { name: 'advanceTime', type: 'bool', defaultValue: true, category: '世界更新', desc: '是否进行昼夜更替和月相变化。' },
  { name: 'advanceWeather', type: 'bool', defaultValue: true, category: '世界更新', desc: '天气是否变化。' },
  { name: 'allowEnteringNetherUsingPortals', type: 'bool', defaultValue: true, category: '杂项', desc: '实体是否能通过下界传送门进入下界。' },
  { name: 'blockDrops', type: 'bool', defaultValue: true, category: '掉落', desc: '方块被破坏时是否掉落物品。' },
  { name: 'blockExplosionDropDecay', type: 'bool', defaultValue: true, category: '掉落', desc: '由床或重生锚爆炸炸毁的方块是否会有概率不掉落。' },
  { name: 'commandBlockOutput', type: 'bool', defaultValue: true, category: '聊天', desc: '命令方块执行命令时是否在聊天框中向管理员显示。' },
  { name: 'commandBlocksWork', type: 'bool', defaultValue: true, category: '杂项', desc: '命令方块在游戏中是否被启用。' },
  { name: 'drowningDamage', type: 'bool', defaultValue: true, category: '玩家', desc: '玩家是否承受窒息伤害。' },
  { name: 'elytraMovementCheck', type: 'bool', defaultValue: true, category: '玩家', desc: '是否让服务器检查使用鞘翅玩家的移动速度。关闭时有助于减轻因服务器延迟而导致的飞行卡顿，但有可能导致生存模式下玩家飞行过快（作弊）。' },
  { name: 'enderPearlsVanishOnDeath', type: 'bool', defaultValue: true, category: '玩家', desc: '被掷出的末影珍珠是否会在掷出它的玩家死亡后消失。' },
  { name: 'entityDrops', type: 'bool', defaultValue: true, category: '掉落', desc: '非生物实体是否掉落物品。' },
  { name: 'fallDamage', type: 'bool', defaultValue: true, category: '玩家', desc: '玩家是否承受伤害。' },
  { name: 'fireDamage', type: 'bool', defaultValue: true, category: '玩家', desc: '玩家是否承受火焰伤害。' },
  { name: 'fireSpreadRadiusAroundPlayer', type: 'int', defaultValue: '128', category: '世界更新', desc: '决定了玩家周围会发生火的蔓延、自然熄灭及熔岩生成火的范围。将其设为0将禁用火的更新，设为-1则即使火在附近没有玩家时也可更新。' },
  { name: 'forgiveDeadPlayers', type: 'bool', defaultValue: true, category: '生物', desc: '当被激怒的条件敌对生物的目标玩家死亡时，该生物是否恢复未激怒状态。' },
  { name: 'freezeDamage', type: 'bool', defaultValue: true, category: '玩家', desc: '玩家是否承受冰冻伤害。' },
  { name: 'globalSoundEvents', type: 'bool', defaultValue: true, category: '杂项', desc: '玩家是否能听到可无视距离播放给全部玩家的特定游戏事件音效。' },
  { name: 'immediateRespawn', type: 'bool', defaultValue: false, category: '玩家', desc: '玩家死亡时是否不显示死亡界面直接重生。' },
  { name: 'keepInventory', type: 'bool', defaultValue: false, category: '玩家', desc: '玩家死亡后是否保留物品栏物品、经验（死亡时物品不掉落、经验不清空）。' },
  { name: 'lavaSourceConversion', type: 'bool', defaultValue: false, category: '世界更新', desc: '流动的熔岩是否可产生熔岩源。' },
  { name: 'limitedCrafting', type: 'bool', defaultValue: false, category: '玩家', desc: '玩家的合成配方是否需要解锁才能使用。' },
  { name: 'locatorBar', type: 'bool', defaultValue: true, category: '玩家', desc: '是否启用定位栏和路径点。' },
  { name: 'logAdminCommands', type: 'bool', defaultValue: true, category: '聊天', desc: '是否在服务器日志中记录管理员使用过的命令。' },
  { name: 'maxBlockModifications', type: 'int', defaultValue: '32768', category: '杂项', desc: '指定单次命令执行可更改的最大方块数。' },
  { name: 'maxCommandForks', type: 'int', defaultValue: '65536', category: '杂项', desc: '决定了命令能使用的命令上下文的总数量。' },
  { name: 'maxCommandSequenceLength', type: 'int', defaultValue: '65536', category: '杂项', desc: '决定了连锁型命令方块和函数能连锁执行的总数量。' },
  { name: 'maxEntityCramming', type: 'int', defaultValue: '24', category: '生物', desc: '控制挤压机制。同一位置的可推动实体的上限超过该游戏规则的数量时会引发挤压伤害。设置成0可以停用挤压机制。' },
  { name: 'maxSnowAccumulationHeight', type: 'int', defaultValue: '1', category: '世界更新', desc: '下雪时可在一格方块空间内堆积的雪的最高层数。' },
  { name: 'mobDrops', type: 'bool', defaultValue: true, category: '掉落', desc: '生物在死亡时是否掉落物品。' },
  { name: 'mobExplosionDropDecay', type: 'bool', defaultValue: true, category: '掉落', desc: '由生物源爆炸炸毁的方块是否会有概率不掉落。' },
  { name: 'mobGriefing', type: 'bool', defaultValue: true, category: '生物', desc: '生物是否能够进行破坏性行为，包括苦力怕、硫方怪、僵尸、末影人、恶灵、凋灵、末影龙、兔子、绵羊、村民和雪傀儡是否能放置、修改或破坏方块，生物是否能捡拾物品，以及唤魔者是否能将蓝色的绵羊变为红色。这个规则也会影响生物（如僵尸猪灵和溺尸）寻找海龟蛋的能力。这还将会阻止村民的繁殖。这一游戏规则不会影响TNT和末地水晶。' },
  { name: 'naturalHealthRegeneration', type: 'bool', defaultValue: true, category: '玩家', desc: '玩家是否能在饥饿值足够时自然恢复生命值（不影响外部治疗效果，如金苹果、生命恢复状态效果等）。' },
  { name: 'playerMovementCheck', type: 'bool', defaultValue: true, category: '玩家', desc: '是否让服务器检查并限制玩家的移动速度。' },
  { name: 'playersNetherPortalCreativeDelay', type: 'int', defaultValue: '0', category: '玩家', desc: '创造模式下的玩家需要待在下界传送门内多少游戏刻才能进入另一个维度。' },
  { name: 'playersNetherPortalDefaultDelay', type: 'int', defaultValue: '80', category: '玩家', desc: '非创造模式下的玩家需要待在下界传送门内多少游戏刻才能进入另一个维度。' },
  { name: 'playersSleepingPercentage', type: 'int', defaultValue: '100', category: '玩家', desc: '设置跳过夜晚所需的入睡玩家所占百分比。设置为0时，1个玩家入睡即可跳过夜晚。设置为大于100的值会使玩家无法通过入睡跳过夜晚。' },
  { name: 'projectilesCanBreakBlocks', type: 'bool', defaultValue: true, category: '掉落', desc: '弹射物能否破坏紫颂花、滴水石锥以及饰纹陶罐。' },
  { name: 'pvp', type: 'bool', defaultValue: true, category: '玩家', desc: '玩家之间能否造成伤害。' },
  { name: 'raids', type: 'bool', defaultValue: true, category: '生物', desc: '是否启用袭击。' },
  { name: 'randomTickSpeed', type: 'int', defaultValue: '3', category: '世界更新', desc: '每游戏刻每区段中随机的方块刻发生的频率（例如植物生长，树叶腐烂等）。为0时禁用随机刻，较高的数字将增大随机刻频率。' },
  { name: 'reducedDebugInfo', type: 'bool', defaultValue: false, category: '杂项', desc: '调试屏幕是否简化而非显示详细信息；同时影响实体碰撞箱（通过查看）和区块边界（通过查看）效果的显示。' },
  { name: 'respawnRadius', type: 'int', defaultValue: '10', category: '玩家', desc: '首次进入服务器的玩家和没有重生点的死亡玩家在重生时与世界出生点坐标的距离。' },
  { name: 'sendCommandFeedback', type: 'bool', defaultValue: true, category: '聊天', desc: '玩家执行命令的返回信息是否在聊天框中显示。同时影响命令方块是否保存命令输出文本。' },
  { name: 'showAdvancementMessages', type: 'bool', defaultValue: true, category: '聊天', desc: '是否在聊天框中公告玩家进度的达成。' },
  { name: 'showDeathMessages', type: 'bool', defaultValue: true, category: '聊天', desc: '是否在聊天框中显示玩家的死亡消息。同样影响是否在宠物死亡时通知它的主人。' },
  { name: 'spawnMobs', type: 'bool', defaultValue: true, category: '生成', desc: '生物是否自然生成。不影响刷怪笼及/summon生成生物。' },
  { name: 'spawnMonsters', type: 'bool', defaultValue: true, category: '生成', desc: '敌对生物是否能自然生成。' },
  { name: 'spawnPatrols', type: 'bool', defaultValue: true, category: '生成', desc: '控制灾厄巡逻队的生成。' },
  { name: 'spawnPhantoms', type: 'bool', defaultValue: true, category: '生成', desc: '幻翼是否在夜晚生成。' },
  { name: 'spawnWanderingTraders', type: 'bool', defaultValue: true, category: '生成', desc: '控制流浪商人的生成。' },
  { name: 'spawnWardens', type: 'bool', defaultValue: true, category: '生成', desc: '监守者是否生成。' },
  { name: 'spawnerBlocksWork', type: 'bool', defaultValue: true, category: '杂项', desc: '是否允许刷怪笼与试炼刷怪笼运作。' },
  { name: 'spectatorsGenerateChunks', type: 'bool', defaultValue: true, category: '玩家', desc: '是否允许旁观模式的玩家生成区块。' },
  { name: 'spreadVines', type: 'bool', defaultValue: true, category: '世界更新', desc: '决定藤蔓是否会向周围扩散，不影响洞穴藤蔓、缠怨藤和垂泪藤。' },
  { name: 'tntExplodes', type: 'bool', defaultValue: true, category: '杂项', desc: 'TNT是否会爆炸。' },
  { name: 'tntExplosionDropDecay', type: 'bool', defaultValue: false, category: '掉落', desc: '由TNT爆炸炸毁的方块是否会有概率不掉落。' },
  { name: 'universalAnger', type: 'bool', defaultValue: false, category: '生物', desc: '被激怒的条件敌对生物是否攻击附近任何玩家（而非只攻击激怒它们的玩家）。当关闭时会有更好的效果。' },
  { name: 'waterSourceConversion', type: 'bool', defaultValue: true, category: '世界更新', desc: '流动的水是否可产生水源。' },
]

/** 1.21.11 前旧命名体系（含语义相反的 disable 系规则，值按旧语义） */
export const LEGACY_GAMERULES: GameruleDef[] = [
  { name: 'allowEnteringNetherUsingPortals', type: 'bool', defaultValue: true, category: '', desc: '实体是否能通过下界传送门进入[[下界]]。' },
  { name: 'announceAdvancements', type: 'bool', defaultValue: true, category: '', desc: '是否在聊天框中公告玩家[[进度]]的达成。' },
  { name: 'blockExplosionDropDecay', type: 'bool', defaultValue: true, category: '', desc: '由[[床]]或[[重生锚]]爆炸炸毁的方块是否会有概率不掉落。' },
  { name: 'commandBlockOutput', type: 'bool', defaultValue: true, category: '', desc: '[[命令方块]]执行命令时是否在聊天框中向管理员显示。' },
  { name: 'commandBlocksEnabled', type: 'bool', defaultValue: true, category: '', desc: '[[命令方块]]在游戏中是否被启用。' },
  { name: 'commandModificationBlockLimit', type: 'int', defaultValue: '32768', category: '', desc: '指定单次命令执行可更改的最大方块数。' },
  { name: 'disableElytraMovementCheck', type: 'bool', defaultValue: false, category: '', desc: '是否让服务器停止检查使用[[鞘翅]]玩家的移动速度。有助于减轻因服务器延迟而导致的飞行卡顿，但有可能导致生存模式下玩家飞行过快（作弊）。' },
  { name: 'disablePlayerMovementCheck', type: 'bool', defaultValue: false, category: '', desc: '是否让服务器停止检查并限制玩家的移动速度。' },
  { name: 'disableRaids', type: 'bool', defaultValue: false, category: '', desc: '是否禁用[[袭击]]。' },
  { name: 'doDaylightCycle', type: 'bool', defaultValue: true, category: '', desc: '是否进行[[昼夜更替]]和[[月亮#月相|月相]]变化。' },
  { name: 'doEntityDrops', type: 'bool', defaultValue: true, category: '', desc: '非生物实体是否掉落物品。' },
  { name: 'doImmediateRespawn', type: 'bool', defaultValue: false, category: '', desc: '玩家死亡时是否不显示死亡界面直接重生。' },
  { name: 'doInsomnia', type: 'bool', defaultValue: true, category: '', desc: '[[幻翼]]是否在夜晚生成。' },
  { name: 'doLimitedCrafting', type: 'bool', defaultValue: false, category: '', desc: '玩家的合成配方是否需要解锁才能使用。' },
  { name: 'doMobLoot', type: 'bool', defaultValue: true, category: '', desc: '生物在死亡时是否掉落物品。' },
  { name: 'doMobSpawning', type: 'bool', defaultValue: true, category: '', desc: '[[生物]]是否[[生成#周期生成|自然生成]]。不影响[[刷怪笼]]及{{cmd|summon}}生成生物。' },
  { name: 'doPatrolSpawning', type: 'bool', defaultValue: true, category: '', desc: '控制[[灾厄巡逻队]]的生成。' },
  { name: 'doTileDrops', type: 'bool', defaultValue: true, category: '', desc: '方块被破坏时是否掉落物品。' },
  { name: 'doTraderSpawning', type: 'bool', defaultValue: true, category: '', desc: '控制[[流浪商人]]的生成。' },
  { name: 'doVinesSpread', type: 'bool', defaultValue: true, category: '', desc: '决定[[藤蔓]]是否会向周围扩散，不影响[[洞穴藤蔓]]、[[缠怨藤]]和[[垂泪藤]]。' },
  { name: 'doWardenSpawning', type: 'bool', defaultValue: true, category: '', desc: '[[监守者]]是否生成。' },
  { name: 'doWeatherCycle', type: 'bool', defaultValue: true, category: '', desc: '天气是否变化。' },
  { name: 'drowningDamage', type: 'bool', defaultValue: true, category: '', desc: '玩家是否承受窒息伤害。' },
  { name: 'enderPearlsVanishOnDeath', type: 'bool', defaultValue: true, category: '', desc: '被掷出的[[末影珍珠]]是否会在掷出它的玩家死亡后消失。' },
  { name: 'fallDamage', type: 'bool', defaultValue: true, category: '', desc: '玩家是否承受{{tr|摔落|摔落|跌落}}伤害。' },
  { name: 'fireDamage', type: 'bool', defaultValue: true, category: '', desc: '玩家是否承受火焰伤害。' },
  { name: 'forgiveDeadPlayers', type: 'bool', defaultValue: true, category: '', desc: '当被激怒的条件敌对生物的目标玩家死亡时，该生物是否恢复未激怒状态。' },
  { name: 'freezeDamage', type: 'bool', defaultValue: true, category: '', desc: '玩家是否承受冰冻伤害。' },
  { name: 'globalSoundEvents', type: 'bool', defaultValue: true, category: '', desc: '玩家是否能听到可无视距离播放给全部玩家的特定游戏事件音效。' },
  { name: 'keepInventory', type: 'bool', defaultValue: false, category: '', desc: '玩家死亡后是否保留物品栏物品、经验（死亡时物品不掉落、经验不清空）。' },
  { name: 'lavaSourceConversion', type: 'bool', defaultValue: false, category: '', desc: '流动的熔岩是否可产生熔岩源。' },
  { name: 'locatorBar', type: 'bool', defaultValue: true, category: '', desc: '是否启用[[定位栏]]和[[路径点]]。' },
  { name: 'logAdminCommands', type: 'bool', defaultValue: true, category: '', desc: '是否在服务器日志中记录管理员使用过的命令。' },
  { name: 'maxCommandChainLength', type: 'int', defaultValue: '65536', category: '', desc: '决定了连锁型命令方块和[[Java版函数|函数]]能连锁执行的总数量。' },
  { name: 'maxCommandForkCount', type: 'int', defaultValue: '65536', category: '', desc: '决定了命令能使用的命令上下文的总数量。' },
  { name: 'maxEntityCramming', type: 'int', defaultValue: '24', category: '', desc: '控制[[挤压]]机制。同一位置的可推动实体的上限超过该游戏规则的数量时会引发挤压伤害。设置成0可以停用挤压机制。' },
  { name: 'mobExplosionDropDecay', type: 'bool', defaultValue: true, category: '', desc: '由生物源爆炸炸毁的方块是否会有概率不掉落。' },
  { name: 'mobGriefing', type: 'bool', defaultValue: true, category: '', desc: '生物是否能够进行破坏性行为，包括[[苦力怕]]、[[僵尸]]、[[末影人]]、[[恶灵]]、[[凋灵]]、[[末影龙]]、[[兔子]]、[[绵羊]]、[[村民]]和[[雪傀儡]]是否能放置、修改或破坏方块，生物是否能捡拾物品，以及[[唤魔者]]是否能将蓝色的绵羊变为红色。这个规则也会影响生物（如[[僵尸猪灵]]和[[溺尸]]）寻找[[海龟蛋]]的能力。这还将会阻止[[村民]]的[[繁殖]]。这一游戏规则不会影响[[TNT]]和[[末地水晶]]。' },
  { name: 'naturalRegeneration', type: 'bool', defaultValue: true, category: '', desc: '玩家是否能在饥饿值足够时自然恢复生命值（不影响外部治疗效果，如[[金苹果]]、[[生命恢复]]状态效果等）。' },
  { name: 'playersNetherPortalCreativeDelay', type: 'int', defaultValue: '0', category: '', desc: '[[创造模式]]下的玩家需要待在[[下界传送门（方块）|下界传送门]]内多少游戏刻才能进入另一个维度。' },
  { name: 'playersNetherPortalDefaultDelay', type: 'int', defaultValue: '80', category: '', desc: '非创造模式下的玩家需要待在下界传送门内多少游戏刻才能进入另一个维度。' },
  { name: 'playersSleepingPercentage', type: 'int', defaultValue: '100', category: '', desc: '设置跳过夜晚所需的入睡玩家所占百分比。设置为0时，1个玩家入睡即可跳过夜晚。设置为大于100的值会使玩家无法通过入睡跳过夜晚。' },
  { name: 'projectilesCanBreakBlocks', type: 'bool', defaultValue: true, category: '', desc: '[[弹射物]]能否破坏[[紫颂花]]、[[滴水石锥]]以及[[饰纹陶罐]]。' },
  { name: 'pvp', type: 'bool', defaultValue: true, category: '', desc: '玩家之间能否造成伤害。' },
  { name: 'randomTickSpeed', type: 'int', defaultValue: '3', category: '', desc: '每游戏刻每区段中随机的[[方块刻]]发生的频率（例如植物生长，树叶腐烂等）。为0时禁用随机刻，较高的数字将增大随机刻频率。' },
  { name: 'reducedDebugInfo', type: 'bool', defaultValue: false, category: '', desc: '[[调试屏幕]]是否简化而非显示详细信息；同时影响实体碰撞箱（通过{{key|F3+B}}查看）和区块边界（通过{{key|F3+G}}查看）效果的显示。' },
  { name: 'sendCommandFeedback', type: 'bool', defaultValue: true, category: '', desc: '玩家执行命令的返回信息是否在聊天框中显示。同时影响命令方块是否保存命令输出文本。' },
  { name: 'showDeathMessages', type: 'bool', defaultValue: true, category: '', desc: '是否在聊天框中显示玩家的死亡消息。同样影响是否在宠物死亡时通知它的主人。' },
  { name: 'snowAccumulationHeight', type: 'int', defaultValue: '1', category: '', desc: '下雪时可在一格方块空间内堆积的雪的最高层数。' },
  { name: 'spawnMonsters', type: 'bool', defaultValue: true, category: '', desc: '[[生物#敌对生物|敌对生物]]是否能自然生成。' },
  { name: 'spawnRadius', type: 'int', defaultValue: '10', category: '', desc: '首次进入服务器的玩家和没有重生点的死亡玩家在重生时与[[世界出生点]]坐标的距离。' },
  { name: 'spawnerBlocksEnabled', type: 'bool', defaultValue: true, category: '', desc: '是否允许[[刷怪笼]]与[[试炼刷怪笼]]运作。' },
  { name: 'spectatorsGenerateChunks', type: 'bool', defaultValue: true, category: '', desc: '是否允许[[旁观模式]]的玩家生成区块。' },
  { name: 'tntExplodes', type: 'bool', defaultValue: true, category: '', desc: '[[TNT]]是否会爆炸。' },
  { name: 'tntExplosionDropDecay', type: 'bool', defaultValue: false, category: '', desc: '由TNT爆炸炸毁的方块是否会有概率不掉落。' },
  { name: 'universalAnger', type: 'bool', defaultValue: false, category: '', desc: '被激怒的条件敌对生物是否攻击附近任何玩家（而非只攻击激怒它们的玩家）。当{{cd|forgiveDeadPlayers}}关闭时会有更好的效果。' },
  { name: 'waterSourceConversion', type: 'bool', defaultValue: true, category: '', desc: '流动的水是否可产生水源。' },
]

/** 按服务器版本选择规则集（新旧版本兼容；版本比较走数值化防 1.21.2 > 1.21.11 字符串坑） */
export function pickGameruleSet(mcVersion: string): GameruleDef[] {
  const parse = (v: string) => {
    const m = v.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
    if (!m) return null
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] as const
  }
  const ver = parse(mcVersion)
  // 版本未知/空串按最新（与 NBT 三格式判定策略一致）
  if (!ver) return MINECRAFT_GAMERULES
  const [ma, mi, pa] = ver
  const atLeast12111 = ma > 1 || (ma === 1 && (mi > 21 || (mi === 21 && pa >= 11)))
  return atLeast12111 ? MINECRAFT_GAMERULES : LEGACY_GAMERULES
}

/** gamerule 查询命令（无参列出全部规则值，RCON 响应文本解析用） */
export const GAMERULE_QUERY_COMMAND = 'gamerule'

// ── 命令拼装与 RCON 响应解析 ──

/** 拼装 gamerule 设置命令（无前导 /，与 buildGiveCommand 一致） */
export function buildGameruleSetCommand(ruleName: string, value: string): string {
  return `gamerule ${ruleName} ${value}`
}

/**
 * 解析 RCON 'gamerule' 无参命令响应文本（英文原版格式：每行 '名字 = 值'）。
 * - 按行 split、trim，匹配 '名字 = (true|false|-?数字)'；首行提示/空行等不匹配行跳过
 * - 名字大小写不敏感与 defs 匹配，defs 里没有的名字跳过（旧版服务器列出的规则集可能小于前端 defs）
 * - 解析出的规则数 < defs 的 1/3 视为解析失败降级，返回 null
 * - 输出 Map<规范名, 值字符串>（名字以 defs 中的规范大小写为准）
 */
export function parseGameruleOutput(output: string, defs: GameruleDef[]): Map<string, string> | null {
  if (defs.length === 0) return null
  const lowerToDef = new Map<string, GameruleDef>()
  for (const def of defs) lowerToDef.set(def.name.toLowerCase(), def)
  const result = new Map<string, string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    const m = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(true|false|-?\d+)$/.exec(line)
    if (!m) continue
    const def = lowerToDef.get(m[1]!.toLowerCase())
    if (!def) continue
    result.set(def.name, m[2]!)
  }
  if (result.size < defs.length / 3) return null
  return result
}

/** 当前值显示：未查询到（undefined）→ 默认值 + 「默认」标记 */
export function gameruleDisplayValue(rule: GameruleDef, current: string | undefined): string {
  if (current === undefined) return `${String(rule.defaultValue)}（默认）`
  return current
}

/** 分类中文标签（新集 7 分类；旧集 category 为空串 → 「其他」） */
export const GAMERULE_CATEGORY_LABELS: Record<string, string> = {
  '': '其他',
  '世界更新': '世界更新',
  '掉落': '掉落',
  '聊天': '聊天',
  '杂项': '杂项',
  '玩家': '玩家',
  '生物': '生物',
  '生成': '生成',
}
