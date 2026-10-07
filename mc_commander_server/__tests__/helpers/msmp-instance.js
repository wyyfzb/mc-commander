/**
 * 把方法面挂到桩实例上（生产里这些方法挂在 `MCServerInstance.prototype`）。
 *
 * 默认 `_msmpRequest` 返回 null = **MSMP 不可用**，于是每次写操作都退回命令通道，
 * 各用例原有的命令断言口径不变；要断言结构化通道的用例自行覆盖 `_msmpRequest`。
 * 这也正是「MSMP 关闭时全量仍绿」这条验收在单测层的体现。
 */
import { vi } from 'vitest';
import * as msmpMethods from '../../services/mc-server/msmp-methods.js';

const METHOD_NAMES = [
  '_writeViaPreferredChannel',
  'whitelistAdd',
  'whitelistRemove',
  'opPlayer',
  'deopPlayer',
  'kickPlayer',
  'banPlayer',
  'banIp',
  'pardonPlayer',
  'pardonIp',
];

/** 幂等：同一个桩被包两次不会叠加 */
export function asInstance(stub) {
  if (!stub) return stub;
  stub._msmpRequest ??= vi.fn(async () => null);
  stub._msmpAvailable ??= false;
  for (const name of METHOD_NAMES) stub[name] = msmpMethods[name].bind(stub);
  return stub;
}
