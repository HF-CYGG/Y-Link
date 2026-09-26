/** 文件职责：为正式出库单纸面回归启动隔离 Vite 缓存的本地脱敏样例。 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  cacheDir: 'output/issue112-vite-cache',
  server: { host: '127.0.0.1', port: 5188, strictPort: true, https: false, watch: { ignored: ['**/output/**'] } },
})
