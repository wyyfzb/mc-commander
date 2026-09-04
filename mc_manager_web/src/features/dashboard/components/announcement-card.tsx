import { useState } from 'react'
import { Send } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useSendCommand } from '@/hooks/use-send-command'
import { Chip } from '@/components/mcs/chip'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'

/**
 * 公告发送卡
 * - say 全服广播：模板 chips 填充 → 发送 → 命令回显终端
 * - 多行文本域：Enter 换行，Ctrl+Enter 发送；多行公告用 tellraw（JSON 文本组件）
 * - 广播影响全体在线玩家：发送前 ConfirmDialog 二次确认（Tasteful Friction）
 */

const TEMPLATES = [
  '服务器将在 5 分钟后重启，请及时停靠',
  '维护结束，祝游玩愉快！',
] as const

export function AnnouncementCard() {
  const [text, setText] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { send, isRunning, sending } = useSendCommand()

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
        placeholder="输入公告内容…（Ctrl+Enter 发送，支持多行）"
        disabled={!isRunning}
        aria-label="公告内容"
        className="min-h-16 w-full"
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {TEMPLATES.map((t) => (
          <Chip key={t} onClick={() => setText(t)}>
            {t}
          </Chip>
        ))}
      </div>

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
