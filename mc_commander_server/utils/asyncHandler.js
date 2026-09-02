/**
 * asyncHandler —— Express 4 异步路由包装（共享实现）
 *
 * 使用场景：Express 4 不支持 async 路由处理器的自动错误传递——处理器内
 * 抛出或 reject 的 Promise 不会被路由栈捕获，请求将永久挂起，且 Node 15+
 * 默认因 unhandledRejection 终止进程。本包装将 Promise rejection 转交
 * next(err)，由下游错误中间件统一响应。
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
