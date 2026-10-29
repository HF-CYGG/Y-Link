/** 统一验收时自建唯一临时 MySQL 8.4；只清理本进程成功创建的容器，不触及现有实例。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomBytes, randomInt } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { setTimeout as wait } from 'node:timers/promises'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),backend=path.join(root,'backend')
assert.ok(process.env.YLINK_ISSUES_VERIFY_ROOT && /^[\x20-\x7e]+$/.test(path.resolve(process.env.YLINK_ISSUES_VERIFY_ROOT)),'须指定本任务独占英文临时目录')
const require=createRequire(path.join(backend,'package.json')), mysql=require('mysql2/promise')
const docker=process.env.YLINK_ISSUES_DOCKER??'docker'
const name=`ylink-i177-i178-${randomBytes(6).toString('hex')}`,password=randomBytes(32).toString('base64url')
// 独占端口必须满足子脚本10000..65535门禁；Windows自动端口0可能分配到该范围外。
const reserveCandidate=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(randomInt(10000,65536),'127.0.0.1',()=>{const address=server.address();server.close(()=>resolve(address.port))})})
let port
for(let attempt=0;attempt<100;attempt+=1){try{port=await reserveCandidate();break}catch(error){if(!['EADDRINUSE','EACCES'].includes(error.code))throw error}}
assert.ok(Number.isInteger(port)&&port>=10000&&port<=65535,'没有可用隔离端口')
const run=(command,args,env=process.env)=>new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:backend,env,windowsHide:true,stdio:['ignore','inherit','inherit']});child.once('error',reject);child.once('exit',(code)=>resolve(code??1))})
let created=false
try{
  const exit=await run(docker,['run','--pull=never','--detach','--name',name,'--env','MYSQL_ROOT_PASSWORD','--env','MYSQL_ROOT_HOST','--publish',`127.0.0.1:${port}:3306`,'--tmpfs','/var/lib/mysql','mysql:8.4'],{...process.env,MYSQL_ROOT_PASSWORD:password,MYSQL_ROOT_HOST:'%'})
  assert.equal(exit,0,'隔离MySQL容器启动失败');created=true
  let ready=false
  for(let attempt=0;attempt<90;attempt+=1){let connection;try{connection=await mysql.createConnection({host:'127.0.0.1',port,user:'root',password});const[rows]=await connection.query('SELECT VERSION() AS version');assert.match(rows[0].version,/^8\.4\./);console.log(JSON.stringify({scene:'真实隔离MySQL',version:rows[0].version,port,container:name}));ready=true;break}catch{await wait(1000)}finally{await connection?.end()}}
  assert.equal(ready,true,'真实MySQL 8.4未就绪，不能以fixture替代')
  const result=await run(process.execPath,['--import','tsx','scripts/issues-177-178-mysql-verify.ts'],{...process.env,YLINK_ISSUES_MYSQL_CONFIRM_TEST_SERVER:'true',YLINK_ISSUES_MYSQL_PORT:String(port),YLINK_ISSUES_MYSQL_USER:'root',YLINK_ISSUES_MYSQL_PASSWORD:password})
  assert.equal(result,0,'真实MySQL迁移/CAS/核销/JSON验收失败')
}finally{if(created){assert.match(name,/^ylink-i177-i178-[a-f0-9]{12}$/);const cleanup=await run(docker,['rm','--force',name]);assert.equal(cleanup,0,'本任务临时容器清理失败')}}
