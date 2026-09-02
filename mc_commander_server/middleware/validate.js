/**
 * zod schema 校验（@mc-commander/schemas 单源契约，验收 #262-#2）
 *
 * 请求侧：validateBody(schema) —— safeParse 失败返回 400 VALIDATION_ERROR
 *   （message 为可读聚合，details 为结构化 issue 列表），成功时把归一化
 *   结果回写 req.body（剥离未知字段，下游只见契约字段）。
 * 响应侧：validatedSuccess / validatedSuccessPaginated —— safeParse 观测
 *   漂移，漂移仅 console.error 不阻断响应（可观测优先，避免给客户端放大
 *   故障）；__tests__/schemas.contract.test.js 在 CI 实打实断言响应可 parse。
 */
import { success, successPaginated, error, ErrorCodes } from '../utils/response.js';
import { logger } from '../utils/logger.js';

/** zod issues → 结构化 details（path 折叠为点号路径，便于客户端定位） */
function formatIssues(zodError) {
  return zodError.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      return res.status(400).json(
        error(ErrorCodes.VALIDATION_ERROR, messages.join('; '), formatIssues(result.error))
      );
    }
    req.body = result.data;
    next();
  };
}

/** 成功响应 + 契约观测：信封结构与 success() 完全一致，data 漂移时打错误日志 */
export function validatedSuccess(schema, data, message = 'Success') {
  const result = schema.safeParse(data);
  if (!result.success) {
    logger.error('[contract] 响应数据与 schema 不一致:', JSON.stringify(formatIssues(result.error)));
  }
  return success(data, message);
}

/** 分页版响应 + 契约观测（逐条 parse 数组元素，精确定位漂移行） */
export function validatedSuccessPaginated(schema, data, total, page, pageSize, message = 'Success') {
  const items = Array.isArray(data) ? data : [];
  const mismatch = items
    .map((item, index) => ({ item, index, result: schema.safeParse(item) }))
    .find((entry) => !entry.result.success);
  if (mismatch) {
    logger.error(
      `[contract] 响应列表第 ${mismatch.index} 条与 schema 不一致:`,
      JSON.stringify(formatIssues(mismatch.result.error))
    );
  }
  return successPaginated(data, total, page, pageSize, message);
}
