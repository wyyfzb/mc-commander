/**
 * InventoryTab —— 物品栏 Tab
 *
 * 【契约落实】
 * 1. 布局 41 格：装备 5（头盔/胸甲/护腿/靴子/副手，带标签横排）+ 主背包 27（9×3）+ 快捷栏 9（1 行）
 *    + 子 Tab：玩家物品栏 / 末影箱（27 格 9×3，紫色调边框）
 * 2. 格子渲染：mc-heads.net 36px 贴图（itemImageUrl）；数量角标（count>1 右下角）；hover tooltip
 *    显示 id/数量/耐久百分比/附魔标记/自定义名；附魔物品紫色边框+微光；底部耐久条（绿→黄→红）
 * 3. 空态三分支：封禁 → 锁图标「该玩家已被封禁，无法查看物品栏」；旁观模式 →「旁观模式无物品栏」；
 *    无数据（inventory=null）→ 在线「RCON 不可用」/ 离线「无存档数据」（附解释性 subtext）
 * 4. 快照提示条：source='snapshot' →「数据来自上次存档快照，可能非实时」（info 色）
 * 5. partial=true → 截断降级提示（warning 色）
 * 6. 选中槽位高亮 —— Web 简化：hover 边框高亮（不实现槽位详情弹层）
 * 7. 设计纪律：全部 --mcs-* 语义 token；格子实底（玻璃禁区）；不硬编码色值/间距/圆角
 */
import { useState, type KeyboardEvent } from 'react'
import {
  AlertTriangle,
  CloudOff,
  EyeOff,
  History,
  Hourglass,
  Lock,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { fullItemId, itemImageUrl } from '@/lib/mc-items'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { InventoryItem, Player, PlayerInventory } from '@/api/types'
import { NoticeBanner } from '@/components/mcs/notice-banner'

export interface InventoryTabProps {
  player: Player
}

/** 子 Tab：玩家物品栏 / 末影箱 */
type SubTab = 'player' | 'ender'

const SUB_TABS: Array<{ value: SubTab; label: string }> = [
  { value: 'player', label: '玩家物品栏' },
  { value: 'ender', label: '末影箱' },
]

/** 格子尺寸（契约建议 32-36px，取 32 适配 420px 面板 9 列紧凑网格） */
const SLOT_SIZE = 32

/**
 * 格子网的漫游焦点（roving tabindex）：整张表只占**一个** Tab 停靠点，格间用方向键走。
 * 41 格若各自 tabIndex=0，键盘用户要逐个 Tab 才能穿过物品栏——本仓日历已用同一范式
 * （date-picker-calendar.tsx），不再造第二种键盘网格。
 * 刻意不声明 role="grid"：九列是 CSS grid，没有可供 row/gridcell 挂靠的行结构，
 * 只报 grid 不给行/单元是无效 ARIA，比不声明更糟。这里的收益是停靠点收敛与方向键导航。
 *
 * 方向按**槽位号**算而非按渲染出的按钮序号算：空槽不渲染按钮，若按序号走，
 * 主背包 slot 0 按「右」会跳到 slot 9（视觉上在正下方）。空槽按方向跳过、
 * 越界即停（不循环——绕到另一端会被误读成「跳到了别的物品」）。
 */
const ROVING_STEP: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowDown: 1,
}

function rovingGridKeys(event: KeyboardEvent<HTMLDivElement>, cols: number, total: number) {
  const step =
    event.key === 'ArrowUp' ? -cols : event.key === 'ArrowDown' ? cols : ROVING_STEP[event.key]
  const cells = new Map<number, HTMLElement>()
  for (const el of event.currentTarget.querySelectorAll<HTMLElement>('[data-slot-index]')) {
    cells.set(Number(el.dataset.slotIndex), el)
  }
  if (!cells.size) return

  if (event.key === 'Home' || event.key === 'End') {
    const order = [...cells.keys()].sort((a, b) => a - b)
    const target = event.key === 'Home' ? order[0] : order[order.length - 1]
    if (target != null) {
      event.preventDefault()
      cells.get(target)?.focus()
    }
    return
  }
  if (step == null) return

  let cur: number | null = null
  for (const [idx, el] of cells) if (el === document.activeElement) cur = idx
  if (cur == null) return

  for (let at = cur + step; at >= 0 && at < total; at += step) {
    // 横向不出行：行内一路是空槽时停住，不绕到下一行去（那会跳到视觉上方/下方的格子）
    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      Math.floor(at / cols) !== Math.floor(cur / cols)
    )
      return
    const el = cells.get(at)
    if (el) {
      event.preventDefault()
      el.focus()
      return
    }
  }
}

/** 该格是否承载 Tab 落点＝本表第一个占用格（其余 tabIndex=-1，仍可被方向键聚焦） */
function isFirstOccupied(items: (InventoryItem | null)[], index: number) {
  return items.findIndex((it) => it != null) === index
}

export function InventoryTab({ player }: InventoryTabProps) {
  const [subTab, setSubTab] = useState<SubTab>('player')
  const inventory = player.inventory

  // ── 空态三分支（契约第 3 条）──
  if (player.isBanned) {
    return <EmptyState icon={Lock} message="该玩家已被封禁，无法查看物品栏" />
  }
  if (player.gameMode === 'spectator') {
    return <EmptyState icon={EyeOff} message="旁观模式无物品栏" />
  }
  if (!inventory) {
    return player.isOnline ? (
      <EmptyState
        icon={Hourglass}
        message="RCON 不可用"
        subtext="请确认服务器已开启 RCON，或玩家存在 playerdata 存档文件"
      />
    ) : (
      <EmptyState
        icon={CloudOff}
        message="无存档数据"
        subtext="该玩家无 playerdata 存档文件，无法查看背包快照"
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ── 子 Tab 切换器（激活态 accent 底 + 前景；边界由轨道承载）── */}
      <div
        role="tablist"
        aria-label="物品栏子视图"
        className="inline-flex self-start rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-muted p-0.5"
      >
        {SUB_TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={subTab === t.value}
            onClick={() => setSubTab(t.value)}
            className={cn(
              'rounded-mcs-xs px-3 py-1 text-mcs-xs transition-colors',
              subTab === t.value
                ? 'bg-mcs-accent-bg-subtle font-medium text-mcs-accent-fg'
                : 'text-mcs-text-muted hover:text-mcs-text-default',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 快照提示条（契约第 4 条）── */}
      {inventory.source === 'snapshot' && (
        <NoticeBanner variant="info" icon={History}>
          数据来自上次存档快照，可能非实时
        </NoticeBanner>
      )}

      {/* ── partial 截断降级提示（契约第 5 条）── */}
      {inventory.partial && (
        <NoticeBanner variant="warning" icon={AlertTriangle}>
          物品栏数据不完整（响应过长被截断），仅显示已获取部分
        </NoticeBanner>
      )}

      {subTab === 'player' ? (
        <PlayerInventoryPanel inventory={inventory} />
      ) : (
        <EnderChestPanel inventory={inventory} />
      )}
    </div>
  )
}

/** 玩家物品栏面板（41 格：装备 5 + 主背包 27 + 快捷栏 9 + 统计行） */
function PlayerInventoryPanel({ inventory }: { inventory: PlayerInventory }) {
  const quickbar = fillSlots(inventory.quickbar, 9)
  const main = fillSlots(inventory.main, 27)
  const equipment = inventory.equipment
  const equipmentItems = [
    equipment.helmet,
    equipment.chestplate,
    equipment.leggings,
    equipment.boots,
    equipment.offhand,
  ]
  const equipmentLabels = ['头盔', '胸甲', '护腿', '靴子', '副手']

  return (
    <div className="flex flex-col items-center gap-2 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default p-3">
      {/* 装备 5 格（带标签：头盔/胸甲/护腿/靴子 + 副手） */}
      <div
        className="flex items-end gap-2"
        onKeyDown={(e) => rovingGridKeys(e, 5, equipmentItems.length)}
      >
        {equipmentItems.map((item, i) => (
          <div key={equipmentLabels[i]} className="flex flex-col items-center gap-1">
            <InventorySlot
              item={item}
              focusable={isFirstOccupied(equipmentItems, i)}
              slotIndex={i}
            />
            <span className="text-mcs-2xs text-mcs-text-muted">{equipmentLabels[i]}</span>
          </div>
        ))}
      </div>

      {/* 主背包 27 格 9×3 */}
      <div className="grid grid-cols-9 gap-1" onKeyDown={(e) => rovingGridKeys(e, 9, main.length)}>
        {main.map((item, i) => (
          <InventorySlot
            key={`main-${i}`}
            item={item}
            focusable={isFirstOccupied(main, i)}
            slotIndex={i}
          />
        ))}
      </div>

      {/* 快捷栏 9 格 1 行 */}
      <div
        className="grid grid-cols-9 gap-1"
        onKeyDown={(e) => rovingGridKeys(e, 9, quickbar.length)}
      >
        {quickbar.map((item, i) => (
          <InventorySlot
            key={`qb-${i}`}
            item={item}
            focusable={isFirstOccupied(quickbar, i)}
            slotIndex={i}
          />
        ))}
      </div>

      {/* 统计行 */}
      <div className="flex gap-3 pt-0.5">
        <SlotStat label="快捷栏" value={`${countUsed(quickbar)}/9`} />
        <SlotStat label="背包" value={`${countUsed(main)}/27`} />
        <SlotStat label="装备" value={`${countUsed(equipmentItems)}/5`} />
      </div>
    </div>
  )
}

/** 末影箱面板（27 格 9×3，紫色调） */
function EnderChestPanel({ inventory }: { inventory: PlayerInventory }) {
  const ender = fillSlots(inventory.enderChest, 27)
  const used = countUsed(ender)

  return (
    <div className="flex flex-col items-center gap-2 rounded-mcs-sm border border-mcs-purple-border bg-mcs-bg-default p-3">
      <div className="grid grid-cols-9 gap-1" onKeyDown={(e) => rovingGridKeys(e, 9, ender.length)}>
        {ender.map((item, i) => (
          <InventorySlot
            key={`ender-${i}`}
            item={item}
            variant="ender"
            focusable={isFirstOccupied(ender, i)}
            slotIndex={i}
          />
        ))}
      </div>

      <div className="flex gap-3 pt-0.5">
        <SlotStat label="末影箱" value={`${used}/27`} />
        <SlotStat label="空位" value={`${27 - used}`} accent />
      </div>

      <p className="text-mcs-xs text-mcs-text-muted">
        末影箱数据来自玩家存档（playerdata EnderItems）
      </p>
    </div>
  )
}

/** 单格：贴图 / 数量角标 / 耐久条 / 附魔紫光 / hover tooltip */
function InventorySlot({
  item,
  variant = 'default',
  focusable = true,
  slotIndex,
}: {
  item: InventoryItem | null
  variant?: 'default' | 'ender'
  /** 漫游焦点：只有本表第一个占用格承载 Tab 落点 */
  focusable?: boolean
  /** 槽位号：方向键按网格几何算步进要用它（不是渲染序号） */
  slotIndex: number
}) {
  const slotStyle = { width: SLOT_SIZE, height: SLOT_SIZE }

  // 空槽（实底弱边框，无交互）
  if (!item) {
    return (
      <span
        data-testid="inv-slot"
        aria-hidden
        style={slotStyle}
        className={cn(
          'block rounded-mcs-xs border',
          variant === 'ender'
            ? 'border-mcs-purple-border bg-mcs-purple-bg-subtle'
            : 'border-mcs-border-subtle bg-mcs-bg-muted',
        )}
      />
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="inv-slot"
          data-slot-index={slotIndex}
          tabIndex={focusable ? 0 : -1}
          aria-label={item.customName || fullItemId(item.id)}
          style={{
            ...slotStyle,
            // 附魔物品紫色微光（token 引用，非硬编码色值）
            ...(item.enchanted ? { boxShadow: '0 0 5px 0 var(--mcs-purple-fg)' } : {}),
          }}
          className={cn(
            // 格子是图形对象不是文本术语，故不套 InfoHint 的虚线下划线；
            // 但触发器必须是可聚焦的 button 且浮层走 Popover——原先是
            // Tooltip + 不可聚焦 <span>，键盘拿不到物品信息、触屏点按也不响应
            'relative block cursor-help rounded-mcs-xs border transition-colors',
            'hover:border-mcs-accent-border-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-mcs-focus-ring',
            variant === 'ender'
              ? 'border-mcs-purple-border bg-mcs-purple-bg-subtle'
              : 'border-mcs-border-default bg-mcs-bg-muted',
            item.enchanted && 'border-mcs-purple-border',
          )}
        >
          <SlotIcon item={item} />

          {/* 数量角标（count>1 右下角） */}
          {item.count > 1 && (
            <span className="absolute bottom-0 right-0 rounded-sm bg-mcs-bg-emphasis px-0.5 font-mono text-mcs-2xs font-semibold leading-tight text-mcs-text-default tabular-nums">
              {item.count}
            </span>
          )}

          {/* 耐久条（底部 2px，绿→黄→红） */}
          {item.durability != null && (
            <span className="absolute inset-x-0.5 bottom-0 h-0.5 overflow-hidden rounded-full bg-mcs-bg-emphasis">
              <span
                className={cn('block h-full rounded-full', durabilityColor(item.durability))}
                style={{ width: `${Math.round(clamp01(item.durability) * 100)}%` }}
              />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        aria-label={item.customName || fullItemId(item.id)}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <span className="flex flex-col gap-0.5">
          {/* customName 玩家可控（铁砧限 35 字符但命令/数据包可超），break-all 防长串溢出浮层框 */}
          {item.customName && <span className="break-all font-medium">{item.customName}</span>}
          {/* 数据包可引入自定义命名空间 ID 且长度无上限，与 customName 行同防护 */}
          <span className="break-all font-mono">{fullItemId(item.id)}</span>
          <span>
            {item.count > 1 ? `数量 ×${item.count}` : '数量 ×1'}
            {item.durability != null && ` · 耐久 ${Math.round(clamp01(item.durability) * 100)}%`}
            {item.enchanted && ' · 已附魔'}
          </span>
        </span>
      </PopoverContent>
    </Popover>
  )
}

/** 物品贴图（mc-heads.net；加载失败回退 ID 前两字符） */
function SlotIcon({ item }: { item: InventoryItem }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span className="flex size-full items-center justify-center overflow-hidden font-mono text-mcs-2xs text-mcs-text-muted">
        {item.id.slice(0, 2) || '?'}
      </span>
    )
  }

  return (
    <img
      src={itemImageUrl(item.id)}
      alt={item.id}
      width={SLOT_SIZE - 4}
      height={SLOT_SIZE - 4}
      draggable={false}
      onError={() => setFailed(true)}
      className="absolute inset-0 m-auto select-none"
    />
  )
}

/** 空态卡片 */
function EmptyState({
  icon: Icon,
  message,
  subtext,
}: {
  icon: LucideIcon
  message: string
  subtext?: string
}) {
  return (
    <div className="flex w-full flex-col items-center gap-2 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-6 py-10">
      <Icon className="size-8 text-mcs-text-muted" aria-hidden />
      <p className="text-mcs-sm text-mcs-text-muted">{message}</p>
      {subtext && <p className="text-mcs-xs text-mcs-text-muted">{subtext}</p>}
    </div>
  )
}

/** 统计小卡片 */
function SlotStat({
  label,
  value,
  accent = false,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <span className="flex flex-col items-center gap-0.5 rounded-mcs-xs bg-mcs-bg-muted px-2.5 py-1">
      <span className="text-mcs-2xs text-mcs-text-muted">{label}</span>
      <span
        className={cn(
          'font-mono text-mcs-xs font-semibold tabular-nums',
          accent ? 'text-mcs-accent-fg' : 'text-mcs-text-default',
        )}
      >
        {value}
      </span>
    </span>
  )
}

/** 按槽位索引搬运到定长数组（服务端契约：数组已按槽位有序；null 原样搬运） */
function fillSlots(items: (InventoryItem | null)[], length: number): (InventoryItem | null)[] {
  const slots: (InventoryItem | null)[] = new Array(length).fill(null)
  for (let i = 0; i < Math.min(items.length, length); i++) {
    const item = items[i]
    if (item !== undefined) slots[i] = item
  }
  return slots
}

/** 统计非空格数 */
function countUsed(slots: (InventoryItem | null)[]): number {
  return slots.filter((s) => s !== null).length
}

/** 耐久分色（>0.6 绿 / >0.3 黄 / 否则红） */
function durabilityColor(durability: number): string {
  if (durability > 0.6) return 'bg-mcs-success-fg'
  if (durability > 0.3) return 'bg-mcs-warning-fg'
  return 'bg-mcs-error-fg'
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
