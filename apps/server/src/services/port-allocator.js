import net from 'node:net';
import { GAME_PORT_COUNT, GAME_PORT_START, RCON_PORT_START } from '@mc-commander/schemas';

/**
 * 实例端口分配。
 *
 * 段位定义在契约包：前端要用同一份事实告诉用户去云控制台放行哪几段。
 * 段位固定后端口号本身可读——用户看到 25567 就知道这是第一个实例。
 */
export {
  GAME_PORT_COUNT,
  GAME_PORT_START,
  PANEL_PORT,
  RCON_PORT_START,
} from '@mc-commander/schemas';

/** rcon 段与 game 段隔开，不共享取模基数，避免一个实例的 rcon 占掉别人的 game 端口 */
export function rconPortFor(gamePort) {
  return RCON_PORT_START + (gamePort - GAME_PORT_START);
}

/**
 * 从实例列表推出该实例的 game 端口：已在列表里的沿用其 port（端口一旦发给用户，
 * 换端口等于换服务器地址，玩家那边的收藏会失效）；新实例取段内最小空闲值。
 */
export function allocateGamePort(instances, instanceId) {
  const used = new Set();
  for (const inst of instances) {
    if (!inst || !inst.id || inst.id === instanceId) continue;
    if (Number.isInteger(inst.port) && inst.port >= GAME_PORT_START) used.add(inst.port);
  }
  const existing = instances.find((i) => i && i.id === instanceId);
  if (existing && Number.isInteger(existing.port) && existing.port >= GAME_PORT_START) {
    return existing.port;
  }
  for (let i = 0; i < GAME_PORT_COUNT; i++) {
    const candidate = GAME_PORT_START + i;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

/** 端口在段内但已被别的实例占用时，说明分配状态与实际不符，需要重新分配 */
export function isPortFreeInRange(instances, port, instanceId) {
  return !instances.some(
    (i) => i && i.id !== instanceId && Number.isInteger(i.port) && i.port === port,
  );
}

/** 探本机端口是否真的能绑（段内空闲 ≠ 系统空闲：别的程序可能占着） */
export function probeBindable(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}
