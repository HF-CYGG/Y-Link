/**
 * 文件说明：前端 Vite 构建与开发服务器配置。
 * 实现逻辑：
 * 1. 统一注册 Vue、HTTPS 与路径别名；
 * 2. 在本地开发阶段代理 `/api`、`/uploads`、`/health` 到后端；
 * 3. 在生产构建阶段执行手工拆包，优化首屏缓存与路由切换体验。
 */
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const runtimeEnv = loadEnv(mode, process.cwd(), '')
  const localBackendOrigin = runtimeEnv.VITE_LOCAL_BACKEND_URL || 'http://127.0.0.1:3001'
  const enableHttps = runtimeEnv.VITE_DEV_SERVER_HTTPS !== 'false'

  return {
    plugins: [
      vue(),
      ...(command === 'serve' && enableHttps ? [basicSsl()] : []),
    ],
    resolve: {
      // 统一配置路径别名，提升模块导入可读性并降低相对路径层级复杂度
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    /**
     * 本地开发代理：
     * - 前端继续使用 `/api` 相对路径，无需硬编码本地后端地址；
     * - 仅在 Vite serve 阶段生效，不影响生产构建与 Docker Nginx 代理；
     * - 目标地址可通过 `VITE_LOCAL_BACKEND_URL` 覆盖，便于联调自定义端口；
     * - 默认启用自签名 HTTPS，保证手机真机联调时可调用摄像头能力。
     */
    server:
      command === 'serve'
        ? {
            https: enableHttps ? {} : undefined,
            proxy: {
              '/api': {
                target: localBackendOrigin,
                changeOrigin: true,
              },
              '/uploads': {
                target: localBackendOrigin,
                changeOrigin: true,
              },
              '/health': {
                target: localBackendOrigin,
                changeOrigin: true,
              },
            },
          }
        : undefined,
    /**
     * 构建拆包策略：
     * - 将 Vue 运行时、Element Plus 与其余第三方依赖拆成独立缓存块；
     * - 避免单个超大共享包拖慢登录页与首屏进入速度；
     * - 配合业务路由懒加载，让高频页面切换优先命中浏览器缓存。
     */
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replaceAll('\\', '/')

            if (!normalizedId.includes('/node_modules/')) {
              return
            }

            if (
              normalizedId.includes('/node_modules/vue/')
              || normalizedId.includes('/node_modules/vue-router/')
              || normalizedId.includes('/node_modules/pinia/')
            ) {
              return 'framework'
            }

            if (
              normalizedId.includes('/node_modules/element-plus/')
              || normalizedId.includes('/node_modules/@element-plus/')
              || normalizedId.includes('/node_modules/@vueuse/')
              || normalizedId.includes('/node_modules/dayjs/')
            ) {
              return 'ui-kit'
            }

            return 'vendor'
          },
        },
      },
    },
  }
})
