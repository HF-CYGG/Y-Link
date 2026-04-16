/**
 * 模块说明：src/vite-env.d.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_LOCAL_BACKEND_URL?: string
  readonly VITE_DEV_SERVER_HTTPS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
