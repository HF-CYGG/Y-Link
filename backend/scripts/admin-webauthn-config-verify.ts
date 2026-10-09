/** WebAuthn 启动配置边界：只测固定 RP/Origin 解析，不连接数据库或外部服务。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const backendRoot = path.resolve(process.cwd())
const launch = (rpId: string, origin: string) => spawnSync(process.execPath, [
  '--import', 'tsx', '-e', "import('./src/config/webauthn.ts').then(()=>process.exit(0)).catch(()=>process.exit(2))",
], {
  cwd: backendRoot,
  env: {
    ...process.env,
    APP_PROFILE: 'admin-webauthn-config-verify',
    ENV_FILE: '',
    DB_TYPE: 'sqlite',
    Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
    AUTH_WEBAUTHN_ENABLED: 'true',
    AUTH_WEBAUTHN_RP_ID: rpId,
    AUTH_WEBAUTHN_RP_NAME: 'Y-Link 验证',
    AUTH_WEBAUTHN_ORIGINS: JSON.stringify([origin]),
  },
  encoding: 'utf8',
})

assert.equal(launch('localhost', 'http://localhost:3000').status, 0, '仅 localhost 可使用 HTTP 开发 Origin')
assert.equal(launch('example.com', 'https://example.com').status, 0, '合法固定 HTTPS Origin 可启动')
for (const [rpId, origin] of [
  ['127.0.0.1', 'https://127.0.0.1'],
  ['127.0.0.1', 'http://127.0.0.1:3000'],
  ['::1', 'https://[::1]'],
  ['example.com', 'https://127.0.0.1'],
]) {
  assert.equal(launch(rpId, origin).status, 2, `必须拒绝 IP RP/Origin：${rpId}`)
}
console.log('[admin-webauthn-config-verify] 固定 RP/Origin 配置边界通过')
