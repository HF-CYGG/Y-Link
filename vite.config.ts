/**
 * 文件说明：前端 Vite 构建与开发服务器配置。
 * 实现逻辑：
 * 1. 统一注册 Vue、HTTPS 与路径别名；
 * 2. 在本地开发阶段代理 `/api`、`/uploads`、`/health` 到后端；
 * 3. 在生产构建阶段执行手工拆包，优化首屏缓存与路由切换体验。
 */
/// <reference path="./src/types/unplugin-vue-components-vite.d.ts" />
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

type VendorChunkRule = {
  chunkName: string
  packageNames: string[]
}

// 手工拆包匹配工具：
// - 统一按 node_modules 下的“包名目录”判断归属，避免在 manualChunks 中堆叠大量 if；
// - 低频重库单独成块后，只有真正触发扫码、导出、图表等场景时才会加载对应 chunk；
// - html2pdf 依赖的 html2canvas/jspdf 一并归组，避免再次回落到共享 vendor。
const VENDOR_CHUNK_RULES: VendorChunkRule[] = [
  {
    chunkName: 'framework',
    packageNames: ['vue', 'vue-router', 'pinia'],
  },
  {
    chunkName: 'ui-kit',
    packageNames: ['element-plus', '@element-plus', '@vueuse', 'dayjs'],
  },
  {
    chunkName: 'charting',
    packageNames: ['echarts', 'vue-echarts', 'zrender'],
  },
  {
    chunkName: 'pdf-export',
    packageNames: ['html2pdf.js', 'html2canvas', 'jspdf'],
  },
  {
    chunkName: 'qr-scanner',
    packageNames: ['html5-qrcode'],
  },
  {
    chunkName: 'qr-code',
    packageNames: ['qrcode'],
  },
  {
    chunkName: 'image-tools',
    packageNames: ['browser-image-compression'],
  },
]

const resolveVendorChunk = (normalizedId: string) => {
  for (const rule of VENDOR_CHUNK_RULES) {
    if (rule.packageNames.some((packageName) => normalizedId.includes(`/node_modules/${packageName}/`))) {
      return rule.chunkName
    }
  }

  return 'vendor'
}

/**
 * 开发态 Element Plus 预构建白名单：
 * - 路由级懒加载页面会在首次进入时才暴露模板里实际使用到的组件样式深导入；
 * - 若这些样式没提前进入 optimizeDeps，Vite 会在运行中临时重新预构建并触发整页 reload；
 * - 这里优先覆盖登录、反馈、弹窗等高频首跳场景出现过的样式入口，降低“第一次进入页面像刷新了一次”的问题。
 */
const DEV_OPTIMIZE_DEPS_INCLUDE = [
  'element-plus/es',
  'element-plus/es/components/base/style/css',
  'element-plus/es/components/config-provider/style/css',
  'element-plus/es/components/alert/style/css',
  'element-plus/es/components/button/style/css',
  'element-plus/es/components/collapse/style/css',
  'element-plus/es/components/collapse-item/style/css',
  'element-plus/es/components/dialog/style/css',
  'element-plus/es/components/dropdown/style/css',
  'element-plus/es/components/dropdown-menu/style/css',
  'element-plus/es/components/dropdown-item/style/css',
  'element-plus/es/components/empty/style/css',
  'element-plus/es/components/form/style/css',
  'element-plus/es/components/form-item/style/css',
  'element-plus/es/components/image/style/css',
  'element-plus/es/components/icon/style/css',
  'element-plus/es/components/input/style/css',
  'element-plus/es/components/loading/style/css',
  'element-plus/es/components/menu/style/css',
  'element-plus/es/components/menu-item/style/css',
  'element-plus/es/components/message/style/css',
  'element-plus/es/components/message-box/style/css',
  'element-plus/es/components/option/style/css',
  'element-plus/es/components/popconfirm/style/css',
  'element-plus/es/components/progress/style/css',
  'element-plus/es/components/row/style/css',
  'element-plus/es/components/scrollbar/style/css',
  'element-plus/es/components/select/style/css',
  'element-plus/es/components/segmented/style/css',
  'element-plus/es/components/skeleton/style/css',
  'element-plus/es/components/space/style/css',
  'element-plus/es/components/sub-menu/style/css',
  'element-plus/es/components/switch/style/css',
  'element-plus/es/components/table/style/css',
  'element-plus/es/components/table-column/style/css',
  'element-plus/es/components/tag/style/css',
  'element-plus/es/components/tooltip/style/css',
  'element-plus/es/components/tree-select/style/css',
  'element-plus/es/components/upload/style/css',
] as const

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const runtimeEnv = loadEnv(mode, process.cwd(), '')
  const localBackendOrigin = runtimeEnv.VITE_LOCAL_BACKEND_URL || 'http://127.0.0.1:3001'
  const enableHttps = runtimeEnv.VITE_DEV_SERVER_HTTPS !== 'false'
  const elementPlusImportStyleStrategy = command === 'serve' ? false : 'css'

  return {
    plugins: [
      vue(),
      /**
       * Element Plus 编译期按需引入：
       * - 仅为模板中真实使用到的组件生成 import；
       * - 生产构建继续按组件粒度注入 CSS，替代入口文件的整包样式；
       * - 开发阶段改为“仅按需引入组件逻辑，不额外拆分组件样式”，把样式统一交给入口完整预加载；
       * - 让低频治理页使用到的表格、树、日期等能力不再常驻主公共块。
       */
      Components({
        dts: false,
        resolvers: [
          ElementPlusResolver({
            importStyle: elementPlusImportStyleStrategy,
          }),
        ],
      }),
      ...(command === 'serve' && enableHttps ? [basicSsl()] : []),
    ],
    resolve: {
      // 统一配置路径别名，提升模块导入可读性并降低相对路径层级复杂度
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    /**
     * 开发态依赖预构建：
     * - 仅在 `vite serve` 阶段生效，不影响生产拆包；
     * - 提前把高频懒加载页会首次触发的 Element Plus 深层样式纳入预构建，避免运行时二次优化导致整页重载。
     */
    optimizeDeps:
      command === 'serve'
        ? {
            include: [...DEV_OPTIMIZE_DEPS_INCLUDE],
          }
        : undefined,
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
     * - 将 Vue 运行时、UI 基础库、兜底 vendor 与低频重库拆成独立缓存块；
     * - 让扫码、二维码生成、PDF 导出、图片压缩、图表等能力按需加载；
     * - 配合业务路由懒加载，避免低频功能污染高频首屏共享缓存。
     */
    build: {
      modulePreload: false,
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replaceAll('\\', '/')

            if (!normalizedId.includes('/node_modules/')) {
              return
            }

            return resolveVendorChunk(normalizedId)
          },
        },
      },
    },
  }
})
