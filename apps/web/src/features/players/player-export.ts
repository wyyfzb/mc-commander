/**
 * 玩家数据 Excel 导出（浏览器端 exceljs 生成，13 列）
 * 文件名「玩家数据_yyyyMMdd_HHmm.xlsx」
 */
import type { Player } from '@/api/types'

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

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function buildFilename(date: Date): string {
  return `玩家数据_${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}.xlsx`
}

/** 生成并下载玩家 Excel（13 列） */
export async function exportPlayersToExcel(players: Player[]): Promise<void> {
  // exceljs 约 900KB：按需加载，避免整块计入玩家页首访体积（只有点导出才付这份代价）
  const exceljs = await import('exceljs')
  const workbook = new exceljs.Workbook()
  const sheet = workbook.addWorksheet('玩家数据')

  sheet.columns = [
    { header: '玩家名', key: 'name', width: 16 },
    { header: 'UUID', key: 'uuid', width: 36 },
    { header: '游戏模式', key: 'gameMode', width: 10 },
    { header: '维度', key: 'dimension', width: 10 },
    { header: '坐标X', key: 'x', width: 10 },
    { header: '坐标Y', key: 'y', width: 10 },
    { header: '坐标Z', key: 'z', width: 10 },
    { header: '连接状态', key: 'status', width: 10 },
    { header: '总时长(h)', key: 'totalHours', width: 10 },
    { header: 'OP', key: 'op', width: 6 },
    { header: '白名单', key: 'whitelist', width: 8 },
    { header: '封禁', key: 'banned', width: 6 },
    { header: '假人', key: 'fake', width: 6 },
  ]

  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }

  for (const player of players) {
    sheet.addRow({
      name: player.name,
      uuid: player.uuid,
      gameMode: player.gameMode ? (GAME_MODE_LABELS[player.gameMode] ?? player.gameMode) : '',
      dimension: player.dimension ? (DIMENSION_LABELS[player.dimension] ?? player.dimension) : '',
      x: player.position ? Math.round(player.position.x) : '',
      y: player.position ? Math.round(player.position.y) : '',
      z: player.position ? Math.round(player.position.z) : '',
      status: player.isOnline ? '在线' : '离线',
      totalHours: (player.totalPlayTime / 3600).toFixed(1),
      op: player.isOp ? '是' : '否',
      whitelist: player.isWhitelisted ? '是' : '否',
      banned: player.isBanned || player.isIpBanned ? '是' : '否',
      fake: player.isFakePlayer ? '是' : '否',
    })
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = buildFilename(new Date())
  anchor.click()
  URL.revokeObjectURL(url)
}
