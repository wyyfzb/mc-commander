/**
 * MigrateDataSection —— 把某一类数据搬到更大的磁盘。
 *
 * 用户走到这里的唯一场景是「系统盘快满了」。搬运期间实例会被停掉、面板会暂停，
 * 失败时服务端把配置退回原目录，故本组件只负责收集「搬哪一类、搬到哪」。
 */
import { useState } from 'react'
import { HardDriveDownload } from 'lucide-react'
import { toast } from 'sonner'
import { apiMigrateData, type PanelDataItem } from '@/api/panel'
import { useConnectionStore } from '@/stores/connection'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { InfoHint } from '@/components/mcs/info-hint'

interface Props {
  items: PanelDataItem[]
  loading: boolean
}

export function MigrateDataSection({ items, loading }: Props) {
  const config = useConnectionStore()
  const [key, setKey] = useState<PanelDataItem['key']>('servers')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    const trimmed = target.trim()
    if (!trimmed.startsWith('/')) {
      setError('目标目录要写完整路径，以 / 开头，例如 /mnt/data/mc-servers')
      return
    }
    setBusy(true)
    try {
      await apiMigrateData(config, { key, target: trimmed })
      setBusy(false)
      toast.success('已开始迁移，面板会暂停', {
        description: '完成后数据在新目录；失败会自动退回原目录，不会丢存档。',
        duration: 8000,
      })
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : '迁移没能开始')
    }
  }

  const current = items.find((i) => i.key === key)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          迁移数据到其他磁盘
          <InfoHint label="为什么需要迁移">
            实例存档、数据库与备份都放在系统盘上。系统盘空间不足时，可以把它们搬到挂载好的数据盘。
          </InfoHint>
        </CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <NoticeBanner variant="warning" icon={HardDriveDownload}>
          <span className="text-mcs-sm">
            迁移会暂停面板与运行中的服务器。原目录会保留，确认无误后可自行删除。
          </span>
        </NoticeBanner>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="migrate-key">要迁移哪一类</Label>
          <Select
            value={key}
            onValueChange={(v) => setKey(v as PanelDataItem['key'])}
            disabled={loading || busy}
          >
            <SelectTrigger id="migrate-key" aria-label="要迁移哪一类">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {current && (
            <p className="text-mcs-2xs text-mcs-text-muted">
              当前位置：<code className="break-all font-mono">{current.path}</code>
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="migrate-target">搬到哪个目录</Label>
          <Input
            id="migrate-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="/mnt/data/mc-servers"
            disabled={busy}
            aria-invalid={error ? true : undefined}
          />
          <p className="text-mcs-2xs text-mcs-text-muted">
            写数据盘上的完整路径。该目录不存在时会自动创建；已存在且非空会拒绝，避免两份数据混在一起。
          </p>
        </div>

        {error && (
          <NoticeBanner variant="error">
            <span className="text-mcs-sm">{error}</span>
          </NoticeBanner>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={() => void submit()} disabled={busy || loading}>
            {busy ? '正在提交…' : '开始迁移'}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
