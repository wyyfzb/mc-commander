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

  it('无 online: 标记返回 null（措辞完全不同）', () => {
    expect(parseListResponse('Unknown command. Type "/help" for help.')).toBeNull();
  });

  it('认得出句子形态但名字一个都没认出来 → null（不能当成「没有人在线」）', () => {
    // 换个语言/服务端实现后名字列表形态变了：当成空名单会让界面显示 0 人在线，
    // 而清空名单正是要避免的方向
    expect(parseListResponse('There are 1 of a max of 20 players online: \u0000\u0001')).toBeNull();
  });

  it('非 Java 规范的名字（中文/带空格）照常返回：它们是真实在线玩家', () => {
    // 多人在线时只要有一位模组/跨端/插件名的形态不合 Java 规范，作废整份会让对账
    // 永久静默停摆——症状与不修一模一样。名字合法性不是本解析器的职责：
    // 判进来就要如实上报，让界面按原样呈现。
    expect(
      parseListResponse('There are 3 of a max of 20 players online: Steve, 玩家甲, Alex'),
    ).toEqual({ names: ['Steve', '玩家甲', 'Alex'] });
    expect(
      parseListResponse('There are 2 of a max of 20 players online: Steve, Shop Keeper'),
    ).toEqual({ names: ['Steve', 'Shop Keeper'] });
  });

  it('超长 token（整段散文被误当名字）被跳过，其余名字仍可用', () => {
    const prose = 'x'.repeat(65);
    expect(parseListResponse(`There are 2 of a max of 20 players online: Steve, ${prose}`)).toEqual(
      { names: ['Steve'] },
    );
  });

  it('含控制字符/换行的 token 被跳过（该行被截断或串了别的输出）', () => {
    expect(parseListResponse('There are 2 of a max of 20 players online: Steve, Bro\nken')).toEqual(
      { names: ['Steve'] },
    );
  });

  it('取第一个 online: 之后的名单（名字里含该子串时不截断前半段）', () => {
    // 取最后一个 marker 会把前一名截断成 bot——名字里含该子串虽然罕见，
    // 但前缀本身只出现一次，没有理由往右找
    expect(
      parseListResponse('There are 2 of a max of 20 players online: Steveonline:bot, Alex'),
    ).toEqual({ names: ['Steveonline:bot', 'Alex'] });
  });

  it('尾随逗号/连续逗号产生的空 token 被跳过，不作废整份名单', () => {
    expect(parseListResponse('There are 2 of a max of 20 players online: Steve,, Alex,')).toEqual({
      names: ['Steve', 'Alex'],
    });
  });
});
