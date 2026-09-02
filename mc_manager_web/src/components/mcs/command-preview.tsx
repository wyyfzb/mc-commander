/**
 * CommandPreview —— 终端风格命令预览条
 * 全站统一复用：玩家 give-item / action-forms / 天气-时间 / 任务执行确认等有命令下发语义的场景
 * （备份恢复为目录快照复制、无命令下发，不适用本组件）。
 * 提取自 give-item-preview-bar.tsx，保持完全一致的视觉风格。
 */
import { Copy, Terminal } from 'lucide-react'
import { toast } from 'sonner'

export function CommandPreview({ command }: { command: string }) {
  // 空串守卫：调用方 command 缺失时静默不渲染（旧版行为，防契约降级）
  if (!command) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      toast.success('命令已复制', { duration: 1500 })
    } catch {
      toast.error('复制失败')
    }
  }
  return (
    <div
      className="flex items-center gap-1.5 rounded-mcs-xs border border-mcs-border-muted px-2 py-1.5"
      style={{ backgroundColor: 'var(--mcs-terminal-bg)' }}
      data-testid="command-preview"
    >
      <Terminal className="size-3 shrink-0 text-mcs-terminal-accent" aria-hidden />
      <code className="min-w-0 flex-1 truncate font-mono text-mcs-2xs leading-snug text-mcs-terminal-fg-bright">
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="复制命令"
        className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-terminal-subtle hover:bg-mcs-bg-hover hover:text-mcs-text-default"
      >
        <Copy className="size-3" aria-hidden />
      </button>
    </div>
  )
}
