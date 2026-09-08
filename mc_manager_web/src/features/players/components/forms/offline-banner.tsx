/** RCON 断连提示横幅（经验/效果/召唤三表单共用，自 action-forms.tsx 原样迁入） */
import { CloudOff } from 'lucide-react'

export function OfflineBanner() {
  return (
    <div className="flex items-center gap-2 rounded-mcs-sm border border-mcs-warning-border bg-mcs-warning-bg-subtle p-2.5">
      <CloudOff className="size-4 shrink-0 text-mcs-warning-fg" aria-hidden="true" />
      <span className="text-mcs-xs text-mcs-warning-fg">RCON 未连接，无法执行操作</span>
    </div>
  )
}
