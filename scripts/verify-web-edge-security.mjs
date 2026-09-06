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
}
for (const file of ['compose.yml', 'compose.mysql.yml', 'compose.cloud.yml']) {
  const source = readFileSync(file, 'utf8')
  const backend = source.slice(source.indexOf('  backend:'), source.indexOf('  frontend:'))
  assert.doesNotMatch(backend, /^    ports:/m, `${file} 默认不公开后端端口`)
  assert.match(backend, /Y_LINK_TRUST_PROXY/)
  assert.match(source, /ipv4_address: \$\{Y_LINK_FRONTEND_PROXY_IP/)
}
console.log('[web-edge-security] 代理头覆盖、HTML安全头与端口静态契约通过')
