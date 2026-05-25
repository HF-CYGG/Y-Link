/**
 * 模块说明：F:/Y-Link/src/vite-env.d.ts
 * 文件职责：Vite 环境类型声明文件。
 * 实现逻辑：补充 import.meta 与环境变量类型约束。
 * 维护说明：新增环境变量需在此同步声明。
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
