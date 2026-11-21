/** 生产产物专用浏览器验收宿主：只读当前dist/本批起点assets，不启动构建或连接数据库。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import QRCode from 'qrcode'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const task = path.join(root, '.tmp-restock-implementation/performance-convergence')
const directories = { baseline: path.join(task, 'baseline-dist/assets'), current: path.join(root, 'dist/assets') }
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const compiled = {}
for (const [name, directory] of Object.entries(directories)) {
  compiled[name] = {}
  for (const prefix of ['barcode', 'qr-scanner']) {
    const files = fs.readdirSync(directory).filter((file) => file.startsWith(`${prefix}-`) && file.endsWith('.js'))
    assert.equal(files.length, 1, `${name}的${prefix}应只有一个真实chunk`)
    compiled[name][prefix] = { url: `/${name}/assets/${files[0]}`, sha256: hash(fs.readFileSync(path.join(directory, files[0]))) }
  }
}
const qrText = 'YLINK-PRODUCTION-QR-20261027'
const qrImage = await QRCode.toBuffer(qrText, { width: 480, margin: 4, errorCorrectionLevel: 'M' })
const port = Number(process.env.PERFORMANCE_SMOKE_PORT || '5519')
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536)
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'POST' && url.pathname === '/result') {
      let body = ''
      for await (const chunk of request) { body += chunk; if (body.length > 64000) throw new Error('结果过大') }
      const result = JSON.parse(body)
      assert.ok(['passed', 'failed'].includes(result.status))
      fs.writeFileSync(path.join(task, 'compiled-browser-module-results.json'), JSON.stringify({ ...result, compiled, receivedAt: new Date().toISOString() }, null, 2) + '\n')
      response.end('ok'); return
    }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>生产重模块回归</title><h1>生产编译产物真实算法回归</h1><pre id="result">运行中</pre><div id="artifacts"></div><script type="module" src="/smoke.mjs"></script></html>'); return
    }
    if (url.pathname === '/smoke.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(root, 'scripts/performance-compiled-smoke.browser.mjs'))); return }
    if (url.pathname === '/manifest.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ compiled, qrText })); return }
    if (url.pathname === '/qr.png') { response.setHeader('Content-Type', 'image/png'); response.end(qrImage); return }
    const match = /^\/(baseline|current)\/assets\/([^/]+)$/.exec(url.pathname)
    if (!match || !/^[\w.-]+$/.test(match[2])) { response.writeHead(404); response.end(); return }
    const file = path.join(directories[match[1]], match[2])
    if (!fs.existsSync(file)) { response.writeHead(404); response.end(); return }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css')
    response.end(fs.readFileSync(file))
  } catch (error) { response.writeHead(500); response.end(String(error.message)) }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
console.log(`生产重模块真实浏览器入口：http://127.0.0.1:${port}；仅提供编译资源，无账号或数据库`)
const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
