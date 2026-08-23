/**
 * Minecraft 物品目录（212 种）
 * 覆盖 MC 1.20.5 – 26.2+（Data Components 时代），含 1.21 新物品与 26.x 新物品。
 * 物品贴图来自 mc-heads.net（游戏内纹理渲染）。
 * stackSize：1（工具/护甲/武器）、16（末影珍珠/鸡蛋/药水）、64（方块/资源/食物），用于数量输入自动上限。
 */

export interface MinecraftItem {
  /** 游戏 ID（无命名空间前缀），如 "diamond"、"diamond_sword" */
  id: string
  /** 中文显示名 */
  name: string
  /** 分类（ITEM_CATEGORIES 之一） */
  category: string
  /** 最大堆叠数（1/16/64） */
  stackSize: number
}

/** 物品贴图服务根地址（36px 渲染） */
export const ITEM_IMAGE_BASE = 'https://mc-heads.net/item'

/** 全名（含 minecraft: 前缀），用于 give 命令 */
export function fullItemId(id: string): string {
  return `minecraft:${id}`
}

/** 贴图 URL（mc-heads.net 36×36 物品渲染） */
export function itemImageUrl(id: string): string {
  return `${ITEM_IMAGE_BASE}/${id}/36`
}

/** 筛选 Tab 的全部分类（药水分类在 UI 层由 mc-potions 提供 20 种效果虚拟物品） */
export const ITEM_CATEGORIES = [
  '全部',
  '建筑材料',
  '自然资源',
  '武器装备',
  '食物',
  '红石元件',
  '装饰方块',
  '工具',
  '药水',
  '杂项',
] as const

export type ItemCategory = (typeof ITEM_CATEGORIES)[number]

/** 全量物品目录 */
export const MINECRAFT_ITEMS: MinecraftItem[] = [
  // ── 自然资源 ──────────────────────────────────────────────
  { id: 'diamond', name: '钻石', category: '自然资源', stackSize: 64 },
  { id: 'emerald', name: '绿宝石', category: '自然资源', stackSize: 64 },
  { id: 'gold_ingot', name: '金锭', category: '自然资源', stackSize: 64 },
  { id: 'iron_ingot', name: '铁锭', category: '自然资源', stackSize: 64 },
  { id: 'copper_ingot', name: '铜锭', category: '自然资源', stackSize: 64 },
  { id: 'netherite_ingot', name: '下界合金锭', category: '自然资源', stackSize: 64 },
  { id: 'coal', name: '煤炭', category: '自然资源', stackSize: 64 },
  { id: 'charcoal', name: '木炭', category: '自然资源', stackSize: 64 },
  { id: 'lapis_lazuli', name: '青金石', category: '自然资源', stackSize: 64 },
  { id: 'redstone', name: '红石粉', category: '自然资源', stackSize: 64 },
  { id: 'quartz', name: '下界石英', category: '自然资源', stackSize: 64 },
  { id: 'amethyst_shard', name: '紫水晶碎片', category: '自然资源', stackSize: 64 },
  { id: 'raw_iron', name: '粗铁', category: '自然资源', stackSize: 64 },
  { id: 'raw_gold', name: '粗金', category: '自然资源', stackSize: 64 },
  { id: 'raw_copper', name: '粗铜', category: '自然资源', stackSize: 64 },
  { id: 'netherite_scrap', name: '下界合金碎片', category: '自然资源', stackSize: 64 },
  { id: 'flint', name: '燧石', category: '自然资源', stackSize: 64 },
  { id: 'clay_ball', name: '黏土球', category: '自然资源', stackSize: 64 },
  // 1.21 新资源
  { id: 'breeze_rod', name: '旋风棒', category: '自然资源', stackSize: 64 },
  { id: 'armadillo_scute', name: '犰狳鳞甲', category: '自然资源', stackSize: 64 },
  { id: 'heavy_core', name: '重锤核心', category: '自然资源', stackSize: 64 },
  // 26.1 新资源
  { id: 'golden_dandelion', name: '金蒲公英', category: '自然资源', stackSize: 64 },

  // ── 建筑材料 ──────────────────────────────────────────────
  { id: 'oak_planks', name: '橡木木板', category: '建筑材料', stackSize: 64 },
  { id: 'spruce_planks', name: '云杉木板', category: '建筑材料', stackSize: 64 },
  { id: 'birch_planks', name: '白桦木板', category: '建筑材料', stackSize: 64 },
  { id: 'stone', name: '石头', category: '建筑材料', stackSize: 64 },
  { id: 'cobblestone', name: '圆石', category: '建筑材料', stackSize: 64 },
  { id: 'mossy_cobblestone', name: '苔石', category: '建筑材料', stackSize: 64 },
  { id: 'stone_bricks', name: '石砖', category: '建筑材料', stackSize: 64 },
  { id: 'bricks', name: '红砖', category: '建筑材料', stackSize: 64 },
  { id: 'sandstone', name: '砂岩', category: '建筑材料', stackSize: 64 },
  { id: 'glass', name: '玻璃', category: '建筑材料', stackSize: 64 },
  { id: 'tinted_glass', name: '遮光玻璃', category: '建筑材料', stackSize: 64 },
  { id: 'obsidian', name: '黑曜石', category: '建筑材料', stackSize: 64 },
  { id: 'crying_obsidian', name: '哭泣的黑曜石', category: '建筑材料', stackSize: 64 },
  { id: 'deepslate', name: '深板岩', category: '建筑材料', stackSize: 64 },
  { id: 'calcite', name: '方解石', category: '建筑材料', stackSize: 64 },
  { id: 'tuff', name: '凝灰岩', category: '建筑材料', stackSize: 64 },
  { id: 'dripstone_block', name: '滴水石块', category: '建筑材料', stackSize: 64 },
  { id: 'smooth_basalt', name: '平滑玄武岩', category: '建筑材料', stackSize: 64 },
  { id: 'blackstone', name: '黑石', category: '建筑材料', stackSize: 64 },
  { id: 'end_stone', name: '末地石', category: '建筑材料', stackSize: 64 },
  { id: 'purpur_block', name: '紫珀块', category: '建筑材料', stackSize: 64 },
  { id: 'prismarine', name: '海晶石', category: '建筑材料', stackSize: 64 },
  { id: 'sea_lantern', name: '海晶灯', category: '建筑材料', stackSize: 64 },
  { id: 'glowstone', name: '荧石', category: '建筑材料', stackSize: 64 },
  { id: 'shroomlight', name: '菌光体', category: '建筑材料', stackSize: 64 },
  { id: 'concrete', name: '混凝土', category: '建筑材料', stackSize: 64 },
  { id: 'terracotta', name: '陶瓦', category: '建筑材料', stackSize: 64 },
  { id: 'white_wool', name: '白色羊毛', category: '建筑材料', stackSize: 64 },
  { id: 'oak_log', name: '橡木原木', category: '建筑材料', stackSize: 64 },
  { id: 'spruce_log', name: '云杉原木', category: '建筑材料', stackSize: 64 },
  // 1.21 铜系列
  { id: 'copper_door', name: '铜门', category: '建筑材料', stackSize: 64 },
  { id: 'copper_grate', name: '铜格栅', category: '建筑材料', stackSize: 64 },
  { id: 'chiseled_copper', name: '雕纹铜', category: '建筑材料', stackSize: 64 },
  // 26.2 硫磺系列
  { id: 'sulfur', name: '硫磺', category: '建筑材料', stackSize: 64 },
  { id: 'polished_sulfur', name: '磨制硫磺', category: '建筑材料', stackSize: 64 },
  { id: 'sulfur_bricks', name: '硫磺砖', category: '建筑材料', stackSize: 64 },
  { id: 'chiseled_sulfur', name: '雕纹硫磺', category: '建筑材料', stackSize: 64 },
  { id: 'sulfur_stairs', name: '硫磺楼梯', category: '建筑材料', stackSize: 64 },
  { id: 'sulfur_slab', name: '硫磺台阶', category: '建筑材料', stackSize: 64 },
  { id: 'sulfur_wall', name: '硫磺墙', category: '建筑材料', stackSize: 64 },
  { id: 'potent_sulfur', name: '烈性硫磺', category: '建筑材料', stackSize: 64 },
  { id: 'sulfur_spike', name: '硫磺尖刺', category: '建筑材料', stackSize: 64 },
  // 26.2 朱砂系列
  { id: 'cinnabar', name: '朱砂', category: '建筑材料', stackSize: 64 },
  { id: 'polished_cinnabar', name: '磨制朱砂', category: '建筑材料', stackSize: 64 },
  { id: 'cinnabar_bricks', name: '朱砂砖', category: '建筑材料', stackSize: 64 },
  { id: 'chiseled_cinnabar', name: '雕纹朱砂', category: '建筑材料', stackSize: 64 },
  { id: 'cinnabar_stairs', name: '朱砂楼梯', category: '建筑材料', stackSize: 64 },
  { id: 'cinnabar_slab', name: '朱砂台阶', category: '建筑材料', stackSize: 64 },
  { id: 'cinnabar_wall', name: '朱砂墙', category: '建筑材料', stackSize: 64 },

  // ── 武器装备 ──────────────────────────────────────────────
  { id: 'diamond_sword', name: '钻石剑', category: '武器装备', stackSize: 1 },
  { id: 'diamond_pickaxe', name: '钻石镐', category: '武器装备', stackSize: 1 },
  { id: 'diamond_axe', name: '钻石斧', category: '武器装备', stackSize: 1 },
  { id: 'diamond_shovel', name: '钻石锹', category: '武器装备', stackSize: 1 },
  { id: 'diamond_hoe', name: '钻石锄', category: '武器装备', stackSize: 1 },
  { id: 'diamond_helmet', name: '钻石头盔', category: '武器装备', stackSize: 1 },
  { id: 'diamond_chestplate', name: '钻石胸甲', category: '武器装备', stackSize: 1 },
  { id: 'diamond_leggings', name: '钻石护腿', category: '武器装备', stackSize: 1 },
  { id: 'diamond_boots', name: '钻石靴子', category: '武器装备', stackSize: 1 },
  { id: 'netherite_sword', name: '下界合金剑', category: '武器装备', stackSize: 1 },
  { id: 'netherite_pickaxe', name: '下界合金镐', category: '武器装备', stackSize: 1 },
  { id: 'netherite_axe', name: '下界合金斧', category: '武器装备', stackSize: 1 },
  { id: 'netherite_helmet', name: '下界合金头盔', category: '武器装备', stackSize: 1 },
  { id: 'netherite_chestplate', name: '下界合金胸甲', category: '武器装备', stackSize: 1 },
  { id: 'netherite_leggings', name: '下界合金护腿', category: '武器装备', stackSize: 1 },
  { id: 'netherite_boots', name: '下界合金靴子', category: '武器装备', stackSize: 1 },
  { id: 'iron_sword', name: '铁剑', category: '武器装备', stackSize: 1 },
  { id: 'iron_pickaxe', name: '铁镐', category: '武器装备', stackSize: 1 },
  { id: 'iron_helmet', name: '铁头盔', category: '武器装备', stackSize: 1 },
  { id: 'iron_chestplate', name: '铁胸甲', category: '武器装备', stackSize: 1 },
  { id: 'iron_leggings', name: '铁护腿', category: '武器装备', stackSize: 1 },
  { id: 'iron_boots', name: '铁靴子', category: '武器装备', stackSize: 1 },
  { id: 'bow', name: '弓', category: '武器装备', stackSize: 1 },
  { id: 'crossbow', name: '弩', category: '武器装备', stackSize: 1 },
  { id: 'trident', name: '三叉戟', category: '武器装备', stackSize: 1 },
  { id: 'shield', name: '盾牌', category: '武器装备', stackSize: 1 },
  { id: 'arrow', name: '箭', category: '武器装备', stackSize: 64 },
  { id: 'spectral_arrow', name: '光灵箭', category: '武器装备', stackSize: 64 },
  { id: 'totem_of_undying', name: '不死图腾', category: '武器装备', stackSize: 1 },
  // 1.21 新武器
  { id: 'mace', name: '重锤', category: '武器装备', stackSize: 1 },
  { id: 'wind_charge', name: '旋风弹', category: '武器装备', stackSize: 64 },
  { id: 'wolf_armor', name: '狼铠', category: '武器装备', stackSize: 1 },

  // ── 食物 ──────────────────────────────────────────────────
  { id: 'bread', name: '面包', category: '食物', stackSize: 64 },
  { id: 'cooked_beef', name: '牛排', category: '食物', stackSize: 64 },
  { id: 'cooked_porkchop', name: '熟猪排', category: '食物', stackSize: 64 },
  { id: 'cooked_chicken', name: '熟鸡肉', category: '食物', stackSize: 64 },
  { id: 'cooked_mutton', name: '熟羊肉', category: '食物', stackSize: 64 },
  { id: 'cooked_salmon', name: '熟鲑鱼', category: '食物', stackSize: 64 },
  { id: 'cooked_cod', name: '熟鳕鱼', category: '食物', stackSize: 64 },
  { id: 'golden_apple', name: '金苹果', category: '食物', stackSize: 64 },
  { id: 'enchanted_golden_apple', name: '附魔金苹果', category: '食物', stackSize: 64 },
  { id: 'cake', name: '蛋糕', category: '食物', stackSize: 1 },
  { id: 'cookie', name: '曲奇', category: '食物', stackSize: 64 },
  { id: 'pumpkin_pie', name: '南瓜派', category: '食物', stackSize: 64 },
  { id: 'apple', name: '苹果', category: '食物', stackSize: 64 },
  { id: 'melon_slice', name: '西瓜片', category: '食物', stackSize: 64 },
  { id: 'sweet_berries', name: '甜浆果', category: '食物', stackSize: 64 },
  { id: 'glow_berries', name: '发光浆果', category: '食物', stackSize: 64 },
  { id: 'carrot', name: '胡萝卜', category: '食物', stackSize: 64 },
  { id: 'golden_carrot', name: '金胡萝卜', category: '食物', stackSize: 64 },
  { id: 'potato', name: '马铃薯', category: '食物', stackSize: 64 },
  { id: 'baked_potato', name: '烤马铃薯', category: '食物', stackSize: 64 },
  { id: 'beetroot', name: '甜菜根', category: '食物', stackSize: 64 },
  { id: 'mushroom_stew', name: '蘑菇煲', category: '食物', stackSize: 1 },
  { id: 'rabbit_stew', name: '兔肉煲', category: '食物', stackSize: 1 },
  { id: 'beetroot_soup', name: '甜菜汤', category: '食物', stackSize: 1 },
  { id: 'honey_bottle', name: '蜂蜜瓶', category: '食物', stackSize: 16 },

  // ── 红石元件 ──────────────────────────────────────────────
  { id: 'redstone_block', name: '红石块', category: '红石元件', stackSize: 64 },
  { id: 'repeater', name: '红石中继器', category: '红石元件', stackSize: 64 },
  { id: 'comparator', name: '红石比较器', category: '红石元件', stackSize: 64 },
  { id: 'piston', name: '活塞', category: '红石元件', stackSize: 64 },
  { id: 'sticky_piston', name: '粘性活塞', category: '红石元件', stackSize: 64 },
  { id: 'observer', name: '侦测器', category: '红石元件', stackSize: 64 },
  { id: 'hopper', name: '漏斗', category: '红石元件', stackSize: 64 },
  { id: 'dropper', name: '投掷器', category: '红石元件', stackSize: 64 },
  { id: 'dispenser', name: '发射器', category: '红石元件', stackSize: 64 },
  { id: 'tnt', name: 'TNT', category: '红石元件', stackSize: 64 },
  { id: 'lever', name: '拉杆', category: '红石元件', stackSize: 64 },
  { id: 'stone_button', name: '石按钮', category: '红石元件', stackSize: 64 },
  { id: 'tripwire_hook', name: '绊线钩', category: '红石元件', stackSize: 64 },
  { id: 'daylight_detector', name: '阳光探测器', category: '红石元件', stackSize: 64 },
  { id: 'target', name: '靶子', category: '红石元件', stackSize: 64 },
  { id: 'sculk_sensor', name: '幽匿感测体', category: '红石元件', stackSize: 64 },
  // 1.21 新红石
  { id: 'crafter', name: '合成器', category: '红石元件', stackSize: 64 },
  { id: 'copper_bulb', name: '铜灯', category: '红石元件', stackSize: 64 },

  // ── 装饰方块 ──────────────────────────────────────────────
  { id: 'painting', name: '画', category: '装饰方块', stackSize: 64 },
  { id: 'armor_stand', name: '盔甲架', category: '装饰方块', stackSize: 16 },
  { id: 'item_frame', name: '物品展示框', category: '装饰方块', stackSize: 64 },
  { id: 'glow_item_frame', name: '荧光物品展示框', category: '装饰方块', stackSize: 64 },
  { id: 'flower_pot', name: '花盆', category: '装饰方块', stackSize: 64 },
  { id: 'bookshelf', name: '书架', category: '装饰方块', stackSize: 64 },
  { id: 'chiseled_bookshelf', name: '雕纹书架', category: '装饰方块', stackSize: 64 },
  { id: 'end_rod', name: '末地烛', category: '装饰方块', stackSize: 64 },
  { id: 'torch', name: '火把', category: '装饰方块', stackSize: 64 },
  { id: 'soul_torch', name: '灵魂火把', category: '装饰方块', stackSize: 64 },
  { id: 'lantern', name: '灯笼', category: '装饰方块', stackSize: 64 },
  { id: 'soul_lantern', name: '灵魂灯笼', category: '装饰方块', stackSize: 64 },
  { id: 'candle', name: '蜡烛', category: '装饰方块', stackSize: 64 },
  { id: 'bee_nest', name: '蜂巢', category: '装饰方块', stackSize: 64 },
  { id: 'honey_block', name: '蜂蜜块', category: '装饰方块', stackSize: 64 },
  { id: 'slime_block', name: '粘液块', category: '装饰方块', stackSize: 64 },
  { id: 'decorated_pot', name: '装饰罐', category: '装饰方块', stackSize: 64 },
  { id: 'lodestone', name: '磁石', category: '装饰方块', stackSize: 64 },
  { id: 'respawn_anchor', name: '重生锚', category: '装饰方块', stackSize: 64 },
  { id: 'beacon', name: '信标', category: '装饰方块', stackSize: 64 },
  { id: 'red_bed', name: '床', category: '装饰方块', stackSize: 64 },
  // 26.2 新装饰
  { id: 'geyser', name: '间歇泉', category: '装饰方块', stackSize: 64 },

  // ── 工具 ──────────────────────────────────────────────────
  { id: 'fishing_rod', name: '钓鱼竿', category: '工具', stackSize: 1 },
  { id: 'flint_and_steel', name: '打火石', category: '工具', stackSize: 1 },
  { id: 'shears', name: '剪刀', category: '工具', stackSize: 1 },
  { id: 'compass', name: '指南针', category: '工具', stackSize: 64 },
  { id: 'recovery_compass', name: '追溯指南针', category: '工具', stackSize: 64 },
  { id: 'clock', name: '时钟', category: '工具', stackSize: 64 },
  { id: 'spyglass', name: '望远镜', category: '工具', stackSize: 64 },
  { id: 'brush', name: '刷子', category: '工具', stackSize: 1 },
  { id: 'lead', name: '拴绳', category: '工具', stackSize: 64 },
  { id: 'name_tag', name: '命名牌', category: '工具', stackSize: 64 },
  { id: 'saddle', name: '鞍', category: '工具', stackSize: 1 },
  { id: 'elytra', name: '鞘翅', category: '工具', stackSize: 1 },
  { id: 'firework_rocket', name: '烟花火箭', category: '工具', stackSize: 64 },
  { id: 'water_bucket', name: '水桶', category: '工具', stackSize: 1 },
  { id: 'lava_bucket', name: '熔岩桶', category: '工具', stackSize: 1 },
  { id: 'milk_bucket', name: '奶桶', category: '工具', stackSize: 1 },
  { id: 'ender_pearl', name: '末影珍珠', category: '工具', stackSize: 16 },
  { id: 'ender_eye', name: '末影之眼', category: '工具', stackSize: 64 },
  { id: 'experience_bottle', name: '经验瓶', category: '工具', stackSize: 64 },
  { id: 'writable_book', name: '书与笔', category: '工具', stackSize: 1 },
  { id: 'enchanted_book', name: '附魔书', category: '工具', stackSize: 1 },
  { id: 'bundle', name: '收纳袋', category: '工具', stackSize: 1 },
  { id: 'map', name: '空地图', category: '工具', stackSize: 1 },
  { id: 'oak_boat', name: '橡木船', category: '工具', stackSize: 1 },
  { id: 'spruce_boat', name: '云杉木船', category: '工具', stackSize: 1 },
  { id: 'bamboo_raft', name: '竹筏', category: '工具', stackSize: 1 },

  // ── 杂项 ──────────────────────────────────────────────────
  { id: 'firework_star', name: '烟花星', category: '杂项', stackSize: 64 },
  { id: 'glass_bottle', name: '玻璃瓶', category: '杂项', stackSize: 64 },
  { id: 'potion', name: '药水', category: '杂项', stackSize: 1 },
  { id: 'splash_potion', name: '喷溅药水', category: '杂项', stackSize: 16 },
  { id: 'lingering_potion', name: '滞留药水', category: '杂项', stackSize: 16 },
  // 1.21 新杂项
  { id: 'trial_key', name: '试炼钥匙', category: '杂项', stackSize: 64 },
  { id: 'ominous_trial_key', name: '不祥试炼钥匙', category: '杂项', stackSize: 64 },
  { id: 'ominous_bottle', name: '不祥瓶子', category: '杂项', stackSize: 64 },
  // 唱片
  { id: 'music_disc_13', name: '唱片 13', category: '杂项', stackSize: 1 },
  { id: 'music_disc_cat', name: '唱片 cat', category: '杂项', stackSize: 1 },
  { id: 'music_disc_pigstep', name: '唱片 Pigstep', category: '杂项', stackSize: 1 },
  // 26.2 新唱片
  { id: 'music_disc_bounce', name: '唱片 Bounce', category: '杂项', stackSize: 1 },
  // 26.2 硫磺史莱姆相关
  { id: 'bucket_of_sulfur_cube', name: '硫磺史莱姆桶', category: '杂项', stackSize: 1 },
  { id: 'sulfur_cube_spawn_egg', name: '硫磺史莱姆刷怪蛋', category: '杂项', stackSize: 64 },
  // 特殊物品
  { id: 'dragon_egg', name: '龙蛋', category: '杂项', stackSize: 1 },
  { id: 'dragon_breath', name: '龙息', category: '杂项', stackSize: 64 },
  { id: 'nether_star', name: '下界之星', category: '杂项', stackSize: 64 },
  { id: 'end_crystal', name: '末影水晶', category: '杂项', stackSize: 64 },
]
