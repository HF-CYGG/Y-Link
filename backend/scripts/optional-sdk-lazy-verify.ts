/** 可选 SDK 延迟加载：真实模型构造 + 合并首次加载/失败重试 + Worker 关闭；不访问外部网络。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'ylink-lazy-sdk-'))
const emptyEnvFile=path.join(runtime,'empty.env');fs.writeFileSync(emptyEnvFile,'')
Object.assign(process.env,{NODE_ENV:'test',ENV_FILE:emptyEnvFile,Y_LINK_DATA_DIR:runtime,Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE:'true',APP_PROFILE:'lazy-sdk-verify',ALIYUN_DYPNS_MNS_ENABLED:'true',ALIBABA_CLOUD_ACCESS_KEY_ID:'fixture-key',ALIBABA_CLOUD_ACCESS_KEY_SECRET:'fixture-secret'})
const require=createRequire(import.meta.url)
try {
 const {createRetryableLazyResource}=await import('../src/utils/retryable-lazy-resource.js')
 let loadCount=0;let release:((value:number)=>void)|undefined
 const load=createRetryableLazyResource(async()=>{loadCount++;return new Promise<number>(resolve=>{release=resolve})})
 const first=load(),second=load();assert.equal(first,second);await Promise.resolve();assert.equal(loadCount,1);release!(42);assert.equal(await first,42);assert.equal(await load(),42);assert.equal(loadCount,1)
 let attempts=0
 const retry=createRetryableLazyResource(async()=>{if(++attempts===1)throw Error('fixture-load-failure');return 7})
 const failed=await Promise.allSettled([retry(),retry()]);assert.ok(failed.every(r=>r.status==='rejected'));assert.equal(attempts,1);assert.equal(await retry(),7);assert.equal(attempts,2)
 const {AliyunDypnsSmsProvider}=await import('../src/services/aliyun-dypns-sms.service.js')
 const {AliyunDypnsMnsWorkerService}=await import('../src/services/aliyun-dypns-mns-worker.service.js')
 assert.ok(!Object.keys(require.cache).some(id=>/node_modules[\\/]@alicloud[\\/](?:dypnsapi20170525|mns|pop-core)[\\/]/.test(id)),'仅导入服务不得加载可选 SDK')
 const requests:unknown[]=[]
 const provider=new AliyunDypnsSmsProvider(()=>({
  async sendSmsVerifyCodeWithOptions(request){requests.push(request);return {body:{success:true,code:'OK'}}},
  async checkSmsVerifyCodeWithOptions(request){requests.push(request);return {body:{success:true,code:'OK',model:{verifyResult:'PASS'}}}},
 }))
 await Promise.all([provider.check({phoneNumber:'13800001111',countryCode:'86',outId:'fixture',verifyCode:'123456',schemeName:'fixture'}),provider.send({phoneNumber:'13800001111',countryCode:'86',outId:'fixture',scene:'test',config:{signName:'测试',schemeName:'fixture',templates:{register:'r',forgotPassword:'f',profileUpdate:'p',test:'t'}}})])
 assert.deepEqual(requests.map((r:any)=>r.constructor.name).sort(),['CheckSmsVerifyCodeRequest','SendSmsVerifyCodeRequest'])
 assert.ok(!Object.keys(require.cache).some(id=>/node_modules[\\/]@alicloud[\\/](?:mns|pop-core)[\\/]/.test(id)),'PNVS 首次使用不应加载 MNS/POP')
 for(const failure of ['none','sts','client'] as const){
  let stsRequests=0,clients=0;let receiveCount=0
  const worker=new AliyunDypnsMnsWorkerService({async cleanupExpiredRecords(){return 0},async applyReceipt(){throw Error('空队列不得写回执')}},{
   createPopClient(){return {async request<T>(){stsRequests++;await Promise.resolve();if(failure==='sts'&&stsRequests===1)throw Error('fixture-sts-failure');return {Code:'OK',Token:{AccessKeyId:'fixture-id',AccessKeySecret:'fixture-secret',SecurityToken:'fixture-token',Expiration:new Date(Date.now()+600_000).toISOString()}} as T}}},
   createMnsClient(){clients++;if(failure==='client'&&clients===1)throw Error('fixture-client-failure');return {async batchReceiveMessage(){receiveCount++;return {Messages:[]}},async deleteMessage(){throw Error('空队列不得确认消息')}}},
  })
  try{
   const results=await Promise.allSettled([worker.runOnce(),worker.runOnce()])
   assert.equal(stsRequests,1,'并发首次初始化必须共享 STS 请求')
   if(failure==='none')assert.ok(results.every(r=>r.status==='fulfilled'))
   else {assert.ok(results.every(r=>r.status==='rejected'));await worker.runOnce();assert.equal(stsRequests,2,'失败初始化必须可重试')}
   assert.ok(receiveCount>0);await worker.stop();assert.equal(worker.getStatus().running,false)
   const before=stsRequests;await worker.stop();assert.equal(stsRequests,before,'重复关闭不得重建客户端')
  }finally{await worker.stop()}
 }
 // 启动后在 STS 首次初始化未完成时关闭，必须等待本轮排空，且不能重启轮询。
 let releaseSts: (()=>void)|undefined
 let polls=0
 const closingWorker=new AliyunDypnsMnsWorkerService({async cleanupExpiredRecords(){return 0},async applyReceipt(){throw Error('不得写回执')}},{
  createPopClient(){return {async request<T>(){await new Promise<void>(resolve=>{releaseSts=resolve});return {Token:{AccessKeyId:'fixture-id',AccessKeySecret:'fixture-secret',SecurityToken:'fixture-token',Expiration:new Date(Date.now()+600_000).toISOString()}} as T}}},
  createMnsClient(){return {async batchReceiveMessage(){polls++;return {Messages:[]}},async deleteMessage(){throw Error('空队列不得确认')}}},
 })
 try {
  closingWorker.start()
  const deadline=Date.now()+2000
  while(!releaseSts){assert.ok(Date.now()<deadline,'Worker未进入首次初始化');await new Promise(resolve=>setImmediate(resolve))}
  let closed=false
  const stopping=closingWorker.stop().then(()=>{closed=true})
  await Promise.resolve();assert.equal(closed,false,'关闭必须排空正在初始化的周期')
  releaseSts();await stopping
  assert.equal(closingWorker.getStatus().running,false)
  const finishedPolls=polls;await new Promise(resolve=>setImmediate(resolve));assert.equal(polls,finishedPolls,'关闭后不能自行重启轮询')
 } finally { releaseSts?.();await closingWorker.stop() }
 console.log('[lazy-sdk] 首次合并、失败重试、真实模型及关闭契约通过')
} finally {fs.rmSync(runtime,{recursive:true,force:true})}
