import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const nginxConfigPath = 'docker/nginx/onebox.conf'
const source = readFileSync(nginxConfigPath, 'utf8')

// 按语句分隔符建立块的父子关系。引号内的 CSP、JSON 和正则保持为一个参数。
const blocks = []
const stack = [{ directives: [] }]
let statement = []
for (const [token] of source.matchAll(/#[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]|(?:\\.|\$\{[^}\r\n]+\}|[^\s{};#"'])+/g)) {
  if (token.startsWith('#')) continue
  if (token === '{') {
    const block = { declaration: statement.join(' '), parent: stack.at(-1), directives: [] }
    blocks.push(block)
    stack.push(block)
  } else if (token === ';') {
    stack.at(-1).directives.push(statement.join(' '))
  } else if (token === '}') {
    assert.ok(stack.length > 1 && statement.length === 0, `${nginxConfigPath} 的块结束位置异常`)
    stack.pop()
  } else {
    statement.push(token)
    continue
  }
  statement = []
}
assert.equal(stack.length, 1, `${nginxConfigPath} 存在未闭合的块`)

const findBlockDirectives = (declaration) => {
  const block = blocks.find((candidate) => candidate.declaration === declaration)
  assert.ok(block, `${nginxConfigPath} 缺少 ${declaration}`)
  return block.directives.map((directive) => `${directive};`).join('\n')
}

assert.match(
  source,
  /location\s+=\s+\/uploads\/\s*\{\s*return\s+404;\s*\}/,
  'onebox 必须继续拒绝访问 /uploads/ 目录索引',
)

// 私有附件边界：只有公开商品图目录允许 Nginx 直出，client-feedback 与 .tmp 必须经 Node 鉴权/拒绝。
const genericUploadBlock = findBlockDirectives('location ^~ /uploads/')
assert.doesNotMatch(genericUploadBlock, /^(?:root|alias|try_files) /m, 'onebox 通用 /uploads/ 不得由 Nginx 直接读取磁盘，否则会公开反馈私有附件')
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
for (const { declaration, directives } of blocks) {
  if (!declaration.startsWith('location ') || !declaration.includes('client-feedback')) continue
  assert.ok(!directives.some((line) => /^(?:root|alias|try_files) /.test(line)), 'onebox 不得直出 client-feedback 附件目录')
}

const uploadBlock = findBlockDirectives('location ^~ /uploads/products/')
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

const fallbackBlock = findBlockDirectives('location @uploads_backend')
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
const upstreamBlock = findBlockDirectives('upstream ylink_backend')
assert.match(upstreamBlock, /server\s+127\.0\.0\.1:__BACKEND_PORT__;/, 'onebox 上游必须指向容器回环地址上的 Node 后端')
assert.match(upstreamBlock, /keepalive\s+\d+;/, 'onebox 上游缺少 keepalive 连接池')
const upstreamIdleTimeout = /keepalive_timeout\s+(\d+)s;/.exec(upstreamBlock)
assert.ok(upstreamIdleTimeout && Number(upstreamIdleTimeout[1]) < 65, 'onebox 上游空闲超时必须小于 Node keepAliveTimeout（65 秒）')
// 请求头和响应头都是按指令组继承，子块新增单个头会使父块同组指令失效。
const findEffectiveDirectives = (block, matchesGroup) => {
  for (let scope = block; scope; scope = scope.parent) {
    if (scope.directives.some(matchesGroup)) return scope.directives
  }
  return []
}
const proxySecurityHeaders = 'include /etc/nginx/ylink/proxy-security-headers.conf'
const pageSecurityHeaders = 'include /etc/nginx/ylink/page-security-headers.conf'
for (const block of blocks.filter(({ declaration }) => declaration.startsWith('location '))) {
  const proxyPass = block.directives.find((line) => line.startsWith('proxy_pass '))
  if (!proxyPass) continue
  const { declaration } = block
  assert.match(proxyPass, /^proxy_pass http:\/\/ylink_backend(?:\/\S*)?$/, `${declaration} 必须经 ylink_backend 上游复用长连接`)
  const versionScope = findEffectiveDirectives(block, (line) => line.startsWith('proxy_http_version '))
  assert.ok(versionScope.includes('proxy_http_version 1.1'), `${declaration} 上游长连接要求 HTTP/1.1`)
  const requestHeaders = findEffectiveDirectives(block, (line) => line.startsWith('proxy_set_header '))
  const expectedHeaders = ['Connection ""', 'Host $host', 'X-Forwarded-Host $host',
    'X-Forwarded-For $remote_addr', 'X-Forwarded-Proto $ylink_forwarded_proto']
  if (declaration !== 'location = /health') expectedHeaders.push('X-Real-IP $remote_addr')
  for (const header of expectedHeaders) {
    assert.ok(requestHeaders.includes(`proxy_set_header ${header}`), `${declaration} 缺少有效的上游请求头 ${header}`)
  }
  const responseHeaders = findEffectiveDirectives(block, (line) =>
    line.startsWith('add_header ') || line === proxySecurityHeaders || line === pageSecurityHeaders)
  assert.ok(responseHeaders.includes(proxySecurityHeaders), `${declaration} 缺少有效的代理响应安全头`)
}

console.log('[verify:onebox:uploads] onebox 上传资源直出配置验证通过（仅商品图直出，私有附件经后端，上游长连接复用）')
