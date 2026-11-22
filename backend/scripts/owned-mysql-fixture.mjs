/** 专属 MySQL 8.0.44 fixture：只创建随机命名、带所有权标签、回环随机端口及 tmpfs 的测试实例。 */
import assert from 'node:assert/strict'
import {randomBytes,randomInt} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import mysql from 'mysql2/promise'
const docker=(args)=>{const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,'隔离 Docker 命令失败；不输出可能包含随机凭据的参数');return r.stdout}
export function readOwnedMysqlContext(){
 const name=process.env.Y_LINK_MYSQL_VERIFY_CONTAINER??'',runId=process.env.Y_LINK_MYSQL_VERIFY_RUN_ID??''
 assert.match(runId,/^[a-f0-9]{16}$/);assert.equal(name,'ylink-sp-'+runId)
 const info=JSON.parse(docker(['inspect',name]))[0]
 assert.equal(info.Config.Labels['ylink.verify.owner'],runId)
 const bindings=info.NetworkSettings.Ports['3306/tcp'];assert.equal(bindings.length,1);assert.equal(bindings[0].HostIp,'127.0.0.1')
 const port=Number(bindings[0].HostPort);assert.ok(port>=10000&&port<=65535,'本批MySQL映射必须使用高位端口，实际值：'+port)
 assert.equal(Number(process.env.DB_PORT),port);assert.equal(process.env.DB_HOST,'127.0.0.1')
 const database=process.env.DB_NAME??'';assert.match(database,new RegExp('^ylink_sp_'+runId+'_(?:o2o|packet|auth)$'))
 return {host:'127.0.0.1',port,user:'root',password:process.env.Y_LINK_MYSQL_VERIFY_PASSWORD??'',database}
}
export async function withOwnedMysqlFixture(run){
 const runId=randomBytes(8).toString('hex'),name='ylink-sp-'+runId,password=randomBytes(24).toString('base64url')
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'ylink-sp-mysql-'));const envFile=path.join(runtime,'empty.env');fs.writeFileSync(envFile,'')
 let started=false,connection
 try{
  // 宿主默认动态范围为1024..15000，不能用listen(0)保证高位门禁；只在批准范围核对空闲。
  let requestedPort
  for(let attempt=0;attempt<8;attempt++){
   const candidate=randomInt(20000,30000),probe=net.createServer()
   const free=await new Promise((resolve,reject)=>{
    probe.once('error',error=>error.code==='EADDRINUSE'?resolve(false):reject(new Error('本批端口探测失败')))
    probe.listen(candidate,'127.0.0.1',()=>resolve(true))
   })
   if(!free)continue
   await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()))
   const launched=spawnSync('docker',['run','--detach','--name',name,'--label','ylink.verify.owner='+runId,'--publish','127.0.0.1:'+candidate+':3306','--tmpfs','/var/lib/mysql','--env','MYSQL_ROOT_HOST=%','--env','MYSQL_ROOT_PASSWORD='+password,'mysql:8.0.44','--max-allowed-packet=1048576'],{encoding:'utf8',windowsHide:true})
   if(launched.status===0){started=true;requestedPort=candidate;break}
   // 释放探测与实际绑定之间可能发生竞争；清理当前尝试的自身资源后才允许换端口。
   const inspected=spawnSync('docker',['inspect',name],{encoding:'utf8',windowsHide:true})
   if(inspected.status===0){const info=JSON.parse(inspected.stdout)[0];assert.equal(info.Config.Labels['ylink.verify.owner'],runId);docker(['rm','--force',name])}
   assert.ok(/port is already allocated|address already in use|ports are not available|bind.*address/i.test(launched.stderr??''),'独占MySQL启动失败，已隐藏可能包含随机凭据的Docker参数')
  }
  assert.ok(started&&requestedPort,'本批高位端口8次有界尝试均未成功，停止该路径')
  const info=JSON.parse(docker(['inspect',name]))[0];const port=Number(info.NetworkSettings.Ports['3306/tcp'][0].HostPort)
  assert.equal(port,requestedPort,'Docker实际映射必须等于独占请求的高位端口')
  for(let attempt=0;attempt<180;attempt++){try{connection=await mysql.createConnection({host:'127.0.0.1',port,user:'root',password,connectTimeout:1000});break}catch{await new Promise(resolve=>setTimeout(resolve,500))}}
  assert.ok(connection,'隔离MySQL未就绪');const [rows]=await connection.query('SELECT VERSION() AS version');assert.match(rows[0].version,/^8\.0\.44/)
  for(const kind of ['o2o','packet','auth'])await connection.query('CREATE DATABASE `ylink_sp_'+runId+'_'+kind+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci')
  await run({runtime,port,runId,name,password,env:{ENV_FILE:envFile,Y_LINK_DATA_DIR:runtime,Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE:'true',DB_TYPE:'mysql',DB_SYNC:'true',DB_HOST:'127.0.0.1',DB_PORT:String(port),DB_USER:'root',DB_PASSWORD:password,DB_NAME:'ylink_sp_'+runId+'_o2o',Y_LINK_MYSQL_VERIFY_CONTAINER:name,Y_LINK_MYSQL_VERIFY_RUN_ID:runId,Y_LINK_MYSQL_VERIFY_PASSWORD:password,REDIS_URL:'',ALIYUN_DYPNS_MNS_ENABLED:'false'}})
 }finally{
  await connection?.end()
  // 端口被竞争时docker run也可能先创建后启动失败，仍只清理核对过自身标签的容器。
  const inspected=spawnSync('docker',['inspect',name],{encoding:'utf8',windowsHide:true})
  if(inspected.status===0){const info=JSON.parse(inspected.stdout)[0];assert.equal(info.Config.Labels['ylink.verify.owner'],runId);docker(['rm','--force',name])}
  else assert.equal(started,false,'已启动容器无法核对所有权，停止自动清理')
  fs.rmSync(runtime,{recursive:true,force:true})
 }
}
