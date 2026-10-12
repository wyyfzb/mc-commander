/**
 * 坐标传送表单 hook：初值取展示基准玩家当前位置；
 * 服务器高频推送 position 对象（引用常变、坐标数值不变），提取原始坐标进依赖数组，
 * 仅数值实际变化且用户未手动修改（coordsTouched）时同步表单。
 */
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_WORLD_SPAWN, type TeleportPoint } from '@/lib/mc-teleport'
import type { Player } from '@/api/types'

export interface CoordsValue {
  x: string
  y: string
  z: string
}

export function useCoordsForm(displayPlayer: Player | null) {
  const initialPos: TeleportPoint = displayPlayer?.position ?? DEFAULT_WORLD_SPAWN
  const [coords, setCoords] = useState<CoordsValue>({
    x: String(Math.round(initialPos.x)),
    y: String(Math.round(initialPos.y)),
    z: String(Math.round(initialPos.z)),
  })
  const coordsTouched = useRef(false)

  // 坐标提取为原始值再进依赖数组：避免按对象引用依赖反复 setState
  const posX = displayPlayer?.position?.x
  const posY = displayPlayer?.position?.y
  const posZ = displayPlayer?.position?.z
  useEffect(() => {
    if (posX == null || posY == null || posZ == null || coordsTouched.current) return
    setCoords({
      x: String(Math.round(posX)),
      y: String(Math.round(posY)),
      z: String(Math.round(posZ)),
    })
  }, [posX, posY, posZ])

  /** 手动修改坐标：标记 touched 停止位置实时同步 */
  const setCoord = (axis: keyof CoordsValue, value: string) => {
    coordsTouched.current = true
    setCoords((c) => ({ ...c, [axis]: value }))
  }

  /** 解析当前表单为数值坐标；非法返回 null（调用方负责 toast 拦截） */
  const parseCoords = (): TeleportPoint | null => {
    const x = Number.parseFloat(coords.x)
    const y = Number.parseFloat(coords.y)
    const z = Number.parseFloat(coords.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    return { x, y, z }
  }

  return { coords, setCoord, parseCoords }
}
