# 前端设计审查指南

本文档记录前端代码审查中的设计规范守门规则，供 Agent 交叉审查与 PR review 使用。

## CTA 配额

每页最多 **1 个绿色实底 CTA 按钮** + **outline 变体 ≤ 2 个**。

- 绿色实底 CTA（`variant="default"` 的 Button）用于页面唯一主操作，如「保存」「提交」。
- outline 按钮（`variant="outline"`）用于次操作，同一页面不超过 2 个排布。
- 筛选开关 / 分段控件的**选中态**用 `variant="selected"`（淡底 + 强档描边 + accent 文字，
  与 `Chip` 选中态同口径），不计入 CTA 配额；禁止用 `variant="default"` 表示选中——
  实底渐变 + 辉光会让一屏出现多个发光绿按钮，主操作失去唯一性。
- `variant="destructive"` 不计入 CTA 配额（危险操作独立分级）。
- `variant="ghost"` / `variant="link"` 不计入配额。

## 圆角守门规则

业务代码**禁止**使用 `rounded-[...]` 任意值，必须使用设计 token（`rounded-lg`、`rounded-md` 等）或 `--mcs-radius-*` 变量。

### 豁免清单（shadcn/ui 基础组件）

以下 `rounded-[...]` 用法属于组件级派生，已在各组件文件头部注释标注豁免理由：

| 组件 | 模式 | 豁免理由 |
|------|------|----------|
| `scroll-area.tsx` | `rounded-[inherit]` | Viewport 继承父容器圆角，无法用 token 表达 |
| `input-group.tsx` | `rounded-[calc(var(--radius)-Npx)]` | 内嵌按钮/键盘需比容器圆角小 Npx 视觉内嵌 |

注：checkbox（`rounded-mcs-xs`）与 tooltip 箭头（`rounded-xs`）已改用 token/内置档，不再需要豁免。

审查新 PR 时，`components/ui/` 下新增的 `rounded-[...]` 需确认属于上述派生模式或补充豁免理由；`features/` 下任何 `rounded-[...]` 均应驳回。
