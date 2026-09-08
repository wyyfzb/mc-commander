/**
 * EditorSlot —— Monaco 编辑器窗格容器（自 files-page.tsx 迁出，纯移动零行为变更）
 * - desktop：桌面端内联 section（w-[45%]，path 空串兜底未选中态）
 * - fullscreen：移动端全屏覆盖层（fixed inset-0，仅选中文件时由父组件条件渲染）
 * - isLoading 差异：desktop 附加 selectedPath!==null 条件（未选中不显示加载骨架），
 *   fullscreen 只在选中时渲染故直接透传（与原实现一致）
 * - encoding/loadError 由 contentQuery 派生（派生规则与原实现逐字一致）
 */
import { getFriendlyErrorText } from '@/api/errors'
import type { ThemeMode } from '@/stores/ui'
import { MonacoEditorPane } from './monaco-editor-pane'
import { useFileContent } from '../queries'

interface EditorSlotProps {
  variant: 'desktop' | 'fullscreen'
  /** 当前选中文件路径（desktop 未选中时渲染空态） */
  selectedPath: string | null
  /** 内容查询结果（派生 encoding/isLoading/loadError） */
  contentQuery: ReturnType<typeof useFileContent>
  /** 编辑器草稿（组件 state，与 query 缓存隔离） */
  draft: string
  /** 编辑器主题（跟随全局 UI 主题） */
  theme: ThemeMode
  isSaving: boolean
  dirty: boolean
  onChange: (v: string) => void
  onSave: () => void
  onRestore: () => void
  onClose: () => void
  onRetry: () => void
}

export function EditorSlot({
  variant,
  selectedPath,
  contentQuery,
  draft,
  theme,
  isSaving,
  dirty,
  onChange,
  onSave,
  onRestore,
  onClose,
  onRetry,
}: EditorSlotProps) {
  const loadError = contentQuery.isError
    ? `文件加载失败：${getFriendlyErrorText(contentQuery.error)}`
    : null
  const editor = (
    <MonacoEditorPane
      path={selectedPath ?? ''}
      content={draft}
      encoding={contentQuery.data?.encoding ?? 'utf-8'}
      theme={theme}
      isLoading={variant === 'desktop' ? contentQuery.isLoading && selectedPath !== null : contentQuery.isLoading}
      loadError={loadError}
      isSaving={isSaving}
      dirty={dirty}
      onChange={onChange}
      onSave={onSave}
      onRestore={onRestore}
      onClose={onClose}
      onRetry={onRetry}
    />
  )
  if (variant === 'desktop') {
    return (
      <section className="flex h-full min-h-0 w-[45%] shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted shadow-mcs-card">
        {editor}
      </section>
    )
  }
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-mcs-bg-muted">
      {editor}
    </div>
  )
}
