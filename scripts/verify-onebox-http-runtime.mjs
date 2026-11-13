/** 双架构实际镜像HTTP验收入口；仅创建自己的无网络、无持久卷容器，最终正常停止并核对日志。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {randomBytes} from 'node:crypto'
import {spawnSync} from 'node:child_process'
const image=process.env.Y_LINK_VERIFY_IMAGE,platform=process.env.Y_LINK_VERIFY_PLATFORM,evidence=process.env.Y_LINK_VERIFY_EVIDENCE_DIR
assert.ok(image&&platform&&evidence);assert.ok(['linux/amd64','linux/arm64'].includes(platform));fs.mkdirSync(evidence,{recursive:true})
const id=randomBytes(8).toString('hex'),name='ylink-http-'+id,password=randomBytes(24).toString('base64url')+'Aa1!'
const invoke=(args,record)=>{const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});if(record)fs.writeFileSync(path.join(evidence,record+'.json'),JSON.stringify({image,platform,exit:r.status,stdout:r.stdout,stderr:r.stderr},null,2));assert.equal(r.status,0,'本批Docker操作失败，见独占证据');return record==='container-logs'?r.stdout+r.stderr:r.stdout}
let created=false
try{
 invoke(['run','--detach','--name',name,'--platform',platform,'--label','ylink.verify.owner='+id,'--network','none','--tmpfs','/app/data','--tmpfs','/app/uploads','--mount','type=bind,source='+path.resolve('scripts/onebox-http-runtime-case.mjs')+',target=/tmp/ylink-http-case.mjs,readonly','--env','NODE_ENV=test','--env','DB_TYPE=sqlite','--env','DB_SYNC=true','--env','SQLITE_DB_PATH=/app/data/verify.sqlite','--env','Y_LINK_DATA_DIR=/app/data','--env','Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE=true','--env','INIT_ADMIN_PASSWORD='+password,'--env','REDIS_URL=','--env','ALIYUN_DYPNS_MNS_ENABLED=false',image]);created=true
 const info=JSON.parse(invoke(['inspect',name]))[0];assert.equal(info.Config.Labels['ylink.verify.owner'],id);assert.equal(info.HostConfig.NetworkMode,'none');fs.writeFileSync(path.join(evidence,'image-binding.json'),JSON.stringify({imageId:info.Image,platform},null,2))
 invoke(['exec',name,'node','/tmp/ylink-http-case.mjs'],'http-case')
 invoke(['stop','--time','30',name],'graceful-stop');const stopped=JSON.parse(invoke(['inspect',name]))[0];assert.equal(stopped.State.ExitCode,0);assert.equal(stopped.State.OOMKilled,false)
 const logs=invoke(['logs',name],'container-logs');assert.match(logs,/received stop signal/);assert.match(logs,/SHUTDOWN/);assert.match(logs,/client request body is buffered to a temporary file.*client_temp/,'大上传必须实际使用已适配的client临时目录')
 console.log('[onebox-http] '+platform+' 真实HTTP/上传/缓存/SSE/边缘限制/正常停机通过')
}finally{if(created){const info=JSON.parse(invoke(['inspect',name]))[0];assert.equal(info.Config.Labels['ylink.verify.owner'],id);invoke(['rm','--force',name],'cleanup')}}
