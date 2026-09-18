/**
 * 接管实例日志续读域（后续）：面板重启后接管实例的 stdout 管道随旧
 * 面板进程销毁且无法重连（匿名管道无名字，新进程无法重新打开），此前接管
 * 期间终端日志断档、玩家事件（加入/离开/成就/聊天）解析中断。
 *
 * 机制：改从 MC 自身日志文件（logs/latest.log，vanilla 每次启动重写、持续
 * 落盘）尾部增量读取，行走与 stdout 管道同一摄取入口（_ingestLogText），
 * 使接管实例的日志、事件解析、WS 推送行为与常规实例一致。
 *
 * 仅 adopted 实例启用；常规实例仍走 stdout 管道（本域不参与）。
 */

import path from 'path';
import fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { logger } from '../../utils/logger.js';

/** 轮询间隔：文件读取代替管道事件流，400ms 对面板展示足够且开销可忽略 */
export const LOG_TAIL_INTERVAL_MS = 400;
/** 单轮最多读取字节：日志暴涨时防一次性读入过大 */
const MAX_READ_BYTES = 256 * 1024;
/** 未换行余段的长度上限：超限强制摄取，防极端长行无限累积 */
const MAX_REMAINDER_CHARS = 64 * 1024;

export function _logTailPath() {
  return path.join(this.serverPath, 'logs', 'latest.log');
}

/** 接管成功后启动续读（接管实例专用）。首次轮询只记录文件末尾位置——
 *  构造期的 _loadLogBufferFromLatestLog 已回填尾部内容，从末尾起读避免重复。 */
export function _startAdoptedLogTail() {
  this._stopAdoptedLogTail();
  this._logTailState = { offset: null, ino: null, remainder: '', decoder: new StringDecoder('utf8') };
  this._logTailTimer = setInterval(() => this._pollAdoptedLogTail(), LOG_TAIL_INTERVAL_MS);
  // 不阻塞面板进程退出
  this._logTailTimer.unref?.();
}

export function _stopAdoptedLogTail() {
  if (this._logTailTimer) {
    clearInterval(this._logTailTimer);
    this._logTailTimer = null;
  }
  this._logTailState = null;
}

/** 增量读取并摄取新增日志行。边界处理：
 *  - 接管结束/实例停止：自清理（覆盖 stop/kill/看门狗各条退出路径）
 *  - 文件被重写或轮转（vanilla 每次启动重写 latest.log）：inode 变化或
 *    长度回退 → 从头读，并重置多字节解码器
 *  - 末尾不完整行：StringDecoder 保留跨块多字节，余段留待下轮拼接后再摄取
 *    （直接摄取会把一行日志拆成两行） */
export function _pollAdoptedLogTail() {
  const state = this._logTailState;
  if (!state) return;
  if (!this.adopted || !this.isRunning) {
    this._stopAdoptedLogTail();
    return;
  }
  const file = this._logTailPath();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return; // 文件尚未创建/瞬时不可读，下轮再试
  }
  if (state.offset === null) {
    state.offset = stat.size;
    state.ino = stat.ino;
    return;
  }
  if (stat.ino !== state.ino || stat.size < state.offset) {
    state.offset = 0;
    state.ino = stat.ino;
    state.remainder = '';
    state.decoder = new StringDecoder('utf8');
  }
  if (stat.size <= state.offset) return;
  const start = Math.max(state.offset, stat.size - MAX_READ_BYTES);
  let chunk;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      chunk = state.decoder.write(buf);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    logger.warn(`[${this.id}] log tail read failed:`, e.message);
    return;
  }
  state.offset = stat.size;
  const raw = state.remainder + chunk;
  const lastNewline = raw.lastIndexOf('\n');
  if (lastNewline < 0 && raw.length <= MAX_REMAINDER_CHARS) {
    state.remainder = raw; // 尚无完整行：留待下轮
    return;
  }
  state.remainder = lastNewline >= 0 ? raw.slice(lastNewline + 1) : '';
  const body = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : raw;
  if (body.trim()) this._ingestLogText(body, 'stdout');
}
