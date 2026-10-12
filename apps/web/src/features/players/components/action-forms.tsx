/**
 * ActionForms - 玩家操作表单 Tab 壳（经验/效果/召唤），与 GiveItemPanel/TeleportTab 同构模式
 *
 * 表单实现拆分于 forms/ 子目录（issue 480 治理线拆分）：
 * 1. forms/experience-form.tsx - ExperienceForm（/xp 命令）
 * 2. forms/effect-form.tsx - EffectForm（/effect give|clear 命令）
 * 3. forms/summon-form.tsx - SummonForm（/summon 命令）
 * 4. forms/offline-banner.tsx - OfflineBanner（RCON 断连横幅，三表单共用）
 *
 * 执行走 onAction({kind:'command', command})；批量用 runBatchForTargets + formatBatchSummary toast。
 * 设计纪律：全部 --mcs-* token
 */
import { Sparkles, Star, Zap } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EffectForm } from './forms/effect-form'
import { ExperienceForm } from './forms/experience-form'
import { SummonForm } from './forms/summon-form'
import type { ActionFormProps } from './forms/types'

// ── 导出（Tab 壳）──

export function ActionForms(props: ActionFormProps) {
  return (
    <Tabs defaultValue="experience" className="space-y-3">
      <TabsList className="h-8 w-full justify-start gap-0 rounded-mcs-sm bg-mcs-bg-muted p-0.5">
        <TabsTrigger value="experience" className="h-7 gap-1 rounded-mcs-xs px-2.5 text-mcs-xs">
          <Star className="size-3" />
          经验
        </TabsTrigger>
        <TabsTrigger value="effect" className="h-7 gap-1 rounded-mcs-xs px-2.5 text-mcs-xs">
          <Sparkles className="size-3" />
          效果
        </TabsTrigger>
        <TabsTrigger value="summon" className="h-7 gap-1 rounded-mcs-xs px-2.5 text-mcs-xs">
          <Zap className="size-3" />
          召唤
        </TabsTrigger>
      </TabsList>

      <TabsContent value="experience">
        <ExperienceForm {...props} />
      </TabsContent>
      <TabsContent value="effect">
        <EffectForm {...props} />
      </TabsContent>
      <TabsContent value="summon">
        <SummonForm {...props} />
      </TabsContent>
    </Tabs>
  )
}
