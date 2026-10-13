/**
 * 玩家数据 Excel 导出（13 列）
 * 文件名「玩家数据_yyyyMMdd_HHmm.xlsx」
 */
import type { Player } from '@/api/types'
import { downloadXlsx, type XlsxColumn } from '@/lib/xlsx'

const GAME_MODE_LABELS: Record<string, string> = {
  survival: '生存',
  creative: '创造',
  adventure: '冒险',
  spectator: '旁观',
}

const DIMENSION_LABELS: Record<string, string> = {
  overworld: '主世界',
  nether: '下界',
  end: '末地',
}

const PLAYER_COLUMNS: readonly XlsxColumn[] = [
  { header: '玩家名', width: 16 },
  { header: 'UUID', width: 36 },
  { header: '游戏模式', width: 10 },
  { header: '维度', width: 10 },
  { header: '坐标X', width: 10 },
  { header: '坐标Y', width: 10 },
  { header: '坐标Z', width: 10 },
  { header: '连接状态', width: 10 },
  { header: '总时长(h)', width: 10 },
  { header: 'OP', width: 6 },
  { header: '白名单', width: 8 },
  { header: '封禁', width: 6 },
  { header: '假人', width: 6 },
]

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function buildFilename(date: Date): string {
  return `玩家数据_${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}.xlsx`
}

/** 生成并下载玩家 Excel（13 列） */
export async function exportPlayersToExcel(players: Player[]): Promise<void> {
  const rows = players.map((player) => [
    player.name,
    player.uuid,
    player.gameMode ? (GAME_MODE_LABELS[player.gameMode] ?? player.gameMode) : '',
    player.dimension ? (DIMENSION_LABELS[player.dimension] ?? player.dimension) : '',
    player.position ? Math.round(player.position.x) : '',
    player.position ? Math.round(player.position.y) : '',
    player.position ? Math.round(player.position.z) : '',
    player.isOnline ? '在线' : '离线',
    (player.totalPlayTime / 3600).toFixed(1),
    player.isOp ? '是' : '否',
    player.isWhitelisted ? '是' : '否',
    player.isBanned || player.isIpBanned ? '是' : '否',
    player.isFakePlayer ? '是' : '否',
  ])

  await downloadXlsx('玩家数据', PLAYER_COLUMNS, rows, buildFilename(new Date()))
}
