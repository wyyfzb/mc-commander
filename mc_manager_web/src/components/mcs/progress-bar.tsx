/**
 * ProgressBar —— 确定性进度条（token 填充，与 deploy/upgrade 同模式提取共享）。
 * 只承载「百分比已知的确定进度」：进行中但无百分比（robocopy/ditto 等无
 * stdout 进度的路径）由调用点用转圈指示，不放一个恒空的条。
 */
export function ProgressBar({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(p)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-mcs-bg-emphasis"
    >
      <div className="h-full rounded-full" style={{ width: `${p}%`, background: 'var(--mcs-accent)' }} />
    </div>
  )
}
