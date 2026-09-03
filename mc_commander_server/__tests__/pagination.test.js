/**
 * parsePagination 单元测试（utils/pagination.js）
 * 覆盖：缺省值 / 非法串 / 负数 / 越界上限 / 边界值 / radix 统一语义 / 各端点口径
 */
import { describe, it, expect } from 'vitest';
import { parsePagination } from '../utils/pagination.js';

describe('parsePagination', () => {
  // ── 缺省值 ──
  it('无参数时回落默认 page=1 pageSize=20', () => {
    expect(parsePagination({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('缺省 pageSize 可经 options 覆盖', () => {
    expect(parsePagination({}, { defaultPageSize: 50 })).toEqual({ page: 1, pageSize: 50 });
  });

  // ── 非法串 ──
  it('非数字串回落默认', () => {
    expect(parsePagination({ page: 'abc', pageSize: 'xyz' })).toEqual({ page: 1, pageSize: 20 });
  });

  it('空串回落默认', () => {
    expect(parsePagination({ page: '', pageSize: '' })).toEqual({ page: 1, pageSize: 20 });
  });

  // ── 负数与 0 ──
  it('负数钳制到下限 1', () => {
    expect(parsePagination({ page: '-5', pageSize: '-3' })).toEqual({ page: 1, pageSize: 1 });
  });

  it('0 视为缺省回落默认（0 falsy 走 || 默认分支）', () => {
    expect(parsePagination({ page: '0', pageSize: '0' })).toEqual({ page: 1, pageSize: 20 });
  });

  // ── 越界上限 ──
  it('page 越界钳制到 maxPage=1000', () => {
    expect(parsePagination({ page: '9999' })).toEqual({ page: 1000, pageSize: 20 });
  });

  it('pageSize 越界钳制到默认 maxPageSize=200', () => {
    expect(parsePagination({ pageSize: '999' })).toEqual({ page: 1, pageSize: 200 });
  });

  it('pageSize 上限可按端点口径覆盖（tasks/backups=100）', () => {
    expect(parsePagination({ pageSize: '999' }, { maxPageSize: 100 })).toEqual({ page: 1, pageSize: 100 });
  });

  it('maxPage 可覆盖（收窄场景）', () => {
    expect(parsePagination({ page: '500' }, { maxPage: 100 })).toEqual({ page: 100, pageSize: 20 });
  });

  // ── 边界值 ──
  it('上边界值原样保留', () => {
    expect(parsePagination({ page: '1000', pageSize: '200' })).toEqual({ page: 1000, pageSize: 200 });
  });

  it('下边界值原样保留', () => {
    expect(parsePagination({ page: '1', pageSize: '1' })).toEqual({ page: 1, pageSize: 1 });
  });

  it('小数截断（parseInt 语义，不四舍五入）', () => {
    expect(parsePagination({ page: '3.7', pageSize: '19.9' })).toEqual({ page: 3, pageSize: 19 });
  });

  it('前后空白容忍（parseInt 语义）', () => {
    expect(parsePagination({ page: ' 2 ' })).toEqual({ page: 2, pageSize: 20 });
  });

  it('超大数值钳制到上限（不溢出为异常值）', () => {
    expect(parsePagination({ page: '999999999999999999999' })).toEqual({ page: 1000, pageSize: 20 });
  });

  // ── radix 统一语义 ──
  it('十六进制样式串不隐式解析，回落默认（radix 10 统一）', () => {
    expect(parsePagination({ page: '0x10', pageSize: '0x8' })).toEqual({ page: 1, pageSize: 20 });
  });

  // ── 端点口径组合（与路由替换处一致）──
  it('webhooks 口径：maxPageSize=200 + page 上限 1000（本任务唯一行为加固）', () => {
    expect(parsePagination({ page: '5000', pageSize: '500' }, { maxPageSize: 200 })).toEqual({
      page: 1000,
      pageSize: 200,
    });
  });

  it('tasks/backups 口径：maxPageSize=100', () => {
    expect(parsePagination({ page: '2', pageSize: '50' }, { maxPageSize: 100 })).toEqual({ page: 2, pageSize: 50 });
  });
});
