// 分页查询参数解析与钳制的全仓单一实现。
// 收敛前 4 个路由 7 处端点各自手写，风格分裂三种（parseInt radix 有无、page/pageSize 上限口径不一），
// 改一处上限需逐点核对，故收口本 util 并以参数表达各端点差异。
// 语义约定（与既有行为对齐，差异见下）：
// - 非法值（NaN）/ 0 / 负数 → 回落默认（0 为 falsy 走 `|| 默认`，负数走钳制下限，二者殊途同归）
// - 合法值钳制到 [1, max]；parseInt 截断小数（'3.7' → 3），不取整两次
// - parseInt 统一显式 radix 10：十六进制样式串（'0x10'）不再被无 radix 端点隐式解析为 16，
//   统一回落默认值——属既有 radix 分裂的收敛，合法十进制输入行为不变
// - webhooks 端点此前 page 无上限（与其余端点 1000 不一致），统一收敛到 maxPage

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
