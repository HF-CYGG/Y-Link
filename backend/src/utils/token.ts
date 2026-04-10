/**
 * 模块说明：backend/src/utils/token.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { randomBytes } from 'node:crypto'

/**
 * 生成会话令牌：
 * - 使用高强度随机字节，避免可预测令牌；
 * - Bearer Token 仅在服务端数据库中留存，可支持主动退出与会话失效。
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}
