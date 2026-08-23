/**
 * 传送命令拼装
 * 6 入口：世界出生点 / 个人复活点 / 主世界原点 / 自定义快捷点 / 坐标表单 / 传送到其他在线玩家。
 * 命令一律不带前导 `/`（控制台/RCON 不接受）。
 * 约束：tp 不支持离线玩家——单个模式离线时整 Tab 显示离线提示；批量模式过滤在线目标执行。
 */

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

export const QUICK_TELEPORT_STORAGE_KEY = 'mc_commander_quick_teleports'

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

/** 从 localStorage 读取快捷传送点（损坏回退默认 schema） */
export function loadQuickTeleports(storage: Storage): QuickTeleportSchema {
  try {
    const raw = storage.getItem(QUICK_TELEPORT_STORAGE_KEY)
    if (raw === null || raw.length === 0) return { hideOrigin: false, items: [] }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { hideOrigin: false, items: [] }
    const obj = parsed as Record<string, unknown>
    const rawItems = Array.isArray(obj.items) ? obj.items : []
    const items: QuickTeleportPoint[] = rawItems
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .filter(
        (e) =>
          typeof e.name === 'string' &&
          typeof e.x === 'number' &&
          typeof e.y === 'number' &&
          typeof e.z === 'number',
      )
      .map((e) => ({
        name: e.name as string,
        x: e.x as number,
        y: e.y as number,
        z: e.z as number,
      }))
    return { hideOrigin: obj.hideOrigin === true, items }
  } catch {
    return { hideOrigin: false, items: [] }
  }
}

/** 保存快捷传送点到 localStorage */
export function saveQuickTeleports(storage: Storage, schema: QuickTeleportSchema): void {
  storage.setItem(
    QUICK_TELEPORT_STORAGE_KEY,
    JSON.stringify({
      hideOrigin: schema.hideOrigin,
      items: schema.items.map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z })),
    }),
  )
}
