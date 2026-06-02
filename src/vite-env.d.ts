/**
 * 模块说明：src/vite-env.d.ts
 * 文件职责：补充 Vite 运行时环境变量的 TypeScript 声明，让前端代码在读取构建期注入变量时具备明确类型提示。
 * 维护说明：
 * - 若新增 `VITE_*` 环境变量，需要同步在这里补充声明，避免页面与工具层读取时退回 `any`；
 * - 这里只负责类型约束，不承载默认值与运行时校验逻辑，相关兜底应放在实际使用位置处理。
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
