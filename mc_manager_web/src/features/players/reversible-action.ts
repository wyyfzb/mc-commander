/**
 * 可逆操作统一口径——玩家域三处入口（详情面板 / 行内菜单 / 批量条）共用
 * - 可逆操作（OP·白名单切换、游戏模式）：逆操作语义可表达 → 直接执行 + 5s 撤销 Toast，不设确认弹窗
 * - 不可逆操作（清空背包一类）：走后果清单确认（ConfirmDialog），不经本模块
 * - 无逆操作的轻伤害操作（踢出）：只直执 + 普通回执——挂一个做不到的「撤销」比没有入口更坏
 * 撤销窗口即 Toast 存活期：窗口过后入口消失，操作即成事实
 */
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'

/** 撤销窗口 = Toast 存活期（窗口过后入口消失，操作即成事实） */
export const UNDO_WINDOW_MS = 5000

export interface UndoToastOptions {
  /** 执行结果回执正文（批量时为汇总文案） */
  text: string
  /** 撤销完成回执 */
  undoText: string
  /** 逆操作；抛错由本函数统一回执 */
  undo: () => Promise<void>
  /** 部分失败说明（批量汇总的失败明细） */
  description?: string
  /** 有失败时用 warning 承载汇总（与批量既有口径一致） */
  variant?: 'success' | 'warning'
}

/** 可逆操作回执：成功 Toast 挂撤销动作；撤销自身失败单独回执（不静默） */
export function toastWithUndo({ text, undoText, undo, description, variant = 'success' }: UndoToastOptions): void {
  const action = {
    label: '撤销',
    onClick: () => {
      void undo()
        .then(() => toast.success(undoText))
        .catch((e) => toast.error(`撤销失败：${getFriendlyErrorText(e)}`))
    },
  }
  // description 两个分支都要带：它不只承载失败明细，也承载「撤销覆盖面」这类成功态说明
  // （此前只在 warning 分支传，成功态的非空说明会被静默吞掉）。空串按缺省处理——sonner
  // 仅在 description 为真值时才渲染该节点。
  const options = { duration: UNDO_WINDOW_MS, action, description: description || undefined }
  if (variant === 'warning') toast.warning(text, options)
  else toast.success(text, options)
}
