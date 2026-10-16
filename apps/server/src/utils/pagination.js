// 分页查询参数解析与钳制的全仓单一实现：各端点差异用 options 表达，
// 上限只在这一处改。
// 语义约定：
// - 非法值（NaN）/ 0 / 负数 → 回落默认（0 为 falsy 走 `|| 默认`，负数走钳制下限，二者殊途同归）
// - 合法值钳制到 [1, max]；parseInt 截断小数（'3.7' → 3），不取整两次
// - parseInt 必须显式传 radix 10：无 radix 时十六进制样式串（'0x10'）会被隐式解析为 16
// - maxPage 对全部端点（含 webhooks）生效

/**
 * 解析并钳制分页查询参数
 * @param {{ page?: string, pageSize?: string }} query req.query
 * @param {{ defaultPageSize?: number, maxPage?: number, maxPageSize?: number }} options
 *   各端点按既有口径传入：tasks/backups maxPageSize 100，webhooks/audit maxPageSize 200；
 *   maxPage 全端点统一 1000，defaultPageSize 全端点统一 20
 * @returns {{ page: number, pageSize: number }}
 */
export function parsePagination(query, options = {}) {
  const { defaultPageSize = 20, maxPage = 1000, maxPageSize = 200 } = options;
  let page = parseInt(query.page, 10) || 1;
  let pageSize = parseInt(query.pageSize, 10) || defaultPageSize;
  page = Math.max(1, Math.min(page, maxPage));
  pageSize = Math.max(1, Math.min(pageSize, maxPageSize));
  return { page, pageSize };
}
