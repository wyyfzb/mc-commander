import { describe, it, expect } from 'vitest';
import { generateServerProperties } from '../src/routes/server-jar.js';

/** 从生成的 properties 文本里取某个键的值 */
function readKey(text, key) {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

describe('部署生成的 server.properties 端口一致性', () => {
  it('server-port 与 query.port 取同一个实例端口', () => {
    // 多实例并存时每个实例分到的端口不同，query.port 写死会让开启 Query 后对不上
    for (const port of [25567, 25568, 30000]) {
      const text = generateServerProperties('inst-1', '26.3', port);
      expect(readKey(text, 'server-port')).toBe(String(port));
      expect(readKey(text, 'query.port')).toBe(String(port));
    }
  });

  it('rcon.port 与 server-port 不同（两套协议不能同端口）', () => {
    const text = generateServerProperties('inst-1', '26.3', 25567);
    expect(readKey(text, 'rcon.port')).not.toBe(readKey(text, 'server-port'));
  });

  it('产物里不出现任何写死的 25565', () => {
    const text = generateServerProperties('inst-1', '26.3', 25567);
    expect(text).not.toContain('25565');
  });
});
