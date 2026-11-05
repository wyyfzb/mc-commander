/**
 * zod schema 校验（@mc-commander/schemas 单源契约）
 *
 * 请求侧：validateBody(schema) —— safeParse 失败返回 400 VALIDATION_ERROR
 *   （message 为可读聚合，details 为结构化 issue 列表），成功时把归一化
 *   结果回写 req.body（剥离未知字段，下游只见契约字段）。
 * 响应侧：validatedSuccess / validatedSuccessPaginated —— safeParse 观测
 *   漂移，漂移仅 console.error 不阻断响应（可观测优先，避免给客户端放大
 *   故障）；CI 有用例实打实断言响应可 parse。
 */
import { success, successPaginated, error, ErrorCodes } from '../utils/response.js';
import { logger } from '../utils/logger.js';
import { logContractAlarm } from '../utils/contract-alarm.js';

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
      return res
        .status(400)
        .json(error(ErrorCodes.VALIDATION_ERROR, messages.join('; '), formatIssues(result.error)));
    }
    req.body = result.data;
    next();
  };
}

/**
 * 请求查询参数校验：与 validateBody 同一契约（400 VALIDATION_ERROR
 * + 结构化 details），成功时把归一化结果回写 req.query（剥离未知字段，
 * 分页参数在 schema 内作字符串透传，交由 parsePagination 解析）。
 *
 * Express 5 中 req.query 定义在 Request 原型上（defineGetter，只读），
 * 直接赋值在 ESM 严格模式下抛 TypeError，因此用实例级 own property
 * 覆盖（defineProperty 合法且对下游 handler 完全透明）。
 *
 * options.onError(req)：校验失败时在 400 响应前调用的清理钩子。上传路由
 * （multer diskStorage）文件已落盘，校验失败必须清理临时文件防止磁盘残留
 * （原 handler 内 unlinkSync 清理语义由钩子承接，安全性只增不减）。
 */
export function validateQuery(schema, options = {}) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      if (typeof options.onError === 'function') {
        try {
          options.onError(req);
        } catch (cleanupErr) {
          logger.error('[validate] 查询校验失败清理钩子异常:', cleanupErr);
        }
      }
      const messages = result.error.issues.map((i) => i.message);
      return res
        .status(400)
        .json(error(ErrorCodes.VALIDATION_ERROR, messages.join('; '), formatIssues(result.error)));
    }
    Object.defineProperty(req, 'query', {
      value: result.data,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    next();
  };
}

// 端点漂移按 scope='rest' 汇总；WS 载荷校验用同一条聚合，两侧不会各刷各的日志
/** 成功响应 + 契约观测：信封结构与 success() 完全一致，data 漂移时打错误日志 */
export function validatedSuccess(schema, data, message = 'Success') {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = formatIssues(result.error);
    logContractAlarm('rest', issues);
  }
  return success(data, message);
}

/** 分页版响应 + 契约观测（逐条 parse 数组元素，精确定位漂移行） */
export function validatedSuccessPaginated(
  schema,
  data,
  total,
  page,
  pageSize,
  message = 'Success',
) {
  const items = Array.isArray(data) ? data : [];
  const mismatch = items
    .map((item, index) => ({ item, index, result: schema.safeParse(item) }))
    .find((entry) => !entry.result.success);
  if (mismatch) {
    const issues = formatIssues(mismatch.result.error);
    logContractAlarm('rest', issues);
  }
  return successPaginated(data, total, page, pageSize, message);
}
