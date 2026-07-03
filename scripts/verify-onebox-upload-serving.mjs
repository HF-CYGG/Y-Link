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

const uploadBlock = findLocationBlock('location ^~ /uploads/')
assert.match(uploadBlock, /root\s+\/app;/, 'onebox /uploads/ 应由 Nginx 直接读取 /app/uploads')
assert.match(uploadBlock, /try_files\s+\$uri\s+@uploads_backend;/, 'onebox /uploads/ 缺少后端回落入口')
assert.doesNotMatch(uploadBlock, /proxy_pass/, 'onebox /uploads/ 已存在文件不应再默认代理到 Node 后端')

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
  /proxy_pass\s+http:\/\/127\.0\.0\.1:__BACKEND_PORT__;/,
  'onebox 上传资源回落代理必须保留原始 URI，避免破坏后端旧路径兼容改写',
)
assert.match(fallbackBlock, /proxy_set_header\s+Host\s+\$host;/, '上传资源回落代理缺少 Host 透传')
assert.match(fallbackBlock, /proxy_set_header\s+X-Real-IP\s+\$remote_addr;/, '上传资源回落代理缺少真实 IP 透传')
assert.match(
  fallbackBlock,
  /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/,
  '上传资源回落代理缺少 X-Forwarded-For 透传',
)
assert.match(
  fallbackBlock,
  /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/,
  '上传资源回落代理缺少协议透传',
)

console.log('[verify:onebox:uploads] onebox 上传资源直出配置验证通过')
