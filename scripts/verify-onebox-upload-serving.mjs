import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const nginxConfigPath = 'docker/nginx/onebox.conf'
const source = readFileSync(nginxConfigPath, 'utf8')

const findLocationBlock = (declaration) => {
  const startIndex = source.indexOf(declaration)
  assert.notEqual(startIndex, -1, `${nginxConfigPath} 缺少 ${declaration}`)

  const openingBraceIndex = source.indexOf('{', startIndex)
  assert.notEqual(openingBraceIndex, -1, `${declaration} 缺少起始花括号`)

  let depth = 0
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') {
      depth += 1
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(openingBraceIndex + 1, index)
      }
    }
  }

  assert.fail(`${declaration} 缺少结束花括号`)
}

assert.match(
  source,
  /location\s+=\s+\/uploads\/\s*\{\s*return\s+404;\s*\}/,
  'onebox 必须继续拒绝访问 /uploads/ 目录索引',
)

// 私有附件边界：只有公开商品图目录允许 Nginx 直出，client-feedback 与 .tmp 必须经 Node 鉴权/拒绝。
const genericUploadBlock = findLocationBlock('location ^~ /uploads/ ')
assert.doesNotMatch(genericUploadBlock, /root|alias|try_files/, 'onebox 通用 /uploads/ 不得由 Nginx 直接读取磁盘，否则会公开反馈私有附件')
assert.match(
  genericUploadBlock,
  /proxy_pass\s+http:\/\/ylink_backend;/,
  'onebox 通用 /uploads/ 必须保留原始 URI 代理到 Node 后端',
)

const directServeDeclarations = [...source.matchAll(/location\s+\^~\s+(\/uploads\/[^\s{]*)\s*\{/g)].map((match) => match[1])
assert.deepEqual(
  directServeDeclarations.sort(),
  ['/uploads/', '/uploads/products/'],
  'onebox 仅允许声明通用 /uploads/ 代理与 /uploads/products/ 直出两个上传 location',
)
assert.doesNotMatch(source, /location[^{]*client-feedback[^{]*\{[^}]*root/, 'onebox 不得直出 client-feedback 附件目录')

const uploadBlock = findLocationBlock('location ^~ /uploads/products/')
assert.match(uploadBlock, /root\s+\/app;/, 'onebox /uploads/products/ 应由 Nginx 直接读取 /app/uploads/products')
assert.match(uploadBlock, /try_files\s+\$uri\s+@uploads_backend;/, 'onebox /uploads/products/ 缺少后端回落入口')
assert.doesNotMatch(uploadBlock, /proxy_pass/, 'onebox /uploads/products/ 已存在文件不应再默认代理到 Node 后端')

for (const [headerName, expectedValue] of [
  ['Cache-Control', '"public, max-age=31536000, immutable"'],
  ['X-Content-Type-Options', '"nosniff"'],
  ['Referrer-Policy', '"strict-origin-when-cross-origin"'],
  ['Cross-Origin-Resource-Policy', '"same-site"'],
  ['Content-Security-Policy', '"default-src \'none\'; img-src \'self\' data:; style-src \'none\'; sandbox"'],
]) {
  assert.match(
    uploadBlock,
    new RegExp(`add_header\\s+${headerName}\\s+${expectedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+always;`),
    `onebox 直出上传资源缺少 ${headerName} 响应头`,
  )
}

const fallbackBlock = findLocationBlock('location @uploads_backend')
assert.match(
  fallbackBlock,
  /proxy_pass\s+http:\/\/ylink_backend;/,
  'onebox 上传资源回落代理必须保留原始 URI，避免破坏后端旧路径兼容改写',
)
assert.match(fallbackBlock, /proxy_set_header\s+Host\s+\$host;/, '上传资源回落代理缺少 Host 透传')
assert.match(fallbackBlock, /proxy_set_header\s+X-Real-IP\s+\$remote_addr;/, '上传资源回落代理缺少真实 IP 透传')
assert.match(
  fallbackBlock,
  /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/,
  '上传资源回落代理缺少 X-Forwarded-For 透传',
)
assert.match(
  fallbackBlock,
  /proxy_set_header\s+X-Forwarded-Proto\s+\$ylink_forwarded_proto;/,
  '上传资源回落代理缺少协议透传',
)

// 上游长连接：所有代理都经 upstream 复用连接，空闲超时必须小于 Node keepAliveTimeout（65 秒）。
const upstreamBlock = findLocationBlock('upstream ylink_backend')
assert.match(upstreamBlock, /server\s+127\.0\.0\.1:__BACKEND_PORT__;/, 'onebox 上游必须指向容器回环地址上的 Node 后端')
assert.match(upstreamBlock, /keepalive\s+\d+;/, 'onebox 上游缺少 keepalive 连接池')
const upstreamIdleTimeout = /keepalive_timeout\s+(\d+)s;/.exec(upstreamBlock)
assert.ok(upstreamIdleTimeout && Number(upstreamIdleTimeout[1]) < 65, 'onebox 上游空闲超时必须小于 Node keepAliveTimeout（65 秒）')
assert.doesNotMatch(source, /proxy_pass\s+http:\/\/127\.0\.0\.1:__BACKEND_PORT__/, 'onebox 所有代理必须经 ylink_backend 上游以复用长连接')
for (const match of source.matchAll(/location[^{]*\{[^}]*proxy_pass\s+http:\/\/ylink_backend[^}]*\}/g)) {
  assert.match(match[0], /proxy_http_version\s+1\.1;/, `上游长连接要求 HTTP/1.1：${match[0].slice(0, 60)}`)
  assert.match(match[0], /proxy_set_header\s+Connection\s+"";/, `上游长连接要求清空 Connection 头：${match[0].slice(0, 60)}`)
}

console.log('[verify:onebox:uploads] onebox 上传资源直出配置验证通过（仅商品图直出，私有附件经后端，上游长连接复用）')
