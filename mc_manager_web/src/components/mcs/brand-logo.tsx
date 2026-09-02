import { cn } from '@/lib/utils'

/**
 * BrandLogo —— 品牌图标（设计文档 §3.1 品牌触点）
 * 极简终端提示符标记：圆角窗 + 命令符 + 光标条，呼应产品「服务器命令中枢」定位。
 * 窗体描边跟随文本色（currentColor），命令符/光标用品牌 accent（--mcs-* token，
 * 经 Tailwind 语义类注入），亮暗主题自动适配。favicon/PWA 图标为同构静态版。
 */
export function BrandLogo({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      fill="none"
    >
      {/* 终端窗体：圆角方框，描边随文本色 */}
      <rect
        x="2.75"
        y="2.75"
        width="18.5"
        height="18.5"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {/* 命令符 ">" + 光标条：品牌 accent 色 */}
      <g className="text-mcs-accent-fg" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.5 8.75 11 12l-3.5 3.25" strokeWidth="2" />
        <path d="M13.5 15.25h3.25" strokeWidth="2" />
      </g>
    </svg>
  )
}
