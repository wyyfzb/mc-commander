/**
 * asyncHandler —— async 路由包装（共享实现）
 *
 * 使用场景：本仓库当前依赖 Express 5（^5.2.1），框架已原生把 async 处理器
 * reject 的 Promise 转交错误中间件，本包装因此不承担版本兼容职责；保留意义
 * 在于显式兜底与统一错误通道约定——调用点不依赖框架版本的隐式行为，且若
 * 降级到 Express 4 依旧正确（Express 4 不会捕获路由返回的 Promise
 * rejection，请求将永久挂起，且 Node 15+ 默认因 unhandledRejection 终止
 * 进程）。
 *
 * 约定：仅包装 async 处理器；同步路由用原生 try/catch 风格即可。
 * 注意：包装的是「意外异常」的兜底通道，处理器内部对可预期失败
 * （RCON/文件缺失等）仍应自行捕获降级，避免把正常业务分支推给 500。
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} fn
 *   async 路由处理器
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction)}
 *   rejection 透传到错误中间件的同步包装
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
