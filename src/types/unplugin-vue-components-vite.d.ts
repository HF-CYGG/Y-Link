/**
 * 文件说明：为 `vite.config.ts` 中使用的 `unplugin-vue-components` 提供本地类型声明兜底。
 * 实现逻辑：
 * 1. 某些 IDE/TypeScript 服务在工作区依赖已安装的情况下，仍可能暂时无法解析该插件的导出声明；
 * 2. 构建链路实际可通过，因此这里仅补充最小声明，避免本地 diagnostics 持续误报；
 * 3. 声明保持宽松，不改变运行时行为，只服务于静态类型系统。
 */
declare module 'unplugin-vue-components/vite' {
  import type { PluginOption } from 'vite'

  type ComponentsPluginOptions = {
    dts?: boolean | string
    resolvers?: unknown[]
  }

  export default function Components(options?: ComponentsPluginOptions): PluginOption
}

declare module 'unplugin-vue-components/resolvers' {
  type ElementPlusResolverOptions = {
    importStyle?: 'css' | 'sass' | boolean
  }

  export function ElementPlusResolver(options?: ElementPlusResolverOptions): unknown
}
