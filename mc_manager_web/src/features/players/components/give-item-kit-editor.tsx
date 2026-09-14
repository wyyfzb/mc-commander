/**
 * 礼包编辑器 —— KitEditorDialog（新建/编辑礼包弹窗）+ KitTab（预设礼包 Tab 内容）
 * 从 give-item-dialog.tsx 提取，礼包管理独立可测试。
 * KitEditorDialog 带脏状态关闭拦截（对齐 task-dialog 范式）：
 * name/icon/desc/items 相对初始值有改动时，ESC/遮罩/X/取消一律先弹确认（继续编辑/放弃修改）。
 */
import { useMemo, useState } from 'react'
import { Minus, MoreVertical, Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SearchInput } from '@/components/mcs/search-input'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { useRadioGroup } from '@/hooks/use-radio-group'
import { TONE_SELECTED_SURFACE_CLASSES } from '@/components/mcs/tone'
import { cn } from '@/lib/utils'
import {
  ITEM_CATEGORIES,
  MINECRAFT_ITEMS,
  fullItemId,
  itemImageUrl,
  type MinecraftItem,
} from '@/lib/mc-items'
import { type KitItem, type KitPreset } from '@/lib/mc-kits'

/** 数量上限（1-6400 clamp） */
const MAX_COUNT = 6400
/** 礼包图标 emoji 预设（24 种） */
const KIT_ICON_PRESETS = [
  '\u{1F4E6}', '\u{1F381}', '\u{1F331}', '\u{1F48E}', '\u{1F525}', '\u{1F9F1}', '\u{1F356}', '\u{2697}\uFE0F', '\u{2694}\uFE0F', '\u{1F6E1}\uFE0F', '\u{26CF}\uFE0F', '\u{1FA93}',
  '\u{1F3F9}', '\u{1F3A3}', '\u{1F680}', '\u{2B50}', '\u{1F31F}', '\u{2728}', '\u{1F389}', '\u{1F3C6}', '\u{1F4B0}', '\u{1F3AF}', '\u{1F9EA}', '\u{1F35E}',
]

/** 礼包 Tab：卡片列表 + 新建入口 + 编辑/删除/应用 */
export function KitTab({
  kits,
  onApply,
  onEdit,
  onDelete,
  onNew,
}: {
  kits: KitPreset[]
  onApply: (kit: KitPreset) => void
  onEdit: (index: number, kit: KitPreset) => void
  onDelete: (index: number) => void
  onNew: () => void
}) {
  return (
    <div className="flex flex-col gap-2 pb-1">
      {/* 新建礼包卡 */}
      <button
        type="button"
        onClick={onNew}
        className={cn(
          TONE_SELECTED_SURFACE_CLASSES,
          'flex items-center gap-2.5 rounded-mcs-md border border-dashed px-3 py-2.5 text-left transition-colors hover:bg-mcs-state-hover',
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
          <Plus className="size-4 text-mcs-accent-fg" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-mcs-sm font-semibold text-mcs-accent-fg">新建礼包</span>
          <span className="block text-mcs-xs text-mcs-text-muted">点击创建自定义物品礼包</span>
        </span>
      </button>

      {/* 礼包卡片 */}
      {kits.map((kit, index) => (
        <div
          key={`${kit.name}-${index}`}
          data-testid={`kit-card-${kit.name}`}
          className="flex items-center gap-2.5 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-default px-3 py-2.5"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle text-mcs-lg">
            {kit.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-mcs-sm font-medium text-mcs-text-default">
              {kit.name}
            </div>
            <div className="truncate text-mcs-xs text-mcs-text-muted">
              {kit.desc || `含 ${kit.items.length} 件物品`}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`${kit.name} 礼包操作`}>
                <MoreVertical aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => onEdit(index, { ...kit, items: kit.items.map((it) => ({ ...it })) })}
              >
                <Pencil aria-hidden />
                编辑
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-mcs-error-fg focus:text-mcs-error-fg"
                onClick={() => onDelete(index)}
              >
                <Trash2 aria-hidden />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="xs" onClick={() => onApply(kit)}>
            <Plus aria-hidden />
            添加
          </Button>
        </div>
      ))}
    </div>
  )
}

/** 礼包编辑器：名称 + emoji 24 预设 + 描述 + 物品 chip 列表 + 物品选择器 */
export function KitEditorDialog({
  initial,
  isNew,
  onSave,
  onClose,
}: {
  initial: KitPreset
  isNew: boolean
  onSave: (kit: KitPreset) => void
  onClose: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [icon, setIcon] = useState(initial.icon)
  const [desc, setDesc] = useState(initial.desc)
  const [items, setItems] = useState<KitItem[]>(() => initial.items.map((it) => ({ ...it })))
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('全部')
  const [confirmClose, setConfirmClose] = useState(false)

  // 图标预设是单选组（新建礼包时可为空 → 无选中是合法态）
  const iconGroup = useRadioGroup<string>({
    label: '礼包图标',
    value: icon === '' ? null : icon,
    values: KIT_ICON_PRESETS,
    onChange: setIcon,
  })

  /** 礼包相对初始值是否有改动（dirty 关闭拦截依据；items 逐件深比较） */
  const dirty =
    name !== initial.name ||
    icon !== initial.icon ||
    desc !== initial.desc ||
    items.length !== initial.items.length ||
    items.some(
      (it, i) => it.id !== initial.items[i]?.id || it.count !== initial.items[i]?.count,
    )

  /** 所有关闭路径（遮罩/ESC/X/取消按钮）统一入口：dirty → 确认，否则直接关 */
  const handleOpenChange = (next: boolean) => {
    if (next) return
    if (dirty) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  const filteredItems = useMemo(() => {
    let list = category === '全部' ? MINECRAFT_ITEMS : MINECRAFT_ITEMS.filter((i) => i.category === category)
    const query = search.trim().toLowerCase()
    if (query.length > 0) {
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(query) ||
          i.id.toLowerCase().includes(query) ||
          fullItemId(i.id).toLowerCase().includes(query),
      )
    }
    return list
  }, [category, search])

  const addItem = (item: MinecraftItem) => {
    setItems((prev) => [...prev, { id: item.id, count: 1 }])
  }

  const setItemCount = (index: number, count: number) => {
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, count: Math.min(MAX_COUNT, Math.max(1, count)) } : it)),
    )
  }

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const save = () => {
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      toast.warning('请输入礼包名称')
      return
    }
    if (items.length === 0) {
      toast.warning('请至少添加一个物品')
      return
    }
    onSave({
      name: trimmedName,
      icon: icon.trim().length > 0 ? icon.trim() : '📦',
      desc: desc.trim(),
      items,
    })
  }

  return (
    <>
      <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? '新建礼包' : '编辑礼包'}</DialogTitle>
          <DialogDescription className="sr-only">
            {isNew ? '创建自定义物品礼包' : '编辑礼包内容'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 名称 + 图标 */}
          <div className="flex items-start gap-3">
            <div className="flex w-16 shrink-0 flex-col gap-1">
              <span className="text-mcs-xs text-mcs-text-muted">图标</span>
              <input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                aria-label="礼包图标"
                maxLength={4}
                className="h-9 rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default text-center text-mcs-lg text-mcs-text-default focus:border-mcs-accent-border focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
              />
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-mcs-xs text-mcs-text-muted">名称</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="礼包名称"
                placeholder="如：新手起步包"
                maxLength={20}
                className="mt-1 h-9 w-full rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default px-2.5 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-muted focus:border-mcs-accent-border focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
              />
            </div>
          </div>

          {/* emoji 预设（单选组：每个图标自带可访问名） */}
          <div className="flex flex-wrap gap-1" {...iconGroup.groupProps}>
            {KIT_ICON_PRESETS.map((emoji, index) => (
              <button
                key={emoji}
                type="button"
                {...iconGroup.itemProps(index)}
                onClick={() => setIcon(emoji)}
                aria-label={`选择图标 ${emoji}`}
                className={cn(
                  'flex size-6 items-center justify-center rounded-mcs-xs text-mcs-sm transition-colors',
                  icon === emoji
                    ? `border ${TONE_SELECTED_SURFACE_CLASSES}`
                    : 'border border-transparent bg-mcs-bg-muted hover:bg-mcs-state-hover',
                )}
              >
                {emoji}
              </button>
            ))}
          </div>

          {/* 描述 */}
          <div className="flex flex-col gap-1">
            <span className="text-mcs-xs text-mcs-text-muted">描述（可选）</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              aria-label="礼包描述"
              placeholder="如：木镐+石剑+面包×16"
              rows={2}
              maxLength={60}
              className="resize-none rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default px-2.5 py-1.5 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-muted focus:border-mcs-accent-border focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
            />
          </div>

          {/* 当前物品 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-mcs-xs font-medium text-mcs-text-default">
              当前物品（{items.length}）
            </span>
            {items.length === 0 ? (
              /* 空态：纯文本主流写法（同 task-dialog「暂无执行记录」），dashed 孤例已消除 */
              <p className="text-mcs-xs text-mcs-text-muted">未添加物品，请从下方选择</p>
            ) : (
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {items.map((entry, index) => {
                  const item = MINECRAFT_ITEMS.find((i) => i.id === entry.id)
                  return (
                    <div
                      key={`${entry.id}-${index}`}
                      className="flex w-50 shrink-0 items-center gap-1 rounded-mcs-sm border border-mcs-border-subtle bg-mcs-bg-muted py-1 pl-1 pr-1.5"
                    >
                      {item ? (
                        <img
                          src={itemImageUrl(item.id)}
                          alt={item.name}
                          width={22}
                          height={22}
                          draggable={false}
                          className="shrink-0 select-none"
                        />
                      ) : (
                        <span className="flex size-5.5 shrink-0 items-center justify-center rounded-mcs-xs bg-mcs-error-bg-subtle font-mono text-mcs-2xs text-mcs-error-fg">
                          ?
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-mcs-xs text-mcs-text-default">
                          {item?.name ?? entry.id}
                        </div>
                        <div className="flex items-center">
                          <button
                            type="button"
                            onClick={() => setItemCount(index, entry.count - 1)}
                            aria-label={`减少 ${item?.name ?? entry.id} 数量`}
                            className="rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
                          >
                            <Minus className="size-3" aria-hidden />
                          </button>
                          <span className="w-7 text-center text-mcs-xs font-semibold tabular-nums text-mcs-accent-fg">
                            {entry.count}
                          </span>
                          <button
                            type="button"
                            onClick={() => setItemCount(index, entry.count + 1)}
                            aria-label={`增加 ${item?.name ?? entry.id} 数量`}
                            className="rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
                          >
                            <Plus className="size-3" aria-hidden />
                          </button>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeItem(index)}
                        aria-label={`移除 ${item?.name ?? entry.id}`}
                        className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 物品选择器 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-mcs-xs font-medium text-mcs-text-default">添加物品</span>
              <span className="text-mcs-2xs text-mcs-text-muted">找到 {filteredItems.length} 个</span>
            </div>
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="搜索物品名称或 ID..."
              aria-label="搜索礼包物品"
              clearable={false}
            />
            <div className="flex gap-1 overflow-x-auto">
              {ITEM_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-mcs-xs transition-colors',
                    category === cat
                      ? 'bg-mcs-accent-bg-subtle font-medium text-mcs-accent-fg'
                      : 'text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default',
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredItems.length === 0 ? (
                <p className="py-6 text-center text-mcs-xs text-mcs-text-muted">
                  没有找到匹配的物品
                </p>
              ) : (
                <div className="grid grid-cols-6 gap-1" data-testid="kit-picker-grid">
                  {filteredItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => addItem(item)}
                      className="flex flex-col items-center gap-0.5 rounded-mcs-sm border border-mcs-border-subtle bg-mcs-bg-muted px-0.5 py-1 transition-colors hover:border-mcs-accent-border hover:bg-mcs-accent-bg-subtle"
                    >
                      <img
                        src={itemImageUrl(item.id)}
                        alt={item.name}
                        width={28}
                        height={28}
                        draggable={false}
                        className="select-none"
                      />
                      <span className="w-full truncate text-center text-mcs-2xs text-mcs-text-default">
                        {item.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <span className="mr-auto text-mcs-xs text-mcs-text-muted">共 {items.length} 件物品</span>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save}>{isNew ? '创建' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>

      {/* dirty 关闭确认：允许关闭但需显式确认 */}
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={(next) => {
          if (!next) setConfirmClose(false)
        }}
        title="放弃未保存的修改？"
        description="礼包有未保存的修改，关闭对话框将丢失这些修改。"
        confirmText="放弃修改"
        cancelText="继续编辑"
        onConfirm={() => {
          setConfirmClose(false)
          onClose()
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  )
}
