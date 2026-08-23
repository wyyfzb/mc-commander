import { useState } from 'react'
import { Megaphone, Send } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useSendCommand } from '@/hooks/use-send-command'
import { Chip } from '@/components/mcs/chip'

/**
 * 公告发送卡
 * - say 全服广播：模板 chips 填充 → 发送 → 命令回显终端
 */

const TEMPLATES = [
  '服务器将在 5 分钟后重启，请及时停靠',
  '维护结束，祝游玩愉快！',
] as const

export function AnnouncementCard() {
  const [text, setText] = useState('')
  const { send, isRunning, sending } = useSendCommand()

  const handleSend = () => {
    const t = text.trim()
    if (!t) return
    if (send(`say ${t}`)) setText('')
  }

  return (
    <section className="flex shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4">
      <header className="mb-2 flex items-center gap-2">
        <h3 className="text-mcs-sm font-medium text-mcs-text-muted">公告发送</h3>
        <Chip tone="muted" className="ml-auto h-5 px-1.5 text-mcs-2xs">
          say 全服广播
        </Chip>
      </header>

      <div className="flex items-center gap-1.5">
        <Megaphone className="size-3.5 shrink-0 text-mcs-text-subtle" aria-hidden />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend()
          }}
          placeholder="输入公告内容…"
          disabled={!isRunning}
          aria-label="公告内容"
          className="h-8"
        />
        <Button size="sm" onClick={handleSend} disabled={!isRunning || sending || !text.trim()} aria-label="发送公告">
          <Send className="size-3.5" aria-hidden />
          发送
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {TEMPLATES.map((t) => (
          <Chip key={t} onClick={() => setText(t)}>
            {t}
          </Chip>
        ))}
      </div>
    </section>
  )
}
