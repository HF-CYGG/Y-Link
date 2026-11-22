/** 真实镜像负例：独占旧式 root 私有卷必须失败，前后 owner/mode/内容保持原状，不碰业务卷。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const image = process.env.Y_LINK_VERIFY_IMAGE, platform = process.env.Y_LINK_VERIFY_PLATFORM
const evidence = process.env.Y_LINK_VERIFY_EVIDENCE_DIR
assert.ok(image && /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image) && evidence)
assert.ok(['linux/amd64', 'linux/arm64'].includes(platform))
fs.mkdirSync(evidence, { recursive: true })
const owner = randomBytes(12).toString('hex'), volume = `ylink-private-${owner}`, name = `ylink-refusal-${owner}`
const password = randomBytes(24).toString('base64url') + 'Aa1!'
const run = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, `独占 Docker 操作失败（${result.error?.code ?? result.status}）`)
  return result.stdout.trim()
}
const snapshot = `const fs=require('node:fs'),crypto=require('node:crypto');const out=[];function walk(p){const s=fs.statSync(p);out.push({path:p,uid:s.uid,gid:s.gid,mode:s.mode&4095,sha256:s.isFile()?crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null});if(s.isDirectory())for(const n of fs.readdirSync(p).sort())walk(p+'/'+n)}walk('/fixture');console.log(JSON.stringify(out))`
const helper = (source, readonly = false) => run(['run', '--rm', '--platform', platform, '--network', 'none', '--label', `ylink.verify.owner=${owner}`,
  '--mount', `type=volume,source=${volume},target=/fixture${readonly ? ',readonly' : ''}`, '--entrypoint', 'node', image, '-e', source])
let volumeCreated = false, containerCreated = false
try {
  run(['volume', 'create', '--label', `ylink.verify.owner=${owner}`, volume]); volumeCreated = true
  helper(`const fs=require('node:fs');fs.mkdirSync('/fixture/secrets',{recursive:true,mode:448});fs.writeFileSync('/fixture/secrets/data-encryption.key',Buffer.alloc(32,17).toString('base64'),{flag:'wx',mode:384});fs.chmodSync('/fixture',448)`)
  const before = JSON.parse(helper(snapshot, true))
  assert.ok(before.every(item => item.uid === 0 && item.gid === 0))
  run(['run', '--detach', '--name', name, '--platform', platform, '--network', 'none', '--label', `ylink.verify.owner=${owner}`,
    '--mount', `type=volume,source=${volume},target=/app/data`, '--tmpfs', '/app/uploads', '--env', 'Y_LINK_ONEBOX_NON_ROOT=true',
    '--env', 'Y_LINK_DATA_DIR=/app/data', '--env', 'SQLITE_DB_PATH=/app/data/verify.sqlite', '--env', 'INIT_ADMIN_PASSWORD=' + password,
    '--env', 'NODE_ENV=test', '--env', 'REDIS_URL=', '--env', 'ALIYUN_DYPNS_MNS_ENABLED=false', image]); containerCreated = true
  assert.equal(run(['wait', name]), '1', '旧私有卷必须导致后端失败且 supervisor 退出 1')
  const info = JSON.parse(run(['inspect', name]))[0]
  assert.equal(info.Config.Labels['ylink.verify.owner'], owner)
  assert.equal(info.State.Running, false)
  // docker logs 的后端拒绝消息在 stderr，必须同时检查，不能只凭 stdout 判通过。
  const logResult = spawnSync('docker', ['logs', name], { encoding: 'utf8', windowsHide: true })
  assert.equal(logResult.status, 0)
  assert.match(logResult.stdout + logResult.stderr, /后端引导失败/)
  const after = JSON.parse(helper(snapshot, true))
  assert.deepEqual(after, before, '失败后不得 chown/chmod、重建密钥或创建数据库')
  fs.writeFileSync(path.join(evidence, 'permission-refusal.json'), JSON.stringify({ image, platform, imageId: info.Image, exit: info.State.ExitCode, before, after, result: 'passed' }, null, 2))
  console.log(`[onebox-permission-refusal] ${platform} 旧私有卷失败即停且元数据/内容未改`)
} finally {
  if (containerCreated) {
    const info = JSON.parse(run(['inspect', name]))[0]
    assert.equal(info.Config.Labels['ylink.verify.owner'], owner)
    run(['rm', '--force', name])
  }
  if (volumeCreated) {
    const info = JSON.parse(run(['volume', 'inspect', volume]))[0]
    assert.equal(info.Labels['ylink.verify.owner'], owner)
    run(['volume', 'rm', volume])
  }
}
