/**
 * 内置 HTTPS 状态端点（认证域内）。
 *
 * 面板已能同时接受明文与 TLS，但「这台设备是否已信任本地面板 CA」只有浏览器
 * 自己知道——服务端给不出这个答案，只能给出「装的是哪张证书」与「怎么装」。
 * 设置页据此渲染引导，用户装完再点一次检测即可确认。
 *
 * 指纹与地址清单都属公开信息（根证书本身公开、私钥不出本机），放在认证域内
 * 只为避免把部署细节暴露给未认证访问者。
 */
import { Router } from 'express';
import { httpsStatusSchema } from '@mc-commander/schemas';
import { validatedSuccess } from '../middleware/validate.js';
import { caFingerprint, readServerCertFacts } from '../services/tls/cert.js';

/**
 * @param {{ enabled: boolean, disabledReason: string|null }} state
 *   监听状态由启动流程决定（openssl 缺失、签发失败等都在那里收口），
 *   路由不重复判断——否则「服务端实际没在听 TLS 而这里说 enabled」会让
 *   设置页把用户引到一个不存在的地址上
 */
export function createHttpsRoutes(state) {
  const router = Router();

  router.get('/https', (req, res) => {
    const facts = readServerCertFacts();
    res.json(
      validatedSuccess(httpsStatusSchema, {
        enabled: state.enabled,
        disabledReason: state.disabledReason,
        caFingerprint: caFingerprint(),
        serverNames: facts.serverNames,
        expiresAt: facts.expiresAt,
      }),
    );
  });

  return router;
}
