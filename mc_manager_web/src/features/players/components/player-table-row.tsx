/**
 * PlayerRow —— 玩家表格行（自 player-table.tsx 拆出，纯搬移零行为变更）
 * 行点击/键盘打开详情；选择列与操作列阻断行点击冒泡
 */
import { flexRender } from '@tanstack/react-table'
import type { Row } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import type { Player } from '@/api/types'
import { ROW_HEIGHT, features } from './player-table-config'

export function PlayerRow({
  row,
  selected,
  onOpenDetail,
}: {
  row: Row<typeof features, Player>
  selected: boolean
  onOpenDetail: (name: string) => void
}) {
  const p = row.original
  return (
    <tr
      className={cn(
        'cursor-pointer border-b border-mcs-border-subtle transition-colors',
        selected ? 'bg-mcs-accent-bg-subtle' : 'hover:bg-mcs-state-hover active:bg-mcs-state-pressed',
        (p.isBanned || p.isIpBanned) && 'bg-mcs-error-bg-subtle',
      )}
      style={{ height: ROW_HEIGHT }}
      tabIndex={0}
      aria-label={`查看 ${p.name} 详情`}
      onClick={() => onOpenDetail(p.name)}
      onKeyDown={(e) => {
        // 只响应落在行本身上的回车：行内复选框/操作按钮自行处理按键，
        // 否则空格会被行吞掉（键盘用户无法勾选玩家）、回车会二次触发
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return
        e.preventDefault()
        onOpenDetail(p.name)
      }}
    >
      {row.getVisibleCells().map((cell) => (
        <td
          key={cell.id}
          className="truncate px-2"
          onClick={(e) => {
            // 选择列与操作列不触发行点击
            if (cell.column.id === 'actions' || cell.column.id === 'select') e.stopPropagation()
          }}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  )
}
