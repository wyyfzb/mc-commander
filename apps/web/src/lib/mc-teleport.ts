/**
 * 传送命令拼装
 * 6 入口：世界出生点 / 个人复活点 / 主世界原点 / 自定义快捷点 / 坐标表单 / 传送到其他在线玩家。
 * 命令一律不带前导 `/`（控制台/RCON 不接受）。
 * 约束：tp 不支持离线玩家——单个模式离线时整 Tab 显示离线提示；批量模式过滤在线目标执行。
 */
import type { PanelPreferences } from '@mc-commander/schemas'
import { writePreference } from '@/stores/panel-preferences'

/** 坐标点 */
export interface TeleportPoint {
  x: number
  y: number
  z: number
}

/** 世界出生点缺省值（0, 64, 0） */
export const DEFAULT_WORLD_SPAWN: TeleportPoint = { x: 0, y: 64, z: 0 }

/** 自定义快捷传送点 */
export interface QuickTeleportPoint extends TeleportPoint {
  /** 名称 */
  name: string
}

/** 快捷传送点持久化 schema：{hideOrigin, items:[{name,x,y,z}]} */
export interface QuickTeleportSchema {
  /** 是否隐藏「主世界原点」入口 */
  hideOrigin: boolean
  items: QuickTeleportPoint[]
}

/** 传送玩家到坐标（坐标取整） */
export function buildTeleportToCoordsCommand(playerName: string, point: TeleportPoint): string {
  return `tp ${playerName} ${Math.round(point.x)} ${Math.round(point.y)} ${Math.round(point.z)}`
}

/** 传送玩家到另一在线玩家 */
export function buildTeleportToPlayerCommand(playerName: string, targetName: string): string {
  return `tp ${playerName} ${targetName}`
}

/** 修改世界出生点命令（设置前需二次确认） */
export function buildSetWorldSpawnCommand(point: TeleportPoint): string {
  return `setworldspawn ${Math.round(point.x)} ${Math.round(point.y)} ${Math.round(point.z)}`
}

/**
 * 解析个人复活点目标：respawnPoint → spawnPoint → 世界出生点缺省（0,64,0）。
 */
export function resolveRespawnTarget(
  respawnPoint: TeleportPoint | null | undefined,
  spawnPoint: TeleportPoint | null | undefined,
  worldSpawn: TeleportPoint = DEFAULT_WORLD_SPAWN,
): TeleportPoint {
  return respawnPoint ?? spawnPoint ?? worldSpawn
}

/** 从未配置过快捷传送点时的默认形态 */
export const DEFAULT_QUICK_TELEPORTS: QuickTeleportSchema = { hideOrigin: false, items: [] }

/** 从偏好快照派生快捷传送点：渲染期直接订阅，不另存本地副本 */
export function quickTeleportsFromPreferences(
  remote: PanelPreferences | null,
): QuickTeleportSchema {
  return remote?.quickTeleports ?? DEFAULT_QUICK_TELEPORTS
}

/** 写入快捷传送点（整份替换）；失败抛出，由调用方提示 */
export function saveQuickTeleports(schema: QuickTeleportSchema): Promise<void> {
  return writePreference('quickTeleports', schema)
}
