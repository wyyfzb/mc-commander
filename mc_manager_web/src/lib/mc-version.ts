/**
 * MC 版本号的**判定口径**（解析与比较本身已收进契约包，web 与服务端共用唯一一份）。
 *
 * 为什么只留判定在这层：解析器只该有一份——否则同一串版本号在面板与服务端会得到不同结论
 * （服务端据此判断「这个版本有没有管理协议推送面」，判错就会替不支持的版本写配置）。
 * 而「不可解析时怎么办」是**各域自己的判断**：物品可用性偏保守、其余以新版为准，
 * 不该由共享模块替它们决定，故 `whenUnknown` 由调用方显式传入。
 */
import { compareVersions } from '@mc-commander/schemas'

export { compareVersions, parseVersion, type VersionTriple } from '@mc-commander/schemas'

/** `a >= b`？任一侧不可解析时返回 `whenUnknown` */
export function isVersionAtLeast(a: string, min: string, whenUnknown: boolean): boolean {
  const cmp = compareVersions(a, min)
  return cmp === null ? whenUnknown : cmp >= 0
}
