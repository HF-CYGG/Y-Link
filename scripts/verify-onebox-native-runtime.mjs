/** 检查实际 Onebox 镜像的 Nginx 与 sqlite3/sharp；只创建带本批标签、无网络和无卷的临时容器。 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const image=process.env.Y_LINK_VERIFY_IMAGE?.trim()
const platform=process.env.Y_LINK_VERIFY_PLATFORM?.trim()
const evidence=process.env.Y_LINK_VERIFY_EVIDENCE_DIR?.trim()
assert.ok(image&&/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image),'必须显式指定本批镜像')
assert.ok(['linux/amd64','linux/arm64'].includes(platform),'必须显式指定目标架构')
assert.ok(evidence,'必须显式指定独占证据目录')
fs.mkdirSync(evidence,{recursive:true})
const run=(id,args)=>{
 const result=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024})
 fs.writeFileSync(path.join(evidence,`${id}.json`),JSON.stringify({image,platform,args,exit:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message},null,2))
 assert.equal(result.status,0,`${id} 失败，见独占证据目录`)
 return result.stdout
}
const inspect=JSON.parse(run('image-inspect',['image','inspect',image]))[0]
assert.equal(inspect.Os+'/'+inspect.Architecture,platform)
fs.writeFileSync(path.join(evidence,'image-binding.json'),JSON.stringify({imageId:inspect.Id,repoDigests:inspect.RepoDigests,platform},null,2))
const base=['run','--rm','--network','none','--platform',platform,'--label','ylink.verify=security-performance-20261113']
run('nginx-config',[...base,'--entrypoint','sh',image,'-ec',`test "$(dpkg-query -W -f='\${Version}' nginx)" = '1.30.6-1~bookworm'; sed -i 's/__BACKEND_PORT__/3001/g' /etc/nginx/conf.d/default.conf; sh /usr/local/bin/ylink-proxy-boundary; nginx -t; test -d /var/cache/nginx/client_temp; test -d /var/cache/nginx/proxy_temp; nginx -V`])
const native=`const assert=require('node:assert/strict');const fs=require('node:fs');const sqlite=require('/app/backend/node_modules/sqlite3');const sharp=require('/app/backend/node_modules/sharp');const expected=${JSON.stringify(platform.split('/')[1]==='amd64'?'x64':'arm64')};assert.equal(process.arch,expected);assert.equal(process.version,'v22.23.5');(async()=>{const db=new sqlite.Database(':memory:');await new Promise((resolve,reject)=>db.serialize(()=>{db.run('CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT)');db.run('INSERT INTO fixture(value) VALUES (?)',['真实中文']);db.get('SELECT value FROM fixture',(e,row)=>{if(e)return reject(e);try{assert.equal(row.value,'真实中文');resolve()}catch(error){reject(error)}})}));await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));const png=await sharp({create:{width:8,height:6,channels:3,background:'#123456'}}).resize(4,3).png().toBuffer();const metadata=await sharp(png).metadata();assert.equal(metadata.width,4);assert.equal(metadata.height,3);console.log(JSON.stringify({node:process.version,arch:process.arch,sqlite:'write-read-ok',sharp:'resize-decode-ok'}))})().catch(()=>process.exit(1))`
run('native-operations',[...base,'--entrypoint','node',image,'-e',native])
const globScript=fs.realpathSync(fileURLToPath(new URL('../backend/scripts/typeorm-glob-compat-verify.mjs',import.meta.url)))
run('typeorm-glob',[...base,'--mount',`type=bind,source=${globScript},target=/app/backend/scripts/typeorm-glob-compat-verify.mjs,readonly`,'--entrypoint','node',image,'/app/backend/scripts/typeorm-glob-compat-verify.mjs'])
console.log(`[onebox-native] ${platform} Nginx 配置、真实原生操作及 TypeORM glob 通过；HTTP/SSE/上传/优雅退出另行验收`)
