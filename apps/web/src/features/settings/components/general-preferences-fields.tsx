/**
 * GeneralPreferencesFields —— 「连接与外观」页里的界面偏好字段本体
 * 三项全部是**这个浏览器**的偏好：ui store 的 partialize 白名单只落这三项到 localStorage，
 * 换设备/换浏览器不跟随（与账号、与实例都无关）。
 * - 界面主题：ui store theme/setTheme（深色/浅色即时生效）
 * - 终端自动滚动 / 命令执行二次确认：浏览器本地开关，改了立即生效、不发请求
 * 实例级配置（内存、JVM 参数、自动重启）不在这里，它们的写入口是 PUT /instances/:id。
 * 只出字段、不出卡片面：容器（区块卡）由调用点给，避免一个页面里两种卡片基座。
 */
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUiStore, type ThemeMode } from '@/stores/ui'

/** 三个浏览器本地偏好开关的字段本体（无卡片外观，供区块卡或整卡复用） */
export function GeneralPreferencesFields() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const terminalAutoScroll = useUiStore((s) => s.terminalAutoScroll)
  const setTerminalAutoScroll = useUiStore((s) => s.setTerminalAutoScroll)
  const confirmCommands = useUiStore((s) => s.confirmCommands)
  const setConfirmCommands = useUiStore((s) => s.setConfirmCommands)

  const handleThemeChange = (value: string) => {
    setTheme(value as ThemeMode)
  }

  return (
    <>
      <div className="flex items-center gap-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-mcs-sm font-semibold text-mcs-text-default">界面主题</div>
          <div className="mt-0.5 text-mcs-xs text-mcs-text-muted">深色/浅色主题切换</div>
        </div>
        <Select value={theme} onValueChange={handleThemeChange}>
          <SelectTrigger className="w-24" aria-label="界面主题">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dark">暗色</SelectItem>
            <SelectItem value="light">亮色</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-3 border-t border-mcs-border-subtle py-3">
        <div className="min-w-0 flex-1">
          <div className="text-mcs-sm font-semibold text-mcs-text-default">终端自动滚动</div>
          <div className="mt-0.5 text-mcs-xs text-mcs-text-muted">
            新日志自动滚动到底部（关闭后停留在当前位置）
          </div>
        </div>
        <Switch
          checked={terminalAutoScroll}
          onCheckedChange={setTerminalAutoScroll}
          aria-label="终端自动滚动"
        />
      </div>

      <div className="flex items-center gap-3 border-t border-mcs-border-subtle py-3">
        <div className="min-w-0 flex-1">
          <div className="text-mcs-sm font-semibold text-mcs-text-default">命令执行二次确认</div>
          <div className="mt-0.5 text-mcs-xs text-mcs-text-muted">
            危险命令执行前弹确认（终端输入不受影响）
          </div>
        </div>
        <Switch
          checked={confirmCommands}
          onCheckedChange={setConfirmCommands}
          aria-label="命令执行二次确认"
        />
      </div>
    </>
  )
}
