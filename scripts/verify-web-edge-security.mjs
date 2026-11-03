/** 静态验证容器代理和 HTML 响应头边界；运行期另由隔离容器 HTTP 验收覆盖。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

for (const file of ['docker/nginx/default.conf', 'docker/nginx/default.conf.template', 'docker/nginx/onebox.conf']) {
  const source = readFileSync(file, 'utf8')
  assert.doesNotMatch(source, /set_real_ip_from\s+(?:10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16)/, `${file} 不得默认信任全部私网`)
  assert.doesNotMatch(source, /proxy_add_x_forwarded_for/, `${file} 应覆盖客户端自带的 XFF 链`)
  assert.match(source, /proxy_set_header X-Forwarded-Proto \$ylink_forwarded_proto;/)
  assert.match(source, /proxy_set_header X-Forwarded-Host \$host;/)
  assert.match(source, /include \/etc\/nginx\/ylink\/edge-protocol\.conf;/)
  for (const body of source.matchAll(/^    location[^\n]*\{\r?\n([\s\S]*?)^    \}/gm)) {
    if (!body[1].includes('proxy_pass')) continue
    assert.match(body[1], /include \/etc\/nginx\/ylink\/proxy-security-headers\.conf;/,
      `${file} 代理响应必须由上游保留 API/上传专用 CSP，禁止继承页面 CSP 或重复 HSTS`)
  }
  const htmlLocations = file.endsWith('.template')
    ? ['location = /index.html', 'location / {']
    : ['location = /index.html', 'location = / {', 'location ~ ^/(?:database-rescue|login']
  for (const needle of htmlLocations) {
    const offset = source.indexOf(needle)
    assert.ok(offset >= 0, `${file} 缺少 HTML 入口 ${needle}`)
    const body = source.slice(offset, source.indexOf('\n    }', offset))
    assert.match(body, /include \/etc\/nginx\/ylink\/page-security-headers\.conf;/, `${file} ${needle} 必须显式包含页面头`)
  }
  // 边缘限流、连接上限与请求体上限：三套配置口径一致，超限统一返回 JSON。
  for (const zone of ['ylink_auth_login', 'ylink_auth_captcha', 'ylink_auth_sensitive', 'ylink_api_general']) {
    assert.match(source, new RegExp(`limit_req_zone \\$binary_remote_addr zone=${zone}:`), `${file} 缺少限流区 ${zone}`)
  }
  assert.match(source, /limit_conn_zone \$binary_remote_addr zone=ylink_conn_per_ip:/, `${file} 缺少每 IP 连接区`)
  for (const directive of [
    /^    limit_req_status 429;$/m,
    /^    limit_conn_status 429;$/m,
    /^    limit_conn ylink_conn_per_ip \d+;$/m,
    /^    client_max_body_size 1m;$/m,
    /^    error_page 429 = @ylink_too_many_requests;$/m,
    /^    error_page 413 = @ylink_payload_too_large;$/m,
  ]) {
    assert.match(source, directive, `${file} 缺少 server 级边缘约束 ${directive}`)
  }
  const blockOf = (declaration) => {
    const offset = source.indexOf(`    ${declaration} {\n`)
    assert.ok(offset >= 0, `${file} 缺少 ${declaration}`)
    return source.slice(offset, source.indexOf('\n    }', offset))
  }
  for (const [name, reason] of [['@ylink_too_many_requests', 'EDGE_RATE_LIMITED'], ['@ylink_payload_too_large', 'EDGE_PAYLOAD_TOO_LARGE']]) {
    const body = blockOf(`location ${name}`)
    assert.match(body, /default_type application\/json;/, `${file} ${name} 必须返回 JSON`)
    assert.ok(body.includes(`"reason":"${reason}"`), `${file} ${name} 缺少稳定原因码 ${reason}`)
  }
  for (const [path, zone] of [
    ['/api/auth/login', 'ylink_auth_login'],
    ['/api/client-auth/login', 'ylink_auth_login'],
    ['/api/auth/login/mfa', 'ylink_auth_login'],
    ['/api/auth/captcha', 'ylink_auth_captcha'],
    ['/api/client-auth/captcha', 'ylink_auth_captcha'],
    ['/api/client-auth/register', 'ylink_auth_sensitive'],
    ['/api/client-auth/verification-code/send', 'ylink_auth_sensitive'],
    ['/api/client-auth/forgot-password/verify', 'ylink_auth_sensitive'],
    ['/api/client-auth/forgot-password/reset', 'ylink_auth_sensitive'],
  ]) {
    const body = blockOf(`location = ${path}`)
    assert.match(body, new RegExp(`limit_req zone=${zone} `), `${file} ${path} 必须使用 ${zone} 限流区`)
    assert.match(body, /client_max_body_size 64k;/, `${file} ${path} 认证入口请求体上限应为 64k`)
  }
  for (const declaration of ['location = /api/upload', 'location = /api/client-feedback/attachments', 'location ^~ /api/products/import', 'location ^~ /api/system-configs/client-staff-directory/import']) {
    const body = blockOf(declaration)
    // 整个 multipart 请求体含边界与字段头，必须略高于后端 10MB 文件上限。
    assert.match(body, /client_max_body_size 11m;/, `${file} ${declaration} 上传/导入入口应放宽到 11m`)
    assert.match(body, /limit_req zone=ylink_api_general /, `${file} ${declaration} 应计入通用限流`)
  }
  assert.match(blockOf('location ^~ /api/'), /limit_req zone=ylink_api_general burst=\d+ nodelay;/, `${file} /api/ 缺少通用每 IP 限流`)
  assert.match(blockOf('location ^~ /uploads/'), /limit_req zone=ylink_api_general burst=\d+ nodelay;/, `${file} /uploads/ 缺少通用每 IP 限流`)
  // “变量 + URI”的 proxy_pass 会让 Nginx 用 URI 整体替换请求路径并丢弃查询参数（/api/orders?page=2 被转成 /api/），必须使用具名 upstream 或字面地址。
  assert.doesNotMatch(source, /proxy_pass\s+https?:\/\/\$[A-Za-z_]+\/[^;]*;/, `${file} 禁止在 proxy_pass 中同时使用变量与 URI`)
  // 压缩：优先发送构建期预压缩产物，且 JS 的两种 MIME 写法都要覆盖。
  assert.match(source, /^    gzip_static on;$/m, `${file} 缺少 gzip_static`)
  for (const mime of ['application/javascript', 'text/javascript', 'image/svg+xml', 'application/json']) {
    assert.match(source, new RegExp(`gzip_types[\\s\\S]*?${mime.replace('+', '\\+')}[\\s\\S]*?;`), `${file} gzip_types 缺少 ${mime}`)
  }
  // 未带哈希的站点图标不得按 immutable 缓存一年，且该规则必须位于通用静态资源正则之前。
  const iconLocation = source.indexOf('location ~ ^/(?:favicon\\.ico|y-link-icon\\.png|apple-touch-icon\\.png|icons\\.svg)$')
  const assetLocation = source.indexOf('location ~* \\.(?:css|js|mjs|json|map|svg|ico|png|jpe?g|webp|gif|woff2?|ttf|otf|eot)$')
  assert.ok(iconLocation >= 0 && iconLocation < assetLocation, `${file} 站点图标缓存规则缺失或顺序错误`)
  assert.doesNotMatch(source.slice(iconLocation, source.indexOf('\n    }', iconLocation)), /immutable/, `${file} 站点图标不得声明 immutable`)
  if (!file.endsWith('.template')) {
    const pagePattern = source.match(/location ~ (\^\/\(\?:database-rescue\|login\S+) \{/)
    assert.ok(pagePattern, `${file} 缺少页面路由白名单`)
    const pageRoute = new RegExp(pagePattern[1])
    assert.ok(pageRoute.test('/reports'), `${file} 报表中心直链和刷新必须进入 SPA`)
    for (const path of ['/inventory', '/inventory/overview', '/inventory/scan', '/inventory/stocks', '/inventory/stocktakes',
      '/inventory/stocktakes/123', '/inventory/docs', '/inventory/logs', '/inventory/master-data']) {
      assert.ok(pageRoute.test(path), `${file} 库存路由 ${path} 直链和刷新必须进入 SPA`)
    }
    for (const path of ['/.env', '/unknown-route', '/reports.json', '/reports-malicious',
      '/inventory/unknown', '/inventory/.env', '/inventory/overview/extra', '/inventory/overview.json',
      '/inventory/stocktakes/abc', '/inventory/stocktakes/123/extra']) {
      assert.ok(!pageRoute.test(path), `${file} 不应把未知路径 ${path} 放行到 SPA`)
    }
  }
}
// 分体模板：后端走具名 upstream（运行期解析 + keepalive），商品图边缘缓存不得覆盖私有反馈附件。
const splitTemplate = readFileSync('docker/nginx/default.conf.template', 'utf8')
assert.match(splitTemplate, /upstream ylink_backend \{[\s\S]*?server backend:3001 resolve;[\s\S]*?keepalive \d+;[\s\S]*?\}/, '分体模板需使用带 resolve 与 keepalive 的具名 upstream')
const productImageBlock = splitTemplate.slice(splitTemplate.indexOf('location ^~ /uploads/products/'), splitTemplate.indexOf('\n    }', splitTemplate.indexOf('location ^~ /uploads/products/')))
assert.match(productImageBlock, /proxy_cache ylink_product_images;/, '分体模板商品图需启用边缘缓存')
assert.match(productImageBlock, /proxy_ignore_headers Cache-Control Expires;/, '商品图边缘有效期不能被上游一年缓存头覆盖')
assert.match(productImageBlock, /proxy_cache_valid 200 7d;/, '商品图边缘有效期应为七天')
assert.doesNotMatch(productImageBlock, /proxy_ignore_headers[^;]*(?:Set-Cookie|Vary)/i, '不得忽略上游缓存安全控制')
assert.doesNotMatch(splitTemplate, /location \^~ \/uploads\/client-feedback\/[\s\S]*?proxy_cache/, '私有反馈附件不得进入边缘缓存')
const pageHeaders = readFileSync('docker/nginx/page-security-headers.conf', 'utf8')
const connectSources = pageHeaders.match(/connect-src\s+([^;]+);/)
assert.ok(connectSources, '页面 CSP 必须显式约束网络连接来源')
assert.deepEqual(connectSources[1].trim().split(/\s+/).sort(), ["'self'", 'https://v1.hitokoto.cn'].sort(),
  '页面只允许同源请求和现有 HTTPS 语录服务，禁止通配放开外部连接')
for (const file of ['compose.yml', 'compose.mysql.yml', 'compose.cloud.yml']) {
  const source = readFileSync(file, 'utf8')
  const backend = source.slice(source.indexOf('  backend:'), source.indexOf('  frontend:'))
  assert.doesNotMatch(backend, /^    ports:/m, `${file} 默认不公开后端端口`)
  assert.match(backend, /Y_LINK_TRUST_PROXY/)
  assert.match(source, /ipv4_address: \$\{Y_LINK_FRONTEND_PROXY_IP/)
}
console.log('[web-edge-security] 代理头覆盖、HTML安全头、端口静态契约、边缘限流/连接/请求体上限、代理路径改写与静态缓存/压缩策略通过')
