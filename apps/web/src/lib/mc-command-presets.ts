/**
 * 命令快捷指令的默认值（唯一声明源）
 *
 * 两条选型判据：
 * 1. 面板已图形化的命令不进默认值——同一件事有两个入口，用户不知道该用哪个。
 *    仪表盘的时间/天气有预设按钮（mc-clock-card），保存有按钮（instance-controls），
 *    在线名单、玩家级操作（gamemode/effect/give/tp/summon）在玩家页，都不在此列。
 * 2. 不写 `@p`：服务端控制台执行选择器时以 `0 0 0` 为执行位置（vanilla 行为），
 *    故 `@p` 取的是「距原点最近」而非「任意一个玩家」，目标不可预期。
 *    需要全服生效时用 `@a`；需要指定对象时由用户自己填。
 */
export const DEFAULT_COMMAND_PRESETS = [
  'tp @a 0 100 0',
  'gamemode creative @a',
  'fill ~-5 ~-1 ~-5 ~5 ~-1 ~5 stone',
  'effect give @a night_vision 600 0',
  'summon minecraft:lightning_bolt',
]
