/**
 * 模块说明：backend/src/types/client-auth.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { Request } from 'express'

export interface ClientAuthContext {
  userId: string
  mobile: string
  realName: string
  sessionToken: string
}

export interface ClientAuthenticatedRequest extends Request {
  clientAuth: ClientAuthContext
}
