import { useState } from 'react'
import { Pencil, Plus, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSendCommand } from '@/hooks/use-send-command'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { primaryModifierLabel } from '@/lib/platform'

/**
 * 公告发送卡
 * - say 全服广播：预设胶囊填充 → 发送 → 命令回显终端
 * - 多行文本域：Enter 换行，Ctrl/⌘+Enter 发送；多行公告用 tellraw（JSON 文本组件）
 * - 广播影响全体在线玩家：发送前 ConfirmDialog 二次确认（Tasteful Friction）
 * - 预设（名称+文案）localStorage 持久化，可增删改（与命令快捷指令同模式）
 */

/** 公告预设：胶囊显示名称，tooltip 显示文案 */
interface AnnouncementPreset {
  name: string
  content: string
}

const PRESET_STORAGE_KEY = 'mcs-announcement-presets'
const DEFAULT_PRESETS: AnnouncementPreset[] = [
  { name: '重启预告', content: '服务器将在 5 分钟后重启，请及时停靠' },
  { name: '维护结束', content: '维护结束，祝游玩愉快！' },
]

function readPresets(): AnnouncementPreset[] {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AnnouncementPreset[]
      if (Array.isArray(parsed)) return parsed
    }
  } catch {
    // 回退默认
  }
  return DEFAULT_PRESETS
}

function writePresets(presets: AnnouncementPreset[]) {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets))
  } catch {
    // localStorage 不可用时静默忽略
  }
}

export function AnnouncementCard() {
  const [text, setText] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { send, isRunning, sending } = useSendCommand()
  // 预设列表 + 编辑器状态（editIndex=null 新增，数字=编辑下标）
  const [presets, setPresets] = useState<AnnouncementPreset[]>(readPresets)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [formName, setFormName] = useState('')
  const [formContent, setFormContent] = useState('')
  // 删除经二次确认（待删下标；null=未发起）
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)

  const openNewPreset = () => {
    setEditIndex(null)
    setFormName('')
    setFormContent('')
    setEditorOpen(true)
  }

  const openEditPreset = (index: number) => {
    setEditIndex(index)
    setFormName(presets[index]?.name ?? '')
    setFormContent(presets[index]?.content ?? '')
    setEditorOpen(true)
  }

  const savePreset = () => {
    const name = formName.trim()
    const content = formContent.trim()
    if (!name || !content) return
    const next =
      editIndex == null
        ? [...presets, { name, content }]
        : presets.map((p, i) => (i === editIndex ? { name, content } : p))
    setPresets(next)
    writePresets(next)
    setEditorOpen(false)
    toast.success(`已保存预设: ${name}`)
  }

  const removePreset = (index: number) => {
    const next = presets.filter((_, i) => i !== index)
    setPresets(next)
    writePresets(next)
    setDeleteIndex(null)
  }

  const requestSend = () => {
    if (!text.trim()) return
    setConfirmOpen(true)
  }

  const confirmSend = () => {
    const t = text.trim()
    if (!t) return
    // 多行公告用 tellraw（JSON 文本组件支持 \n），单行保持 say
    const cmd = t.includes('\n') ? `tellraw @a ${JSON.stringify({ text: t })}` : `say ${t}`
    if (send(cmd)) setText('')
    setConfirmOpen(false)
  }

  return (
    <section className="animate-mcs-fade-up mcs-delay-6 mcs-edge-top relative flex shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4 shadow-mcs-card">
      <header className="mb-2 flex items-center gap-2">
        <h3 className="text-mcs-sm font-medium text-mcs-text-muted">公告发送</h3>
        <Button
          size="sm"
          onClick={requestSend}
          disabled={!isRunning || sending || !text.trim()}
          aria-label="发送公告"
          className="ml-auto"
        >
          <Send className="size-3.5" aria-hidden />
          发送
        </Button>
      </header>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 文本域：Enter 换行（多行公告），Ctrl/Cmd+Enter 发送（同样经二次确认）
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') requestSend()
        }}
        placeholder={`输入公告内容…（${primaryModifierLabel()}+Enter 发送，支持多行）`}
        disabled={!isRunning}
        aria-label="公告内容"
        className="min-h-16 w-full"
      />

      {/* 预设胶囊行：点击名称填充文案；tooltip 预览全文；铅笔编辑 / X 移除 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {presets.map((preset, index) => (
          <span
            key={`${preset.name}-${index}`}
            className="inline-flex items-center gap-1 rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default py-1 pr-1 pl-2 text-mcs-xs text-mcs-text-muted transition-colors hover:bg-mcs-state-hover"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="max-w-40 cursor-pointer truncate hover:text-mcs-text-default"
                  onClick={() => setText(preset.content)}
                >
                  {preset.name}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-60 whitespace-pre-wrap">
                {preset.content}
              </TooltipContent>
            </Tooltip>
            <button
              type="button"
              aria-label={`编辑预设 ${preset.name}`}
              className="cursor-pointer text-mcs-text-muted hover:text-mcs-text-default"
              onClick={() => openEditPreset(index)}
            >
              <Pencil className="size-3" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`删除预设 ${preset.name}`}
              className="cursor-pointer text-mcs-text-muted hover:text-mcs-error-fg"
              onClick={() => setDeleteIndex(index)}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-label="添加预设"
          className="inline-flex cursor-pointer items-center gap-1 rounded-mcs-sm border border-dashed border-mcs-border-default px-2 py-1 text-mcs-xs text-mcs-text-muted transition-colors hover:text-mcs-text-default"
          onClick={openNewPreset}
        >
          <Plus className="size-3" aria-hidden />
          添加
        </button>
      </div>

      {/* 预设编辑器：名称 + 文案（新增/编辑共用） */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editIndex == null ? '添加预设' : '编辑预设'}</DialogTitle>
            <DialogDescription>点击胶囊将文案填充到公告输入框</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preset-name">预设名</Label>
              <Input
                id="preset-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="如：重启预告"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preset-content">公告文案</Label>
              <Textarea
                id="preset-content"
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                placeholder="公告内容…（支持多行）"
                className="min-h-16"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              取消
            </Button>
            <Button onClick={savePreset} disabled={!formName.trim() || !formContent.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteIndex != null}
        onOpenChange={(open) => {
          if (!open) setDeleteIndex(null)
        }}
        title="删除预设"
        description={`确定删除预设「${deleteIndex != null ? (presets[deleteIndex]?.name ?? '') : ''}」？`}
        confirmText="删除"
        danger
        onConfirm={() => {
          if (deleteIndex != null) removePreset(deleteIndex)
        }}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="发送全服公告"
        description="将向全体在线玩家广播，确认发送？"
        confirmText="发送"
        loading={sending}
        onConfirm={confirmSend}
        warning="此公告将立即广播给全体在线玩家"
      >
        <p className="max-h-40 overflow-y-auto rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-subtle p-2 text-mcs-xs text-mcs-text-muted whitespace-pre-wrap">
          {text.trim()}
        </p>
      </ConfirmDialog>
    </section>
  )
}
