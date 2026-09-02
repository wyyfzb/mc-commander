/**
 * zod schema 校验中间件
 * 请求体经 schema.safeParse 校验后替换为解析结果（剥离未知字段）
 */
import { error, ErrorCodes } from '../utils/response.js';

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, messages.join('; ')));
    }
    req.body = result.data;
    next();
  };
}
