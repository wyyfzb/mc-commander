/**
 * 可取消长任务注册表（取消能力的单一事实源）。
 *
 * 长任务（当前：部署；升级/备份/恢复接入时同样经此登记）在执行期把自身登记进来，
 * 取消端点据注册表定位在途任务并中断它。取消的实现口径是**打断被 await 的步骤**：
 * 以 TaskCancelledError 让当前 step 失败，收尾交给该任务**既有的**失败清理/回滚
 * 路径——不另写一套「取消清理」，否则两条路径必然分叉，且取消恰好落在两步之间
 * （无在途 IO 可中断）时没有任何监听者会触发。
 *
 * 由此推出两条使用约束：
 * 1. 每个 await 边界之后都要 throwIfCancelled()：取消可能落在两步之间，只靠
 *    IO 层的 abort 监听会漏掉这种时序；
 * 2. 任务无论成功、失败还是被取消都必须在 finally 里 finish()——注册表条目的
 *    生命周期就是任务的执行期，残留条目会让取消端点对着已结束的任务回「已取消」，
 *    而客户端会永远等不到终态事件。
 *
 * 注册表是内存态（与 activeDeploys / activeUpgrades 的快照同口径）：进程重启后
 * 不存在可取消的在途任务，此时取消端点回「无在途任务」而不是静默成功。
 *
 * 与 utils/deploy-inflight.js 的分工：那边判的是「进度可见性」（含死快照时限，
 * 超时即视为进程崩溃遗留、不再对外报告在途），这边判的是「可取消性」（以真实
 * 执行体的存在为准，不做时限推断）。两者不可互相替代。
 */

/** 取消类失败：catch 处据 cancelled 区分「用户取消」与「执行失败」（清理回声与文案都不同） */
export class TaskCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'TaskCancelledError';
    this.cancelled = true;
  }
}

/** 任务种类（注册点与取消端点共用，避免字符串两处各写一遍） */
export const TASK_KINDS = {
  DEPLOY: 'deploy',
};

/** `${kind}:${scope}` → 条目；scope 为实例 id（部署实例在入库前就已有 id） */
const tasks = new Map();

/**
 * 登记一个可取消任务。
 * @param {string} kind TASK_KINDS 之一
 * @param {string} scope 任务归属（实例 id）
 */
export function beginCancellableTask(kind, scope) {
  const key = `${kind}:${scope}`;
  const controller = new AbortController();
  const entry = { kind, scope, controller, startedAt: Date.now() };
  tasks.set(key, entry);
  const { signal } = controller;

  return {
    signal,
    /** 取消判据（await 边界处调用；见文件头约束 1） */
    throwIfCancelled() {
      if (signal.aborted) throw new TaskCancelledError();
    },
    /** 任务结束（见文件头约束 2）；重复调用无害 */
    finish() {
      if (tasks.get(key) === entry) tasks.delete(key);
    },
  };
}

/**
 * 请求取消在途任务：同步触发该任务的 abort 监听（终止子进程/断流），
 * 任务的实际收尾（清理磁盘、发终态事件）由它自己的失败路径继续完成——
 * 端点不等待终态，调用方据终态事件判定结果。
 * @returns {boolean} 是否确有在途任务（false = 无可取消的任务）
 */
export function cancelTask(kind, scope) {
  const entry = tasks.get(`${kind}:${scope}`);
  if (!entry) return false;
  entry.controller.abort(new TaskCancelledError());
  return true;
}
