/** 身份切换顺序与失败即停契约；仅模拟 Node 身份 API，不改变执行测试的宿主身份。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dropOneboxIdentity } from '../docker/onebox/backend-launcher.mjs'

const passwd = 'root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000:node:/home/node:/bin/sh\n'
function fixture() {
  const calls = [], state = { uid: 0, gid: 0, groups: [0, 20] }
  const identity = {
    setgroups: groups => { calls.push(['groups', groups]); state.groups = [...groups] },
    setgid: gid => { calls.push(['gid', gid]); state.gid = gid },
    setuid: uid => { calls.push(['uid', uid]); state.uid = uid },
    getuid: () => state.uid, geteuid: () => state.uid,
    getgid: () => state.gid, getegid: () => state.gid,
    getgroups: () => state.groups,
  }
  return { identity, calls, state }
}
test('先清补充组再 GID/UID，核验后只保留非 root 身份', () => {
  const f = fixture()
  assert.deepEqual(dropOneboxIdentity(f.identity, passwd), { uid: 1000, gid: 1000 })
  assert.deepEqual(f.calls, [['groups', []], ['gid', 1000], ['uid', 1000]])
})
test('node 账号缺失、映射 root、API 缺失与系统拒绝均中止', () => {
  for (const text of ['', 'node:x:0:0:node:/home/node:/bin/sh', 'node:x:NaN:1000:n:/x:/bin/sh']) assert.throws(() => dropOneboxIdentity(fixture().identity, text))
  const f = fixture()
  delete f.identity.setgroups
  assert.throws(() => dropOneboxIdentity(f.identity, passwd), /API/)
  for (const method of ['setgroups', 'setgid', 'setuid']) {
    const broken = fixture()
    broken.identity[method] = () => { throw new Error('EPERM fixture') }
    assert.throws(() => dropOneboxIdentity(broken.identity, passwd), /EPERM/)
    assert.ok(!broken.calls.some(([name, value]) => name === 'uid' && value === 0), '失败不得尝试回退 root')
  }
})
test('API 调用返回但实际身份/补充组未切换也必须中止', () => {
  const f = fixture()
  f.identity.setgroups = () => {}
  assert.throws(() => dropOneboxIdentity(f.identity, passwd), /DROP_FAILED/)
})

test('引导失败输出公开分类并隐藏无效开关原值', () => {
  const launcher = fileURLToPath(new URL('../docker/onebox/backend-launcher.mjs', import.meta.url))
  const invalidFlag = 'invalid-onebox-flag-fixture'
  const result = spawnSync(process.execPath, [launcher], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', Y_LINK_ONEBOX_NON_ROOT: invalidFlag },
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /\[ONEBOX_NON_ROOT_FLAG_INVALID\]/)
  assert.ok(!result.stderr.includes(invalidFlag))
})

test('权限预检不提前解释损坏override或缓存恢复前MySQL配置', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-permission-order-'))
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const data = path.join(root, 'data'), envFile = path.join(root, 'isolated.env')
  fs.mkdirSync(path.join(data, 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(root, 'uploads'))
  fs.writeFileSync(envFile, '', { flag: 'wx' })
  const preflight = new URL('../backend/src/runtime/onebox-permission-preflight.ts', import.meta.url).href
  const envModule = new URL('../backend/src/config/env.ts', import.meta.url).href
  // 本最小回归仅模拟身份 API 来检查模块求值顺序；真实降权和稳定救援另由容器用例验证。
  const script = `import fs from 'node:fs';import assert from 'node:assert/strict';process.getuid=()=>1000;process.geteuid=()=>1000;process.chdir(${JSON.stringify(root)});const file=${JSON.stringify(path.join(data, 'runtime/database-runtime-override.json'))};const write=config=>fs.writeFileSync(file,JSON.stringify({version:1,updatedAt:new Date().toISOString(),config}));fs.writeFileSync(file,'{');const p=await import(${JSON.stringify(preflight)});await p.assertOneboxVolumePermissions();write({DB_TYPE:'mysql',DB_HOST:'127.0.0.1',DB_PORT:1,DB_USER:'fixture',DB_PASSWORD:'fixture-only',DB_NAME:'fixture',DB_SYNC:false});await p.assertOneboxVolumePermissions();write({DB_TYPE:'sqlite',SQLITE_DB_PATH:${JSON.stringify(path.join(data, 'effective.sqlite'))},DB_SYNC:false});await p.assertEffectiveOneboxSqlitePermissions();const {env}=await import(${JSON.stringify(envModule)});assert.equal(env.DB_TYPE,'sqlite');assert.equal(env.SQLITE_DB_PATH,${JSON.stringify(path.join(data, 'effective.sqlite'))});assert.equal(fs.existsSync(env.SQLITE_DB_PATH),false);console.log('permission-order-ok');`
  try {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(repo, 'backend/node_modules/tsx/dist/loader.mjs')).href, '--input-type=module', '-e', script], {
      cwd: repo, windowsHide: true, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, NODE_ENV: 'test', APP_PROFILE: 'permission-order-fixture', ENV_FILE: envFile,
        Y_LINK_DATA_DIR: data, SQLITE_DB_PATH: path.join(data, 'base.sqlite'), DB_TYPE: 'sqlite', DB_SYNC: 'false',
        Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'false', Y_LINK_ONEBOX_NON_ROOT: 'true', REDIS_URL: '',
        Y_LINK_OUTBOUND_REDIRECT_POLICY: 'compat', Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS: '[]' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /permission-order-ok/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
