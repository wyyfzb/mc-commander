import { ErrorCodes, error, AppError } from '../utils/response.js';
import { logger } from '../utils/logger.js';

export function errorHandler(err, req, res, _next) {
  logger.error('Error:', err);

  if (err instanceof AppError) {
    return res.status(err.status).json(error(
      { code: err.code, message: err.message, status: err.status },
      err.message,
      err.details
    ));
  }

  if (err instanceof SyntaxError || err.type === 'entity.parse.failed') {
    return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'));
  }

  // body 超限（P2-7：认证前 1MB 收口）返回明确 413 语义，不再落 500
  if (err.type === 'entity.too.large') {
    return res.status(413).json(error(ErrorCodes.VALIDATION_ERROR, 'Request body too large'));
  }

  // 500 一律返回通用文案，不回传 err.message：fs/spawn 等底层错误可能
  // 携带服务器绝对路径等敏感信息。详细错误已由上方 console.error 记录日志；
  // 仅 development 环境用 X-Debug-Error 响应头携带详情辅助排查
  // （清洗换行防 HTTP 头注入、截断防超长），生产环境不设该头。
  const debugMessage = String(err.message || '').replace(/[\r\n]+/g, ' ').slice(0, 1000);
  res.status(500);
  if (process.env.NODE_ENV === 'development') {
    res.set('X-Debug-Error', debugMessage);
  }
  return res.json(error(ErrorCodes.SERVER_ERROR, 'Internal Server Error'));
}

export function notFoundHandler(req, res) {
  res.status(404).json(error(
    ErrorCodes.NOT_FOUND,
    `Route ${req.method} ${req.path} not found`
  ));
}

export default { errorHandler, notFoundHandler };
