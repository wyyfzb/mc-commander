/**
 * 实例 id 的形态与生成（单一事实源）。
 *
 * 形态：`<type>-<8 位十六进制>`（type 取自部署请求的服务端类型枚举）。
 * 消费方不只是「生成」一处——备份快照清扫按 id 形态白名单判断哪些目录是本面板
 * 产出的实例目录（人工放置的目录、`panel/` 命名空间靠它排除在清扫射程外）。
 * 两处各写一份形态必然分叉：改生成方式（如长度变化）而清扫的模式没跟着变，
 * 清扫会静默停止工作（少删方向、不报错，最难发现的那类失效）。
 */
import crypto from 'crypto';

/** 随机段字节数（4 字节 → 8 位十六进制），生成与形态校验共用 */
export const INSTANCE_ID_RANDOM_BYTES = 4;

/** 实例 id 形态：与 generateInstanceId 由同一常量派生 */
export const INSTANCE_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9]*-[0-9a-f]{${INSTANCE_ID_RANDOM_BYTES * 2}}$`
);

/**
 * 生成实例 id。
 * @param {string} type 服务端类型（vanilla/paper/fabric/forge/purpur）
 */
export function generateInstanceId(type) {
  return `${type}-${crypto.randomBytes(INSTANCE_ID_RANDOM_BYTES).toString('hex')}`;
}
