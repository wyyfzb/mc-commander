import { useState } from 'react'
import { Eye, EyeOff, TriangleAlert } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * PasswordInput —— 密码输入统一组件（显隐切换 + CapsLock 提醒）
 * 显隐交互由应用内按钮承载：Edge 注入的原生 reveal 按钮已在 index.css
 * 全局隐藏（须置于 @layer 外，见该处注释）
 */
export function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
  className,
  showCapsLock = true,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  autoFocus?: boolean
  className?: string
  showCapsLock?: boolean
}) {
  const [visible, setVisible] = useState(false)
  const [capsLock, setCapsLock] = useState(false)

  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyUp={(e) => setCapsLock(e.getModifierState?.('CapsLock') ?? false)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          className={cn('h-10 pr-10 font-mono', className)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? '隐藏密码' : '显示密码'}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-mcs-sm p-1.5 text-mcs-text-subtle transition-colors hover:bg-mcs-bg-hover hover:text-mcs-text-default"
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
      {showCapsLock && capsLock && (
        <p className="flex items-center gap-1 text-mcs-2xs text-mcs-warning-fg" role="status">
          <TriangleAlert className="size-3" aria-hidden />
          大写锁定已开启
        </p>
      )}
    </div>
  )
}
