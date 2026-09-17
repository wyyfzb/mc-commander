/**
 * 实例展示名：名称为空或纯空白时回退到 id。
 *
 * 写入侧契约全是 `trim().min(1)`（`mc-schemas` 的实例与部署表单、服务端卸载确认同口径），
 * 空名在当前代码里不可产生——这层回退是**展示兜底**：历史上出现过空名实例，而渲染成
 * 「」的确认弹窗、开关标题或 toast 既看不懂，也没法照着复核到底动了哪个实例。
 *
 * 只用于展示。**卸载确认块是例外**——那里的标签与 placeholder 必须显示与比对（及服务端
 * `routes/status.js` 比 trim 后的 name）逐字一致的原值：换成展示名会让用户照着输入一个
 * 服务端不认的字符串。
 */
export function instanceLabel(instance: { id: string; name?: string | null }): string {
  const name = instance.name?.trim()
  return name ? name : instance.id
}
