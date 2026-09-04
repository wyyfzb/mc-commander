/** 坐标输入框（实底；表单/弹窗共用） */
export function CoordField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-center text-mcs-2xs font-medium text-mcs-text-subtle">{label}</span>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="w-full rounded-mcs-xs border border-mcs-border-default bg-mcs-bg-default px-2 py-1.5 text-center font-mono text-mcs-sm text-mcs-text-default focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
      />
    </div>
  )
}
