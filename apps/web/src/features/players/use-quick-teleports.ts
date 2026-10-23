/**
 * 快捷传送点持久化 hook（面板偏好，跨设备一致）；
 * 新增/删除/隐藏主世界原点统一走 persistQuick：写服务端失败 toast 提示，界面保持原状。
 */
import { toast } from 'sonner'
import { quickTeleportsFromPreferences, saveQuickTeleports } from '@/lib/mc-teleport'
import { usePanelPreferencesStore } from '@/stores/panel-preferences'

/** 自定义快捷点弹窗草稿（名称 + XYZ 字符串原值，提交时校验） */
export interface CustomPointDraft {
  name: string
  x: string
  y: string
  z: string
}

export function useQuickTeleports() {
  // 快捷点由偏好快照派生：增删都按当前最新列表整份覆盖，本地不留副本
  const quickSchema = quickTeleportsFromPreferences(usePanelPreferencesStore((s) => s.remote))

  const persistQuick = (next: typeof quickSchema) => {
    void saveQuickTeleports(next).catch(() => {
      toast.error('快捷传送点保存失败')
    })
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
