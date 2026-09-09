/**
 * 部署向导三步 Stepper：圆点序号 + 标签 + 连接线（token 纪律，禁硬编码）
 * 从 deploy-dialog.tsx 行为不变迁移
 */
import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STEP_LABELS } from './constants'

export function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label="部署步骤">
      {STEP_LABELS.map((label, i) => (
        <Fragment key={label}>
          {i > 0 && (
            <div
              aria-hidden
              className={cn(
                'h-px flex-1 rounded-full',
                i <= step ? 'bg-mcs-accent' : 'bg-mcs-border-muted',
              )}
            />
          )}
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden={i < step}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border text-mcs-xs transition-colors',
                i < step
                  ? 'border-mcs-accent-border-strong bg-mcs-accent text-mcs-on-accent'
                  : i === step
                    ? 'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle text-mcs-accent-fg'
                    : 'border-mcs-border-default text-mcs-text-muted',
              )}
            >
              {i < step ? <Check className="size-3" aria-hidden /> : i + 1}
            </span>
            <span
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'text-mcs-sm whitespace-nowrap',
                i === step ? 'text-mcs-text-default' : 'text-mcs-text-muted',
              )}
            >
              {label}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  )
}
