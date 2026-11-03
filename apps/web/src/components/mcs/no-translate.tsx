import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * NoTranslate —— 包住「用户要照着原样输入的确认串」：被翻译改写的字面与服务端按原值
 * trim 全等比对的目标必然不匹配，破坏性操作会被永久挡在门外。
 * `translate="no"` 是 HTML 标准属性，覆盖整棵子树及其中的可翻译属性（含 placeholder）；
 * `notranslate` 是 Google 系引擎认的非标准类名，两者同给才兼顾标准实现与 Google 系。
 * `lang="zxx"` 的语义是「无语言内容」，会把中文的发音规则与语言回退字体一并丢掉。
 */
export function NoTranslate({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div translate="no" className={cn('notranslate', className)}>
      {children}
    </div>
  )
}
