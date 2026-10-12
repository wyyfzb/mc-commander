import { Router } from 'express';
import {
  machineCredentialListSchema,
  machineCredentialCreateResponseSchema,
  machineCredentialCreateBodySchema,
  machineCredentialToggleBodySchema,
  machineCredentialSelfSchema,
} from '@mc-commander/schemas';
import { MachineCredentialModel } from '../db/index.js';
import { error, ErrorCodes } from '../utils/response.js';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { hashToken } from '../utils/password.js';
import { generateApiKey } from '../utils/credentials.js';
import { GRANTABLE_SCOPES, partitionGrantable } from '../utils/scopes.js';

/**
 * 作用域化机器凭据的管理端点（一期只发放只读作用域）。
 *
 * 与 `routes/keys.js` 的分工：keys.js 管 `.env` 里那两把**固定通道**（部署方自填、
 * 一把一角色、轮换即覆写哈希）；本文件管**用户自建、可命名、可作用域化、可停用/吊销**
 * 的委托身份。前者是既有部署形态，后者是给「用户自己的 AI」用的身份。
 *
 * 全部端点仅管理员可达：它们不在 SCOPE_ENDPOINTS 里，故角色门对只读凭据一律 403
 * ——受限凭据无法自我提权，也无法替换同类凭据（与 rotate-readonly-key 同款护栏）。
 */

/** 明文 token 前缀：与 `.env` 通道的 mcck-/mcro- 区分，一眼能看出「这是自建凭据」 */
const MACHINE_KEY_PREFIX = 'mcs-';

/** 单部署的凭据数量上限。**advisory**：判定是「读当前数量再插入」，无事务，
 *  故并发创建可能略微超出——后果是自身台账多几行（自伤、有界），不值得为它上锁；
 *  它真正防的是误用（凭据是人工管理的，超量说明用法有误）。 */
const MAX_CREDENTIALS = 50;

export function createMachineCredentialRoutes() {
  const router = Router();

  // GET /api/v1/machine-credentials - 列出凭据（不含明文与摘要）
  router.get('/machine-credentials', (req, res) => {
    res.json(validatedSuccess(machineCredentialListSchema, MachineCredentialModel.list()));
  });

  // POST /api/v1/machine-credentials - 新建凭据，明文 token 仅此一次返回
  router.post(
    '/machine-credentials',
    validateBody(machineCredentialCreateBodySchema),
    (req, res) => {
      const { name, scopes } = req.body;

      // 一期只发放只读作用域。两道闸门互补：
      // ① 契约的 zod 枚举拒收「语法上不认识」的取值（未知/写作用域在此即 400）；
      // ② 下面这道拒收「认识但不许发放」的取值——它才是**安全边界**，因为将来
      //    新增写作用域时，①会随契约一起放行，只有②会拦住。
      // 一律拒绝而非静默降级成只读：降级会让用户以为拿到了写权限。
      const { grantable, ungrantable, unknown } = partitionGrantable(scopes);
      if (ungrantable.length > 0 || unknown.length > 0) {
        return res.status(400).json(
          error(
            ErrorCodes.VALIDATION_ERROR,
            `本期只支持发放只读作用域（${GRANTABLE_SCOPES.join(', ')}）`,
            [...ungrantable, ...unknown].map((s) => ({
              path: 'scopes',
              message: `不允许发放的作用域: ${s}`,
            })),
          ),
        );
      }

      const existing = MachineCredentialModel.list();
      if (existing.length >= MAX_CREDENTIALS) {
        return res
          .status(400)
          .json(
            error(
              ErrorCodes.VALIDATION_ERROR,
              `凭据数量已达上限（${MAX_CREDENTIALS}），请先吊销不用的`,
            ),
          );
      }

      // 同名校验：名字是人在列表里辨认凭据的唯一线索，重名会让「吊销哪一把」变成猜谜
      if (existing.some((c) => c.name === name)) {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, `已存在同名凭据：${name}`));
      }

      const token = generateApiKey(MACHINE_KEY_PREFIX);
      const created = MachineCredentialModel.create({
        name,
        tokenHash: hashToken(token),
        // 前缀 + 前 8 位 hex（共 12 字符）：足以辨认「是哪一把」、不足以还原
        tokenPrefix: token.slice(0, 12),
        scopes: grantable,
      });

      recordAudit({
        action: AuditActions.CREDENTIAL_CREATE,
        targetType: 'machine_credential',
        targetId: created.id,
        // 审计只记名字与作用域，**永不记明文**
        detail: { name, scopes: grantable },
      });

      res
        .status(201)
        .json(
          validatedSuccess(
            machineCredentialCreateResponseSchema,
            { ...created, token },
            '凭据已创建：明文只显示这一次，请立即保存',
          ),
        );
    },
  );

  // PUT /api/v1/machine-credentials/:id/enabled - 启停（可恢复）
  router.put(
    '/machine-credentials/:id/enabled',
    validateBody(machineCredentialToggleBodySchema),
    (req, res) => {
      const { isEnabled } = req.body;
      const ok = MachineCredentialModel.setEnabled(req.params.id, isEnabled);
      if (!ok) {
        return res.status(404).json(error(ErrorCodes.NOT_FOUND, '凭据不存在或已吊销'));
      }
      recordAudit({
        action: AuditActions.CREDENTIAL_TOGGLE,
        targetType: 'machine_credential',
        targetId: req.params.id,
        detail: { isEnabled },
      });
      res.json(
        validatedSuccess(
          machineCredentialListSchema,
          MachineCredentialModel.list(),
          isEnabled ? '凭据已启用' : '凭据已停用',
        ),
      );
    },
  );

  // DELETE /api/v1/machine-credentials/:id - 吊销（不可逆，保留台账行）
  router.delete('/machine-credentials/:id', (req, res) => {
    const ok = MachineCredentialModel.revoke(req.params.id);
    if (!ok) {
      return res.status(404).json(error(ErrorCodes.NOT_FOUND, '凭据不存在或已吊销'));
    }
    recordAudit({
      action: AuditActions.CREDENTIAL_REVOKE,
      targetType: 'machine_credential',
      targetId: req.params.id,
      detail: { revoked: true },
    });
    res.json(
      validatedSuccess(machineCredentialListSchema, MachineCredentialModel.list(), '凭据已吊销'),
    );
  });

  return router;
}

/**
 * 自检端点：让调用方问「我是谁、我能做什么」。这是给 AI/脚本的自省入口——没有它，
 * 调用方只能靠试错（发请求看是否 403）来判断自己的权限面。
 *
 * **免作用域**（见 utils/scopes.js 的 SCOPE_FREE_ENDPOINTS）：它只回显调用方**自己**
 * 的身份，不读取任何服务端资源——那份信息调用方本就持有，放行不产生新的信息暴露。
 * 因此对只读凭据也放行（管理员同样可用）。
 */
export function createMachineCredentialSelfRoutes() {
  const router = Router();

  router.get('/machine-credentials/self', (req, res) => {
    const auth = req.auth ?? {};
    res.json(
      validatedSuccess(machineCredentialSelfSchema, {
        // 管理员不按作用域判定，故 scopes 报空数组而非全集——报全集会被读成
        // 「管理员也只有这三项」（role 字段承担区分）
        role: auth.role === 'admin' ? 'admin' : 'readonly',
        // 只有台账凭据有名字；`.env` 固定通道无名字，报空串（不编造名字）
        name: auth.credentialName ?? '',
        scopes: Array.isArray(auth.scopes) ? auth.scopes : [],
      }),
    );
  });

  return router;
}

export default createMachineCredentialRoutes;
