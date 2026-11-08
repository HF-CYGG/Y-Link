/** 隔离 lab 的共用启动器：不加载项目配置/env，不代理真实后端，原生 HTTP 独占随机端口。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { code128BarcodePlugin } from './code128-barcode-module.mjs'

export function createLabEvidenceDir(prefix = 'ylink-polish-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export async function startClientPolishServer({ root = process.cwd(), output, plugins = [], readinessRoutes = ['/__polish/state', '/health', '/client/mall', '/src/main.ts'] }) {
  const vite = await createServer({
    root, configFile: false, envDir: false, envPrefix: '__POLISH_UNUSED_',
    cacheDir: path.join(output, 'vite-cache'),
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    plugins: [code128BarcodePlugin(), vue(), Components({ dts: false, resolvers: [ElementPlusResolver({ importStyle: false })] }), ...plugins],
    resolve: { alias: { '@': path.join(root, 'src'), '@ylink/validation': path.join(root, 'packages/validation/src') } },
    server: { host: '127.0.0.1', middlewareMode: true, hmr: false, ws: false, open: false, preTransformRequests: false },
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'pinia', 'element-plus', '@element-plus/icons-vue', 'axios', 'qrcode'] },
  })
  const requests = []
  const server = http.createServer((req, res) => {
    const entry = { path: req.url?.split('?')[0], at: Date.now(), status: null }
    requests.push(entry)
    res.once('finish', () => { entry.status = res.statusCode })
    // 绝不读取真实上传目录；fixture 图片使用 /__polish/images。
    if (req.url?.split('?')[0].startsWith('/uploads')) {
      res.writeHead(404); res.end('隔离 lab 禁止真实上传资源'); return
    }
    vite.middlewares(req, res)
  })
  const close = async () => {
    server.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), vite.close()])
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = 'http://127.0.0.1:' + server.address().port
    // 先证实 fixture 与 HTML 可达，避免打印一个只监听却不能服务的地址。
    const readiness = []
    for (const route of readinessRoutes) {
      const started = Date.now()
      const response = await fetch(origin + route, { signal: AbortSignal.timeout(30000) })
      const body = await response.text()
      if (!response.ok || !body.length) throw Error(`lab 启动探针失败 ${route}: ${response.status}`)
      readiness.push({ route, status: response.status, bytes: Buffer.byteLength(body), elapsedMs: Date.now() - started })
    }
    return { origin, readiness, requests, close, config: { configFile: false, envDir: false, proxy: false, port: server.address().port } }
  } catch (error) { await close(); throw error }
}
