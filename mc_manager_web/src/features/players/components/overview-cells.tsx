/**
 * OverviewTab 概览展示原子件
 * 自 detail-overview-tab.tsx 纯搬移（issue 489 治理线延续）：Section/InfoCell/StatCell 单一职责收口
 */
import type { ReactNode } from 'react'

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-mcs-xs font-medium text-mcs-text-muted">{title}</h4>
      {children}
    </div>
  )
}

export function InfoCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-mcs-2xs text-mcs-text-muted">{label}</span>
      <span className={mono ? 'font-mono text-mcs-xs text-mcs-text-default' : 'text-mcs-xs text-mcs-text-default'}>
        {value}
      </span>
    </div>
  )
}

export function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-mcs-xs bg-mcs-bg-muted px-2 py-1.5">
      <span className="text-mcs-2xs text-mcs-text-muted">{label}</span>
      <span className="mcs-num text-mcs-sm leading-none font-medium text-mcs-text-default">{value}</span>
    </div>
  )
}
