/**
 * 坐标传送表单：X/Y/Z 受控输入 + 传送按钮；非法值拦截在上层（parseCoords 失败 toast）。
 */
import { Navigation } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CoordField } from './coord-field'
import { Section } from './section'

export interface CoordTeleportFormProps {
  coords: { x: string; y: string; z: string }
  onCoordChange: (axis: 'x' | 'y' | 'z', value: string) => void
  onTeleport: () => void
  running: boolean
}

export function CoordTeleportForm({
  coords,
  onCoordChange,
  onTeleport,
  running,
}: CoordTeleportFormProps) {
  return (
    <Section title="坐标传送">
      {/* 输入控件是 inset 填充面：宿主须是浮起面。玩家详情面板本身是画布，先用 muted 嵌块
          把三个坐标框托起来，否则填充对画布只有 1.03:1，输入框只剩一条描边。 */}
      <div className="flex items-end gap-2 rounded-mcs-md border border-mcs-border-container bg-mcs-bg-muted p-3">
        <div className="grid flex-1 grid-cols-3 gap-2">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <CoordField
              key={axis}
              label={axis.toUpperCase()}
              value={coords[axis]}
              onChange={(v) => onCoordChange(axis, v)}
            />
          ))}
        </div>
        <Button variant="default" className="shrink-0" onClick={onTeleport} disabled={running}>
          <Navigation aria-hidden />
          传送
        </Button>
      </div>
    </Section>
  )
}
