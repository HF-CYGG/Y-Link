/**
 * 文件说明：前端 Vite 构建与开发服务器配置。
 * 实现逻辑：
 * 1. 统一注册 Vue、HTTPS 与路径别名；
 * 2. 在本地开发阶段代理 `/api`、`/uploads`、`/health` 到后端；
 * 3. 在生产构建阶段执行手工拆包，优化首屏缓存与路由切换体验。
 */
/// <reference path="./src/types/unplugin-vue-components-vite.d.ts" />
import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { shortenHtml2pdfModuleIds } from './scripts/html2pdf-module-id-shortener.mjs'

/**
 * 首帧主题脚本构建插件：
 * - `src/theme-init.js` 必须以同步经典脚本在首帧前执行（CSP 禁止内联，`type="module"` 又会延后执行），
 *   Vite 不会打包非 module 脚本，因此由本插件单独产出；
 * - Nginx 对所有 `.js` 设置一年 `immutable` 长缓存，固定文件名会让脚本更新后浏览器仍执行旧版本，
 *   所以构建时按内容哈希输出到 `assets/theme-init-<hash>.js`，并把 HTML 中的引用改写为该文件；
 * - `pre` 阶段先把标签替换为占位注释，避免 Vite 对“非 module 脚本无法打包”告警；`post` 阶段再写回哈希地址；
 * - 开发态不做处理，由 Vite 直接按 `/src/theme-init.js` 提供源码。
 */
const THEME_INIT_SOURCE_URL = '/src/theme-init.js'
const THEME_INIT_PLACEHOLDER = '<!-- ylink-theme-init-script -->'
const THEME_INIT_TAG_PATTERN = /<script\s+src=["']\/src\/theme-init\.js["']\s*><\/script>/

/** 仅在生产构建时压缩已核验供应商包的内部模块 ID；不改变 PDF 实现和外部 html2canvas 导入。 */
const html2pdfModuleIdPlugin = (): Plugin => {
  let transformedCount = 0
  let verifiedOnce = false
  return {
    name: 'ylink-html2pdf-module-id-shortener',
    enforce: 'pre',
    apply: 'build',
    // watch 重建可复用已转换模块的缓存：每轮重置重复计数，但保留首次成功验证标记。
    buildStart() {
      transformedCount = 0
    },
    transform(code, id) {
      const normalizedId = id.replaceAll('\\', '/').split('?')[0]
      if (!normalizedId.includes('/node_modules/html2pdf.js/')) return null
      if (!normalizedId.endsWith('/node_modules/html2pdf.js/dist/html2pdf.js')) {
        throw new Error(`html2pdf.js 构建入口已变化，拒绝未经复核的模块 ID 转换：${normalizedId}`)
      }
      transformedCount += 1
      if (transformedCount !== 1) throw new Error('html2pdf.js 构建入口重复处理，拒绝转换')
      const result = shortenHtml2pdfModuleIds(code)
      verifiedOnce = true
      return { code: result.code, map: null }
    },
    buildEnd(error) {
      if (!error && !verifiedOnce) throw new Error('构建未发现预期 html2pdf.js 入口，拒绝静默跳过模块 ID 转换')
    },
  }
}

const themeInitScriptPlugin = (): Plugin[] => {
  let publicBase = '/'
  let assetsDir = 'assets'
  let emittedFileName = ''
  let emittedSource = ''

  return [
    {
      name: 'ylink-theme-init-script',
      apply: 'build',
      configResolved(config) {
        publicBase = config.base
        assetsDir = config.build.assetsDir
      },
      buildStart() {
        const sourcePath = fileURLToPath(new URL(`.${THEME_INIT_SOURCE_URL}`, import.meta.url))
        this.addWatchFile(sourcePath)
        // 头部维护注释只服务于源码阅读，产物中去掉以减小首屏同步脚本体积。
        emittedSource = readFileSync(sourcePath, 'utf8').replace(/^\/\*[\s\S]*?\*\/\s*/, '')
        const contentHash = createHash('sha256').update(emittedSource).digest('hex').slice(0, 10)
        emittedFileName = `${assetsDir}/theme-init-${contentHash}.js`
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: emittedFileName, source: emittedSource })
      },
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace(THEME_INIT_TAG_PATTERN, THEME_INIT_PLACEHOLDER),
      },
    },
    {
      name: 'ylink-theme-init-script:html-post',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler: (html) =>
          html.replace(THEME_INIT_PLACEHOLDER, `<script src="${publicBase}${emittedFileName}"></script>`),
      },
    },
  ]
}

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
    // `@vue/runtime-*` 也必须显式归入框架块；否则图表组件依赖 Vue 时，
    // Rolldown 可能把运行时吸进 charting，最终迫使入口 HTML 预加载整包 ECharts。
    packageNames: ['vue', '@vue', 'vue-router', 'pinia'],
  },
  {
    chunkName: 'ui-kit',
    packageNames: ['element-plus', '@element-plus', '@vueuse', 'dayjs'],
  },
  {
    // 入口长期使用的 HTTP 客户端保留稳定 vendor 名称；其余未命中的依赖交给 Rolldown 按动态调用图拆分。
    chunkName: 'vendor',
    packageNames: ['axios'],
  },
  {
    chunkName: 'charting',
    // 只把纯 ECharts 引擎放入低频重包；vue-echarts 留给动态 BaseEChart 路由块，
    // 避免其 Vue 组件包装层把渲染运行时重新导出到 charting 并污染入口依赖图。
    packageNames: ['echarts', 'zrender'],
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
    // 条码标签打印仅在打印弹窗打开时动态加载。
    chunkName: 'barcode',
    packageNames: ['jsbarcode'],
  },
  {
    chunkName: 'image-tools',
    packageNames: ['browser-image-compression'],
  },
]

/**
 * Element Plus 首屏核心组件目录（`element-plus/es/components/<目录名>/`）：
 * - 只收录入口同步链路真实用到的组件及其内部依赖：App.vue 的 el-config-provider、全局维护横幅的 el-alert、
 *   main.ts 的 v-loading 指令、全局提示与错误弹窗使用的 ElMessage / ElMessageBox（后者内部依赖 button、input、
 *   overlay、focus-trap 等）；
 * - 其余组件的 JS 归入按需加载的 `ui-extended` 块，不再随入口 HTML 预加载；
 * - 新增“入口同步渲染”的 Element Plus 组件时必须补进本清单，否则 `ui-extended` 会被拉进首屏依赖图，
 *   构建预算脚本会以“低频重包进入首屏”判定失败。
 */
const ELEMENT_PLUS_CORE_COMPONENTS = new Set([
  'config-provider',
  'alert',
  'message',
  'message-box',
  'loading',
  'icon',
  'badge',
  'button',
  'input',
  'overlay',
  'focus-trap',
  'form',
])

const ELEMENT_PLUS_COMPONENT_PATTERN = /\/node_modules\/element-plus\/es\/components\/([^/]+)\/(.*)$/

/**
 * Element Plus 分层拆包：
 * - 组件样式（`components/<name>/style/*` 与 `theme-chalk/*.css`）一律留在 `ui-kit`：
 *   ui-kit.css 随入口加载并排在 main.css 之前，全局样式对 Element Plus 的覆盖依赖这一层叠顺序；
 *   若样式跟随路由懒加载，会以同等优先级反向覆盖全局定制，造成全站样式回归；
 * - 首屏核心组件 JS 留在 `ui-kit`，其余组件 JS（表格、树、日期、上传等）归入 `ui-extended`，
 *   由首个用到它们的路由按需加载，避免客户端商城等首屏为管理端组件付出下载与解析成本；
 * - utils / hooks / locale 等公共层不在 components 目录下，继续按包规则留在 `ui-kit`。
 */
const resolveElementPlusChunk = (normalizedId: string) => {
  const componentMatch = normalizedId.match(ELEMENT_PLUS_COMPONENT_PATTERN)
  if (!componentMatch) {
    return undefined
  }

  const [, componentName, restPath] = componentMatch
  if (restPath.startsWith('style/') || ELEMENT_PLUS_CORE_COMPONENTS.has(componentName)) {
    return 'ui-kit'
  }

  return 'ui-extended'
}

/** 只对 node_modules 内的依赖做手工归组；业务源码交给 Rolldown 按路由懒加载关系自动拆分。 */
const resolveNodeModuleChunk = (id: string) => {
  const normalizedId = id.replaceAll('\\', '/')
  if (!normalizedId.includes('/node_modules/')) {
    return undefined
  }

  return resolveVendorChunk(normalizedId)
}

const resolveVendorChunk = (normalizedId: string) => {
  const elementPlusChunk = resolveElementPlusChunk(normalizedId)
  if (elementPlusChunk) {
    return elementPlusChunk
  }

  for (const rule of VENDOR_CHUNK_RULES) {
    if (rule.packageNames.some((packageName) => normalizedId.includes(`/node_modules/${packageName}/`))) {
      return rule.chunkName
    }
  }

  return undefined
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
      ...themeInitScriptPlugin(),
      html2pdfModuleIdPlugin(),
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
        // Web CI 仅安装根依赖，不创建 npm workspace 链接；共享校验源码需在该模式下直接参与解析。
        '@ylink/validation': fileURLToPath(new URL('./packages/validation/src', import.meta.url)),
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
      // 恢复 Vite 的静态依赖预加载，让入口和当前路由所需的公共块并行下载；
      // charting/pdf/扫码等重包仍由独立动态路由引用，不会写入入口 HTML 的 preload 列表。
      modulePreload: true,
      // 页面样式跟随异步路由拆分，避免管理端低频工作台 CSS 阻塞客户端商城首屏。
      cssCodeSplit: true,
      rollupOptions: {
        // 独立救援入口不能经过普通 App 的路由、Store 或鉴权初始化；保留多 HTML 入口让 Vite 为其构建独立依赖图。
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          rescue: fileURLToPath(new URL('./rescue.html', import.meta.url)),
        },
        output: {
          /**
           * 依赖分组按优先级认领模块：
           * - Rolldown 的分组默认会把“被认领模块的依赖”一并递归收入同组；若只用单个 manualChunks 函数，
           *   各返回名按首次出现顺序认领，`ui-extended` 先出现时会把 Element Plus 公共 utils/hooks、图标与 dayjs
           *   一起吸走，入口反而被迫预加载整个 `ui-extended`；
           * - 因此显式设定优先级：framework 最先认领 Vue 运行时，ui-kit 其次认领 Element Plus 公共层、
           *   首屏核心组件与全部组件样式，其余依赖规则（含 ui-extended 与各低频重包）最后按原逻辑认领。
           */
          codeSplitting: {
            groups: [
              {
                name: 'framework',
                priority: 30,
                test: (id: string) => resolveNodeModuleChunk(id) === 'framework',
              },
              {
                name: 'ui-kit',
                priority: 20,
                test: (id: string) => resolveNodeModuleChunk(id) === 'ui-kit',
              },
              {
                name: (id: string) => {
                  const chunkName = resolveNodeModuleChunk(id)
                  return chunkName && chunkName !== 'framework' && chunkName !== 'ui-kit' ? chunkName : null
                },
                priority: 10,
              },
            ],
          },
        },
      },
    },
  }
})
