/**
 * 命令历史敏感值遮蔽（落库前）
 *
 * 命令史是审计资产（谁在何时执行了什么操作），遮蔽目标是「外部密钥类值」
 * 而非运维命令本身——op/ban/kick 等命令的目标玩家名是审计核心价值，保留；
 * 用户经 /command 端点自由输入的命令可能粘贴含密钥的参数（如
 * login <token>、带签名的 URL、password=xxx），这类值入库即成为
 * 数据库泄露时的横向凭证，统一遮为 ***（key 名保留，可观测性不丢）。
 */

/** 裸键名词表：键名后跟空白分隔的值（login <token> / password <value>）——
 *  login 是 MC 服务器生态常见的裸令牌入口；register 之类通用词不入表
 *  （会误吞后续真正的键名） */
const BARE_KEY_NAMES =
  'login|password|passwd|secret|token|apikey|api-key|access[_-]?key|private[_-]?key';
/** 值形态一：裸键名 + 空白 + 值（先跑：吞掉整段，防 key=value 残段二次遮蔽） */
const FLAG_VALUE_PATTERN = new RegExp(
  `\\b(?:${BARE_KEY_NAMES})\\b\\s+(?!\\S*[=:]\\S*)(\\S+)`,
  'gi',
);
/** 值形态二：key=value / key:value（= 与 : 两侧无空白） */
const KEY_VALUE_PATTERN =
  /(\w*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*\s*[=:]\s*)(\S+)/gi;

export function maskSensitiveCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return command;
  return command
    .replace(FLAG_VALUE_PATTERN, (m, val) => m.replace(val, '***'))
    .replace(KEY_VALUE_PATTERN, '$1***');
}
