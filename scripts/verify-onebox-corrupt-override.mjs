/** 非 root + 可读但损坏的 override：真实 Onebox 必须稳定进入独立救援，不初始化业务库。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const image = process.env.Y_LINK_VERIFY_IMAGE, platform = process.env.Y_LINK_VERIFY_PLATFORM, evidence = process.env.Y_LINK_VERIFY_EVIDENCE_DIR
assert.ok(image && /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image) && evidence)
assert.ok(['linux/amd64', 'linux/arm64'].includes(platform))
fs.mkdirSync(evidence, { recursive: true })
const owner = randomBytes(12).toString('hex'), volume = `ylink-corrupt-${owner}`, name = `ylink-rescue-${owner}`
const password = randomBytes(24).toString('base64url') + 'Aa1!'
const run = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, `独占 Docker 操作失败（${result.error?.code ?? result.status}）`)
  return result.stdout.trim()
}
let volumeCreated = false, containerCreated = false
try {
  run(['volume', 'create', '--label', `ylink.verify.owner=${owner}`, volume]); volumeCreated = true
  // 仅为本次新建空卷准备 UID/GID；从不读取、接入或调整已有业务卷。
  const identity = JSON.parse(run(['run', '--rm', '--platform', platform, '--network', 'none', '--label', `ylink.verify.owner=${owner}`,
    '--mount', `type=volume,source=${volume},target=/fixture`, '--entrypoint', 'node', image, '-e',
    "const fs=require('node:fs');const a=fs.readFileSync('/etc/passwd','utf8').split('\\n').find(l=>l.startsWith('node:')).split(':');const uid=Number(a[2]),gid=Number(a[3]);if(!(uid>0&&gid>0))process.exit(1);fs.chownSync('/fixture',uid,gid);fs.chmodSync('/fixture',448);console.log(JSON.stringify({uid,gid}))"]))
  run(['run', '--rm', '--user', 'node', '--platform', platform, '--network', 'none', '--label', `ylink.verify.owner=${owner}`,
    '--mount', `type=volume,source=${volume},target=/fixture`, '--entrypoint', 'node', image, '-e',
    "const fs=require('node:fs');fs.mkdirSync('/fixture/runtime',{mode:448});fs.writeFileSync('/fixture/runtime/database-runtime-override.json','{',{flag:'wx',mode:384})"])
  run(['run', '--detach', '--name', name, '--platform', platform, '--network', 'none', '--label', `ylink.verify.owner=${owner}`,
    '--mount', `type=volume,source=${volume},target=/app/data`, '--tmpfs', `/app/uploads:uid=${identity.uid},gid=${identity.gid},mode=0755`,
    '--env', 'Y_LINK_ONEBOX_NON_ROOT=true', '--env', 'Y_LINK_DATA_DIR=/app/data', '--env', 'SQLITE_DB_PATH=/app/data/must-not-bootstrap.sqlite',
    '--env', 'NODE_ENV=test', '--env', 'INIT_ADMIN_PASSWORD=' + password, '--env', 'REDIS_URL=', '--env', 'ALIYUN_DYPNS_MNS_ENABLED=false', image]); containerCreated = true
  const probe = `const assert=require('node:assert/strict'),fs=require('node:fs');(async()=>{let body;for(let i=0;i<200;i++){try{const r=await fetch('http://127.0.0.1/health');body=await r.json();if(r.status===503&&body.status==='RESCUE')break}catch{}await new Promise(r=>setTimeout(r,50))}assert.equal(body?.code,'DATABASE_OVERRIDE_CORRUPTED');for(let i=0;i<5;i++){const r=await fetch('http://127.0.0.1/health');assert.equal(r.status,503);assert.equal((await r.json()).code,'DATABASE_OVERRIDE_CORRUPTED');await new Promise(r=>setTimeout(r,100))}assert.equal((await fetch('http://127.0.0.1/api/auth/me')).status,503);assert.equal(fs.existsSync('/app/data/must-not-bootstrap.sqlite'),false);assert.equal(fs.existsSync('/app/data/secrets/data-encryption.key'),false);assert.equal(fs.readFileSync('/app/data/runtime/database-runtime-override.json','utf8'),'{');const pids=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p));const pid=pids.find(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('/usr/local/bin/ylink-backend-launcher.mjs')}catch{return false}});assert.ok(pid);const uids=/^Uid:[ \\t]+(.+)$/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'))[1].trim().split(/\\s+/).map(Number);assert.ok(uids.every(uid=>uid===${identity.uid}));console.log(JSON.stringify({health:'RESCUE',code:body.code,stable:true,businessDatabaseCreated:false,keyCreated:false,backendUid:${identity.uid}}))})().catch(()=>process.exit(1))`
  const result = JSON.parse(run(['exec', '--user', 'node', name, 'node', '-e', probe]))
  const info = JSON.parse(run(['inspect', name]))[0]
  assert.equal(info.Config.Labels['ylink.verify.owner'], owner)
  assert.equal(info.RestartCount, 0, '控制损坏必须稳定救援，不能退出并重启循环')
  run(['stop', '--time', '30', name])
  assert.equal(JSON.parse(run(['inspect', name]))[0].State.ExitCode, 0)
  fs.writeFileSync(path.join(evidence, 'corrupt-override-rescue.json'), JSON.stringify({ image, platform, imageId: info.Image, result, restartCount: info.RestartCount }, null, 2))
  console.log(`[onebox-corrupt-override] ${platform} 非 root 控制损坏稳定救援，无业务初始化`)
} finally {
  if (containerCreated) { assert.equal(JSON.parse(run(['inspect', name]))[0].Config.Labels['ylink.verify.owner'], owner); run(['rm', '--force', name]) }
  if (volumeCreated) { assert.equal(JSON.parse(run(['volume', 'inspect', volume]))[0].Labels['ylink.verify.owner'], owner); run(['volume', 'rm', volume]) }
}
