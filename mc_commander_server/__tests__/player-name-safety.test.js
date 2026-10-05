/**
 * 玩家名**安全谓词**（`isSafePlayerName` / `playerNameRejectionReason`）。
 *
 * 这条判据的边界**全部来自实机 RCON 实测**（MC 26.3），不是照规范推的——正因如此，
 * 旧实现 `^[A-Za-z0-9_]{3,16}$` 与实测差得很远：它把服务端**本可寻址**的名字
 * （Floodgate 前缀名、中文名、含 `-`/`.` 的名字）一并挡掉，却对「前导 `@`」这条
 * 真正危险的性质不加区分（它挡住了，但理由是「不是合法字符」，而不是「会被当选择器」）。
 *
 * 实测对照（`whitelist add <名>`）：
 * | 名字 | 服务端返回 | 含义 |
 * | --- | --- | --- |
 * | `Bot_Steve` | `Added … to the whitelist` | 收 |
 * | `.BedrockName` | `That player does not exist` | **收（字面量）** |
 * | `中文名` | `That player does not exist` | **收（字面量）** |
 * | `ab` / 17 字符名 | `Added …` / `That player does not exist` | **服务端不校验长度** |
 * | `@a` | `No player was found` | **选择器语义**（危险） |
 * | `"@a"`（加引号） | `That player does not exist` | 引号可中和 |
 * | `"Bot Steve"` | `Incorrect argument for command` | **服务端拒绝含空格** |
 * | `"[Bot] Steve"` | `Incorrect argument for command` | **服务端拒绝方括号** |
 */
import { describe, it, expect } from 'vitest';
import { isSafePlayerName, playerNameRejectionReason } from '../utils/player-utils.js';

describe('isSafePlayerName：服务端实测可寻址的名字须放行', () => {
  it.each([
    ['正版名', 'Bot_Steve'],
    ['Floodgate 前缀名（旧正则的主要误伤）', '.BedrockName'],
    ['中文名', '中文名'],
    ['含连字符', '-dash-Name'],
    ['含点与下划线', 'a_b.c-D1'],
    ['2 字符（服务端不校验下限，实测照收）', 'ab'],
    ['17 字符（服务端不校验 16 上限，实测照收）', 'a'.repeat(17)],
    ['32 字符（本仓上限边界）', 'a'.repeat(32)],
  ])('%s：%s 放行', (_label, name) => {
    expect(playerNameRejectionReason(name)).toBe(null);
    expect(isSafePlayerName(name)).toBe(true);
  });
});

describe('isSafePlayerName：须拦下的形态（每条都附实测依据）', () => {
  it.each([
    ['前导 @ ——实测走选择器语义，ban @a 会波及全部在线玩家', '@a', '目标选择器'],
    ['仅 @ 本身', '@', '目标选择器'],
    ['含空格——实测服务端回 Incorrect argument，寻址不到', 'Bot Steve', '空白'],
    ['方括号（不带空格，避免先撞空白那条）', '[Bot]Steve', '方括号'],
    ['双引号——会破坏命令里的字面量包裹', 'a"b', '引号'],
    ['单引号', "a'b", '引号'],
    ['路径分隔符', 'a/b', '路径'],
    ['反斜杠', 'a\\b', '路径'],
    ['上跳片段', 'a..b', '路径'],
    ['控制字符', 'a\u0000b', '控制字符'],
    ['超长（33 字符）', 'a'.repeat(33), '过长'],
    ['空串', '', '为空'],
  ])('%s', (_label, name, fragment) => {
    expect(isSafePlayerName(name)).toBe(false);
    expect(playerNameRejectionReason(name)).toContain(fragment);
  });

  it('非字符串（undefined/null/数字）一律拒绝，不抛错', () => {
    for (const v of [undefined, null, 42, {}, []]) {
      expect(isSafePlayerName(v)).toBe(false);
      expect(playerNameRejectionReason(v)).toBeTruthy();
    }
  });
});

describe('放行的名字不含任何会改变命令解析的字符', () => {
  it('放行集合里没有空白/引号/方括号/前导 @（这是护栏的实质）', () => {
    // 用一批「服务端实测可寻址」的名字做交叉验证：它们进命令后仍是**单个 token**
    const accepted = ['Bot_Steve', '.BedrockName', '中文名', '-dash-Name', 'ab'];
    for (const name of accepted) {
      expect(isSafePlayerName(name)).toBe(true);
      expect(/\s/.test(name)).toBe(false);
      expect(/["'[\]]/.test(name)).toBe(false);
      expect(name.startsWith('@')).toBe(false);
    }
  });
});
