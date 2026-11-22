/** 文件职责：为正式出库单纸面回归启动隔离 Vite 缓存的本地脱敏样例。 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { html2pdfSourcePlugin } from './html2pdf-source-guard.mjs'
import { canvgSourcePlugin } from './canvg-source-guard.mjs'
import { code128BarcodePlugin } from './code128-barcode-module.mjs'

export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  plugins: [html2pdfSourcePlugin(), canvgSourcePlugin(), code128BarcodePlugin(), vue()],
  build: {
    outDir: 'output/voucher-production',
    rollupOptions: { input: [
      fileURLToPath(new URL('./voucher-visual-fixture.html', import.meta.url)),
      fileURLToPath(new URL('./client-voucher-visual-fixture.html', import.meta.url)),
      fileURLToPath(new URL('./pdf-svg-visual-fixture.html', import.meta.url)),
      fileURLToPath(new URL('./pdf-media-visual-fixture.html', import.meta.url)),
    ] },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  cacheDir: 'output/issue112-vite-cache',
  server: { host: '127.0.0.1', port: 5188, strictPort: true, https: false, watch: { ignored: ['**/output/**'] } },
})
