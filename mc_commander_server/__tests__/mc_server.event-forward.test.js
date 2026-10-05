import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MCServerManager } from '../services/mc_server.js';

/**
 * 实例事件转发：MCServerInstance 发出的玩家事件必须由 manager 加上 instanceId
 * 后以 instance:<事件名> 转发——websocket.js 与 webhook.service.js 只监听转发后的
 * 事件名，漏注册即成死监听（playerChat 曾因此全链路断裂）。
 */
describe('MCServerManager 实例事件转发', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-forward-'));
    fs.writeFileSync(path.join(tmpDir, 'server.jar'), '');
    // 构造 manager 会加载实例（DB 未初始化时告警），本用例只关注转发注册
    vi.spyOn(MCServerManager.prototype, 'loadInstances').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const GAME_EVENTS = [
    ['playerJoin', { name: 'Steve' }],
    ['playerLeave', { name: 'Steve' }],
    ['playerDeath', { name: 'Steve', cause: '被击杀' }],
    ['playerRespawn', { name: 'Steve' }],
    ['playerChat', { name: 'Steve', message: 'hello' }],
    ['achievement', { name: 'Steve', advancement: 'Stone Age' }],
    ['playerSleep', { name: 'Steve', sleeping: true }],
    // 世界格式升级（MSMP 通知面一期）：漏注册即成死监听——websocket.js 只监听转发后的
    // 事件名，实例直接 emit 的那个名字没有任何人订阅（playerChat 曾因此全链路断裂）
    ['worldUpgrade', { state: 'progress', progress: 0.5 }],
  ];

  it.each(GAME_EVENTS)('实例 %s 事件转发为 instance:%s 且携带 instanceId', (evt, payload) => {
    const manager = new MCServerManager();
    const instance = manager.createInstance({
      id: 'inst-1',
      name: '转发测试',
      jarFile: 'server.jar',
      serverPath: tmpDir,
    });

    const seen = [];
    manager.on(`instance:${evt}`, (d) => seen.push(d));
    instance.emit(evt, payload);

    expect(seen).toEqual([{ instanceId: 'inst-1', ...payload }]);
  });
});
