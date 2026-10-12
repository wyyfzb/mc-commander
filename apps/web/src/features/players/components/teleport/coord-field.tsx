import { Input } from '@/components/ui/input'

/** 坐标输入框（随 ui/input 基座；表单/弹窗共用） */
export function CoordField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-center text-mcs-2xs font-medium text-mcs-text-muted">{label}</span>
      <Input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="text-center font-mono"
      />
    </div>
  )
}
