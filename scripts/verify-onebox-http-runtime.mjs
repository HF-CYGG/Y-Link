/** 双架构实际镜像HTTP验收入口；仅创建自己的无网络、无持久卷容器，最终正常停止并核对日志。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {randomBytes} from 'node:crypto'
import {spawnSync} from 'node:child_process'
const image=process.env.Y_LINK_VERIFY_IMAGE,platform=process.env.Y_LINK_VERIFY_PLATFORM,evidence=process.env.Y_LINK_VERIFY_EVIDENCE_DIR
const nonRoot=process.env.Y_LINK_VERIFY_ONEBOX_NON_ROOT??'false'
assert.ok(image&&/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)&&platform&&evidence);assert.ok(['linux/amd64','linux/arm64'].includes(platform));assert.ok(['true','false'].includes(nonRoot));fs.mkdirSync(evidence,{recursive:true})
const id=randomBytes(8).toString('hex'),name='ylink-http-'+id,password=randomBytes(24).toString('base64url')+'Aa1!'
const invoke=(args,record)=>{const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});if(record)fs.writeFileSync(path.join(evidence,record+'.json'),JSON.stringify({image,platform,exit:r.status,stdout:r.stdout,stderr:r.stderr},null,2));assert.equal(r.status,0,'本批Docker操作失败，见独占证据');return record==='container-logs'?r.stdout+r.stderr:r.stdout}
let created=false
try{
 const identity=JSON.parse(invoke(['run','--rm','--platform',platform,'--network','none','--label','ylink.verify.owner='+id,'--entrypoint','node',image,'-e',"const a=require('node:fs').readFileSync('/etc/passwd','utf8').split('\\n').find(l=>l.startsWith('node:')).split(':');console.log(JSON.stringify({uid:Number(a[2]),gid:Number(a[3])}))"]));assert.ok(identity.uid>0&&identity.gid>0)
 const dataTmpfs=nonRoot==='true'?`/app/data:uid=${identity.uid},gid=${identity.gid},mode=0700`:'/app/data'
 const uploadsTmpfs=nonRoot==='true'?`/app/uploads:uid=${identity.uid},gid=${identity.gid},mode=0755`:'/app/uploads'
 invoke(['run','--detach','--name',name,'--platform',platform,'--label','ylink.verify.owner='+id,'--network','none','--tmpfs',dataTmpfs,'--tmpfs',uploadsTmpfs,'--mount','type=bind,source='+path.resolve('scripts/onebox-http-runtime-case.mjs')+',target=/tmp/ylink-http-case.mjs,readonly','--env','Y_LINK_ONEBOX_NON_ROOT='+nonRoot,'--env','NODE_ENV=test','--env','DB_TYPE=sqlite','--env','DB_SYNC=true','--env','SQLITE_DB_PATH=/app/data/verify.sqlite','--env','Y_LINK_DATA_DIR=/app/data','--env','Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE=true','--env','INIT_ADMIN_PASSWORD='+password,'--env','REDIS_URL=','--env','ALIYUN_DYPNS_MNS_ENABLED=false',image]);created=true
 const info=JSON.parse(invoke(['inspect',name]))[0];assert.equal(info.Config.Labels['ylink.verify.owner'],id);assert.equal(info.HostConfig.NetworkMode,'none');fs.writeFileSync(path.join(evidence,'image-binding.json'),JSON.stringify({imageId:info.Image,platform,nonRoot,identity},null,2))
 invoke(['exec',...(nonRoot==='true'?['--user','node']:[]),name,'node','/tmp/ylink-http-case.mjs'],'http-case')
 invoke(['stop','--time','30',name],'graceful-stop');const stopped=JSON.parse(invoke(['inspect',name]))[0];assert.equal(stopped.State.ExitCode,0);assert.equal(stopped.State.OOMKilled,false)
 const logs=invoke(['logs',name],'container-logs');assert.match(logs,/received stop signal/);assert.match(logs,/SHUTDOWN/);assert.match(logs,/client request body is buffered to a temporary file.*client_temp/,'大上传必须实际使用已适配的client临时目录')
 console.log('[onebox-http] '+platform+' nonRoot='+nonRoot+' 真实身份/HTTP/上传/缓存/SSE/边缘限制/正常停机通过')
}finally{if(created){const info=JSON.parse(invoke(['inspect',name]))[0];assert.equal(info.Config.Labels['ylink.verify.owner'],id);invoke(['rm','--force',name],'cleanup')}}
