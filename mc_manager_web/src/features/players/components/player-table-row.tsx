/**
 * PlayerRow —— 玩家表格行（自 player-table.tsx 拆出，纯搬移零行为变更）
 *
 * 行点击只服务指针便利（整行可点）；**键盘/读屏入口是玩家名列的详情按钮**：
 * `<table>` 祖先下的 `<tr>` 只允许 `row` 角色（ARIA in HTML），加交互角色会
 * 把行从表格结构中摘出去，故行本身不聚焦、不处理按键——否则读屏用户既得不到
 * 可激活语义，又要在每行多停一个 Tab 位。选择列与操作列阻断行点击冒泡。
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
      onClick={() => onOpenDetail(p.name)}
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
