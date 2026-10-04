/**
 * RCON `list` 返回解析测试
 * 样本取自实机逐字返回（vanilla，MC 26.1），另含措辞漂移与非法名的边界。
 */
import { describe, it, expect } from 'vitest';
import { parseListResponse } from '../services/mc-server/list-response.js';

describe('parseListResponse', () => {
  it('空名单：冒号后仅一个空格', () => {
    expect(parseListResponse('There are 0 of a max of 20 players online: ')).toEqual({ names: [] });
  });

  it('单名', () => {
    expect(parseListResponse('There are 1 of a max of 20 players online: UatProbe3')).toEqual({
      names: ['UatProbe3'],
    });
  });

  it('多名按 ", " 切分', () => {
    expect(
      parseListResponse('There are 2 of a max of 20 players online: UatProbeA, UatProbeB'),
    ).toEqual({ names: ['UatProbeA', 'UatProbeB'] });
  });

  it('容忍计数措辞漂移与多余空格', () => {
    expect(parseListResponse('There are 2/20 players online:  Steve ,Alex')).toEqual({
      names: ['Steve', 'Alex'],
    });
  });

  it('容忍结尾换行（RCON 返回可能带行尾）', () => {
    expect(parseListResponse('There are 1 of a max of 20 players online: Steve\n')).toEqual({
      names: ['Steve'],
    });
  });

  it('非字符串返回 null', () => {
    expect(parseListResponse(null)).toBeNull();
    expect(parseListResponse(undefined)).toBeNull();
    expect(parseListResponse(42)).toBeNull();
  });

  it('无 online: 标记返回 null', () => {
    expect(parseListResponse('Unknown command. Type "/help" for help.')).toBeNull();
  });

  it('非法玩家名返回 null（措辞变了不能部分认识）', () => {
    expect(parseListResponse('There are 1 of a max of 20 players online: <not-a-name>')).toBeNull();
    expect(parseListResponse('There are 1 of a max of 20 players online: 玩家甲')).toBeNull();
  });

  it('尾随逗号视为非法（宁可返回 null 也不吞掉异常形态）', () => {
    expect(parseListResponse('There are 1 of a max of 20 players online: Steve,')).toBeNull();
  });
});
