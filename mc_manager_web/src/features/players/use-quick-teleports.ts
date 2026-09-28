/**
 * 快捷传送点持久化 hook（localStorage）：损坏回退默认 schema；
 * 新增/删除/隐藏主世界原点统一走 persistQuick，写库失败 toast 降级不中断交互。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { loadQuickTeleports, saveQuickTeleports, type QuickTeleportSchema } from '@/lib/mc-teleport'

/** 自定义快捷点弹窗草稿（名称 + XYZ 字符串原值，提交时校验） */
export interface CustomPointDraft {
  name: string
  x: string
  y: string
  z: string
}

export function useQuickTeleports() {
  const [quickSchema, setQuickSchema] = useState<QuickTeleportSchema>(() =>
    loadQuickTeleports(window.localStorage),
  )

  const persistQuick = (next: QuickTeleportSchema) => {
    setQuickSchema(next)
    try {
      saveQuickTeleports(window.localStorage, next)
    } catch {
      toast.error('快捷传送点保存失败')
    }
  }

  /** 校验并添加自定义点：失败 toast 返回 false；成功持久化 + toast 返回 true（调用方据此关闭弹窗） */
  const addCustom = (draft: CustomPointDraft): boolean => {
    const name = draft.name.trim()
    if (name.length === 0) {
      toast.error('请输入名称')
      return false
    }
    const x = Number.parseFloat(draft.x)
    const y = Number.parseFloat(draft.y)
    const z = Number.parseFloat(draft.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      toast.error('请输入有效的坐标数值')
      return false
    }
    persistQuick({ ...quickSchema, items: [...quickSchema.items, { name, x, y, z }] })
    toast.success(`已添加快捷传送点「${name}」`)
    return true
  }

  const removeCustom = (name: string) => {
    persistQuick({ ...quickSchema, items: quickSchema.items.filter((p) => p.name !== name) })
  }

  const hideOrigin = () => {
    persistQuick({ ...quickSchema, hideOrigin: true })
  }

  return { quickSchema, addCustom, removeCustom, hideOrigin }
}
