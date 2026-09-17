/**
 * 可取消任务注册表语义（utils/cancellable-task.js）：
 * 登记 → 取消 → 中断 → 注销 的单进程生命周期，以及「无在途任务」的判定口径
 */
import { describe, it, expect } from 'vitest';
import {
  beginCancellableTask,
  cancelTask,
  TASK_KINDS,
  TaskCancelledError,
} from '../utils/cancellable-task.js';

describe('cancellable-task 注册表', () => {
  it('未登记时取消返回 false（端据此回「无可取消对象」）', () => {
    expect(cancelTask(TASK_KINDS.DEPLOY, 'vanilla-notasks')).toBe(false);
  });

  it('登记后取消返回 true，且 abort 监听被同步触发（子进程/下载流的实际中断点）', () => {
    const task = beginCancellableTask(TASK_KINDS.DEPLOY, 'vanilla-cancel1');
    let aborted = 0;
    task.signal.addEventListener('abort', () => { aborted += 1; });

    expect(cancelTask(TASK_KINDS.DEPLOY, 'vanilla-cancel1')).toBe(true);
    expect(aborted).toBe(1);
    expect(task.signal.aborted).toBe(true);
    // await 边界处据此抛出取消错误
    expect(() => task.throwIfCancelled()).toThrow(TaskCancelledError);
    task.finish();
  });

  it('未取消时 throwIfCancelled 不抛（正常路径透明）', () => {
    const task = beginCancellableTask(TASK_KINDS.DEPLOY, 'vanilla-ok1');
    expect(() => task.throwIfCancelled()).not.toThrow();
    task.finish();
  });

  it('finish 后条目消失：取消回 false（幂等，不残留）', () => {
    const task = beginCancellableTask(TASK_KINDS.DEPLOY, 'vanilla-done1');
    task.finish();
    expect(cancelTask(TASK_KINDS.DEPLOY, 'vanilla-done1')).toBe(false);
    // 重复 finish 无害
    expect(() => task.finish()).not.toThrow();
  });

  it('任务种类是键的一部分：同 scope 不同类型互不干扰', () => {
    const task = beginCancellableTask(TASK_KINDS.DEPLOY, 'shared-scope');
    expect(cancelTask('upgrade', 'shared-scope')).toBe(false);
    expect(cancelTask(TASK_KINDS.DEPLOY, 'shared-scope')).toBe(true);
    task.finish();
  });

  it('TaskCancelledError 以 cancelled 标记区分取消与失败', () => {
    const err = new TaskCancelledError();
    expect(err.cancelled).toBe(true);
    expect(err.name).toBe('TaskCancelledError');
    expect(err).toBeInstanceOf(Error);
  });
});
