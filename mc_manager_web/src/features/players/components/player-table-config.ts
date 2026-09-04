/**
 * PlayerTable 共享配置 —— v9 features 模块级静态定义（官方建议）+ 表格常量
 * （自 player-table.tsx 拆出，纯搬移零行为变更；主表格 / 列定义 / 行组件共用）
 */
import {
  columnSizingFeature,
  columnVisibilityFeature,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
} from '@tanstack/react-table'

// v9 features 需模块级静态定义（官方建议）：排序 + 列尺寸（getSize）/列可见（getVisibleCells）
// sortedRowModel 必须注册（issue 472 / PR 473 沉淀）：v9 未注册 sorted row-model
// factory 时 getRowModel() 返回预排序模型——点击表头仅 sorting state 与箭头变化，
// 行序不应用。alphanumeric 为官方示例注册项（字符串列 auto sortFn 命中最常见场景）
export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
  columnSizingFeature,
  columnVisibilityFeature,
})

export const PAGE_SIZE_OPTIONS = [10, 20, 50, -1] as const // -1 = 全部
export const ROW_HEIGHT = 40 // 对齐设计文档 §4.3 default 档密度

export const GAME_MODE_LABELS: Record<string, string> = {
  survival: '生存',
  creative: '创造',
  adventure: '冒险',
  spectator: '旁观',
}

export const DIMENSION_META = {
  overworld: { label: '主世界', token: '--mcs-dimension-overworld' },
  nether: { label: '下界', token: '--mcs-dimension-nether' },
  end: { label: '末地', token: '--mcs-dimension-end' },
} as const
