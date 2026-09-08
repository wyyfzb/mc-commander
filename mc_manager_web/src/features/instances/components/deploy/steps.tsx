/**
 * DeployDialog 三步表单面板（从 deploy-dialog.tsx 行为不变迁移）
 * - 步骤① 服务端类型 5 卡单选 + 版本 Select + fabric/forge loader Select
 * - 步骤② 实例名称 Input + 内存 Select 档位
 * - 步骤③ 确认摘要 + EULA 同意勾选
 * 纯展示组件：表单状态与派生逻辑留在编排层（deploy-dialog.tsx），经 props 回调上行
 */
import { Info } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { SERVER_TYPES, SERVER_TYPE_LABELS, recommendedJavaVersion, type ServerType } from '@/lib/mc-deploy'
import { SERVER_TYPE_DESCRIPTIONS, SERVER_TYPE_ICONS, MEMORY_OPTIONS } from './constants'
import type { DeployForm } from './types'
import { memoryToGB } from './utils'

interface DeployStepServerProps {
  form: DeployForm
  versions: string[]
  versionsLoading: boolean
  versionsError: boolean
  loaders: string[]
  onTypeChange: (type: ServerType) => void
  onVersionChange: (version: string) => void
  onLoaderChange: (loader: string) => void
}

/** 步骤① 服务端类型 + 版本 + 加载器 */
export function DeployStepServer({
  form,
  versions,
  versionsLoading,
  versionsError,
  loaders,
  onTypeChange,
  onVersionChange,
  onLoaderChange,
}: DeployStepServerProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* 服务端类型 5 卡单选 */}
      <div className="flex flex-col gap-2">
        <Label>服务端类型</Label>
        <RadioGroup
          value={form.type}
          onValueChange={(v) => onTypeChange(v as ServerType)}
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {SERVER_TYPES.map((type) => {
            const selected = form.type === type
            const Icon = SERVER_TYPE_ICONS[type]
            return (
              <label
                key={type}
                className={cn(
                  'flex cursor-pointer flex-col gap-0.5 rounded-mcs-sm border px-2.5 py-2 transition-colors',
                  selected
                    ? 'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle text-mcs-text-default'
                    : 'border-mcs-border-default text-mcs-text-muted hover:bg-mcs-bg-hover',
                )}
              >
                <RadioGroupItem value={type} className="sr-only" />
                <span className="flex items-center gap-1.5 text-mcs-sm">
                  <Icon
                    className={cn(
                      'size-3.5 shrink-0',
                      selected ? 'text-mcs-accent-fg' : 'text-mcs-text-subtle',
                    )}
                    aria-hidden
                  />
                  {SERVER_TYPE_LABELS[type]}
                </span>
                <span className="text-mcs-xs text-mcs-text-subtle">
                  {SERVER_TYPE_DESCRIPTIONS[type]}
                </span>
              </label>
            )
          })}
        </RadioGroup>
      </div>

      {/* 版本下拉（版本列表就绪后自动回填首个） */}
      <div className="flex flex-col gap-2">
        <Label>Minecraft 版本</Label>
        <Select
          value={form.version}
          onValueChange={onVersionChange}
          disabled={versions.length === 0}
        >
          <SelectTrigger className="w-full" aria-label="选择 Minecraft 版本">
            <SelectValue
              placeholder={
                versionsLoading
                  ? '版本列表加载中…'
                  : versions.length === 0
                    ? '未获取到版本列表'
                    : '请选择版本'
              }
            />
          </SelectTrigger>
          <SelectContent>
            {versions.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {versionsError && (
          <p className="text-mcs-xs text-mcs-warning-fg">
            无法获取远程版本列表，使用本地缓存
          </p>
        )}
        {form.version !== '' && (
          <div className="flex items-center gap-1.5 rounded-mcs-sm border border-mcs-info-border bg-mcs-info-bg-subtle px-2.5 py-1.5 text-mcs-xs text-mcs-info-fg">
            <Info className="size-3.5 shrink-0" aria-hidden />
            推荐 Java 版本：{recommendedJavaVersion(form.version)}（服务端会自动检测并使用合适的 Java 版本）
          </div>
        )}
      </div>

      {/* fabric/forge 加载器下拉（versions 响应带 loaders 时显示） */}
      {loaders.length > 0 && (form.type === 'fabric' || form.type === 'forge') && (
        <div className="flex flex-col gap-2">
          <Label>加载器版本</Label>
          <Select value={form.loader} onValueChange={onLoaderChange}>
            <SelectTrigger className="w-full" aria-label="选择加载器版本">
              <SelectValue placeholder="请选择加载器版本" />
            </SelectTrigger>
            <SelectContent>
              {loaders.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}

interface DeployStepConfigProps {
  form: DeployForm
  totalMemory: number
  nameError: string
  onNameChange: (name: string) => void
  onMemoryChange: (memory: string) => void
}

/** 步骤② 实例名称 + 内存档位 */
export function DeployStepConfig({
  form,
  totalMemory,
  nameError,
  onNameChange,
  onMemoryChange,
}: DeployStepConfigProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* 实例名称 */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="deploy-instance-name">实例名称</Label>
        <Input
          id="deploy-instance-name"
          value={form.name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="例如: 我的生存服"
          maxLength={50}
        />
        {nameError !== '' && (
          <p className="text-mcs-xs text-mcs-error-fg">{nameError}</p>
        )}
      </div>

      {/* 内存档位 */}
      <div className="flex flex-col gap-2">
        <Label>内存分配</Label>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-mcs-2xl font-bold text-mcs-accent-fg">
            {memoryToGB(form.memory).toFixed(1)} GB
          </span>
          <span className="text-mcs-sm text-mcs-text-subtle">
            / {totalMemory.toFixed(1)} GB
          </span>
        </div>
        <Select value={form.memory} onValueChange={onMemoryChange}>
          <SelectTrigger className="w-full" aria-label="选择内存分配">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEMORY_OPTIONS.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-mcs-xs text-mcs-text-subtle">
          选择 Minecraft 服务器可用的最大内存
        </p>
        {/* 推荐提示（<=8G 推荐 50%，>8G 推荐 70%） */}
        <p className="flex items-center gap-1.5 text-mcs-xs text-mcs-warning-fg">
          <Info className="size-3.5 shrink-0" aria-hidden />
          {totalMemory <= 8
            ? `推荐分配 ${(totalMemory * 0.5).toFixed(1)} GB（系统保留 ${(totalMemory - totalMemory * 0.5).toFixed(1)} GB）`
            : `推荐分配 ${(totalMemory * 0.7).toFixed(1)} GB（系统保留 ${(totalMemory - totalMemory * 0.7).toFixed(1)} GB）`}
        </p>
      </div>
    </div>
  )
}

interface DeployStepConfirmProps {
  form: DeployForm
  loaders: string[]
  eulaAgreed: boolean
  onEulaAgreedChange: (agreed: boolean) => void
}

/** 步骤③ 确认摘要 + EULA 同意（首启闭环：同意后部署完成自动启动；默认不勾） */
export function DeployStepConfirm({
  form,
  loaders,
  eulaAgreed,
  onEulaAgreedChange,
}: DeployStepConfirmProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted py-1">
        {(
          [
            ['服务端类型', SERVER_TYPE_LABELS[form.type]],
            ['版本', form.version],
            ...(loaders.length > 0 && (form.type === 'fabric' || form.type === 'forge') && form.loader !== ''
              ? [['加载器', form.loader] as const]
              : []),
            ['实例名称', form.name.trim()],
            ['内存', form.memory],
            ['推荐 Java', recommendedJavaVersion(form.version)],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 px-3 py-1.5 text-mcs-sm"
          >
            <span className="shrink-0 text-mcs-text-subtle">{label}</span>
            <span className="min-w-0 truncate font-mono text-mcs-text-default">
              {value}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="deploy-eula-agree" className="flex cursor-pointer items-start gap-2 text-mcs-sm text-mcs-text-default">
          <Checkbox
            id="deploy-eula-agree"
            checked={eulaAgreed}
            onCheckedChange={(v) => onEulaAgreedChange(v === true)}
            className="mt-0.5"
          />
          <span>我已阅读并同意 Minecraft EULA（Mojang 最终用户许可协议）</span>
        </label>
        <p className="pl-6 text-mcs-xs text-mcs-text-subtle">
          同意后将写入 eula.txt（eula=true），部署完成后自动启动服务器。
        </p>
        {!eulaAgreed && (
          <p className="flex items-center gap-1.5 pl-6 text-mcs-xs text-mcs-warning-fg">
            <Info className="size-3.5 shrink-0" aria-hidden />
            请先同意 EULA：未同意时无法启动服务器
          </p>
        )}
      </div>
    </div>
  )
}
