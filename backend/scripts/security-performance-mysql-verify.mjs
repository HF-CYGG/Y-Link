/** 串行驱动同一独占MySQL实例的账号结构、真实改密/refresh交错、HTTP/O2O及迁移包长边界。 */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {withOwnedMysqlFixture} from './owned-mysql-fixture.mjs'
import {fileURLToPath} from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
const cwd=fileURLToPath(new URL('..',import.meta.url))
const evidenceRoot=path.resolve(process.env.Y_LINK_MYSQL_VERIFY_EVIDENCE_DIR??process.env.Y_LINK_VERIFY_EVIDENCE_DIR??path.join(cwd,'data','security-performance-mysql-verify'))
const evidence=path.join(evidenceRoot,'mysql-'+randomUUID())
fs.mkdirSync(evidence,{recursive:true})
const results=[]
const scenes=[
 ['schema','account-lifecycle-mysql-verify.ts','auth'],
 ['password','mysql-password-session-transaction-verify.ts','auth'],
 ['o2o','o2o-stock-consistency-verify.ts','o2o'],
 ['packet','mysql-migration-packet-verify.ts','packet'],
]
const selected=process.env.Y_LINK_MYSQL_VERIFY_SCENES?.split(',').filter(Boolean)
assert.ok(!selected||selected.every(scene=>scenes.some(([id])=>id===scene)),'仅接受已定义专项，不能把未知选择记为通过')
console.log('MySQL专项证据目录：'+evidence)
await withOwnedMysqlFixture(async fixture=>{
 for(const [scene,script,kind] of scenes){
  if(selected&&!selected.includes(scene)){results.push({script,status:'not-run-in-this-command'});continue}
  const system=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC'].includes(key.toUpperCase())))
  const child=spawn(process.execPath,['--import','tsx','scripts/'+script],{cwd,env:{
   ...system,...fixture.env,DB_NAME:'ylink_sp_'+fixture.runId+'_'+kind,NODE_ENV:'test',
   INIT_ADMIN_PASSWORD:'MysqlFixture_Admin_Aa1!',Y_LINK_VERIFY_ADMIN_PASSWORD:'MysqlFixture_Admin_Aa1!',
   Y_LINK_STOCK_MYSQL_VERIFY:'true',Y_LINK_MYSQL_VERIFY_EVIDENCE_DIR:evidence,
   ACCOUNT_LIFECYCLE_MYSQL_CONFIRM_TEST_SERVER:'true',ACCOUNT_LIFECYCLE_MYSQL_HOST:'127.0.0.1',
   ACCOUNT_LIFECYCLE_MYSQL_PORT:String(fixture.port),ACCOUNT_LIFECYCLE_MYSQL_USER:'root',ACCOUNT_LIFECYCLE_MYSQL_PASSWORD:fixture.password,
  },stdio:'inherit',windowsHide:true})
  const result=await new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',()=>resolve({code:-1}))})
  results.push({script,exit:result.code,signal:result.signal,status:result.code===0?'passed':'failed'})
  fs.writeFileSync(path.join(evidence,'runner-results.json'),JSON.stringify({results,remaining:'失败后未启动的脚本均为not-run'},null,2)+'\n')
  assert.equal(result.code,0,script+' 必须成功，失败不进入后续场景')
 }
})
