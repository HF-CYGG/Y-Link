/** 在实际Onebox容器中执行：真实HTTP/CSRF、上传临时目录、私有附件、缓存、SSE及边缘边界。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'
const require=createRequire('/app/backend/package.json'),sharp=require('sharp')
const base='http://127.0.0.1',results=[]
const json=async(url,options={})=>{const response=await fetch(base+url,{...options,signal:options.signal??AbortSignal.timeout(30000)});const payload=await response.json();return {response,payload}}
const cookiesOf=response=>new Map(response.headers.getSetCookie().map(value=>{const first=value.split(';')[0],index=first.indexOf('=');return [first.slice(0,index),first.slice(index+1)]}))
const headerOf=cookies=>[...cookies].map(([key,value])=>key+'='+value).join('; ')
let ready=false
for(let i=0;i<300;i++){try{const {response,payload}=await json('/health');if(response.ok&&payload.status==='UP'){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100))}assert.ok(ready,'实际业务health不得为rescue')
const login=await json('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Forwarded-Proto':'https','X-Forwarded-For':'198.51.100.77'},body:JSON.stringify({username:'admin',password:process.env.INIT_ADMIN_PASSWORD})});assert.equal(login.response.status,200);assert.equal(login.payload.code,0);assert.ok(login.response.headers.getSetCookie().every(value=>!/(?:^|;)\s*Secure(?:;|$)/i.test(value)),'未授权转发头不能把HTTP伪装为HTTPS')
const admin=cookiesOf(login.response),adminHeaders={Cookie:headerOf(admin),Origin:base,'x-csrf-token':decodeURIComponent(admin.get('y_link_admin_csrf')??'')};assert.ok(adminHeaders['x-csrf-token']);assert.equal((await json('/api/auth/me',{headers:adminHeaders})).response.status,200);results.push('实际管理员Cookie/CSRF与转发协议边界')
const config=await json('/api/system-configs/customer-service',{headers:adminHeaders});assert.equal(config.response.status,200);const updated=await json('/api/system-configs/customer-service',{method:'PUT',headers:{...adminHeaders,'Content-Type':'application/json'},body:JSON.stringify({...config.payload.data,enabled:true,realtimeEnabled:true,sseKeepaliveSeconds:5})});assert.equal(updated.response.status,200)
const {AppDataSource}=await import('/app/backend/dist/config/data-source.js');const {initializeDatabaseInfrastructure}=await import('/app/backend/dist/database/database-strategy.js');const {ClientUser}=await import('/app/backend/dist/entities/client-user.entity.js');const {hashPassword}=await import('/app/backend/dist/utils/password.js')
await AppDataSource.initialize();await initializeDatabaseInfrastructure(AppDataSource)
let clientSession
try{
 await AppDataSource.getRepository(ClientUser).save({realName:'容器验证用户',username:'runtime-user',mobile:'13800001001',passwordHash:await hashPassword('RuntimeClient_Aa1!'),accountType:'personal',departmentName:'',status:'enabled',staffVerified:false})
 // PNG答案不可从HTTP响应提取。仅在此独立夹具进程固定答案，真实PNG渲染、票据、密码校验和会话事务全部保留。
 const {installCaptchaServiceForTesting}=await import('/app/backend/dist/services/captcha.service.js')
 const {clientAuthService}=await import('/app/backend/dist/services/client-auth.service.js')
 const code='ABC234',restore=installCaptchaServiceForTesting({createCode:()=>code})
 try{
  const captcha=await clientAuthService.createCaptcha()
  assert.match(captcha.captchaImage,/^data:image\/png;base64,/)
  clientSession=await clientAuthService.login({account:'13800001001',password:'RuntimeClient_Aa1!',captchaId:captcha.captchaId,captchaCode:code},undefined,true)
 }finally{restore()}
}finally{await AppDataSource.destroy()}
const {CLIENT_SESSION_COOKIE_NAME}=await import('/app/backend/dist/utils/client-auth-cookie.js')
const client=new Map([[CLIENT_SESSION_COOKIE_NAME,encodeURIComponent(clientSession.token)]])
assert.equal((await json('/api/client-auth/me',{headers:{Cookie:headerOf(client)}})).response.status,200,'真实服务签发的会话必须通过实际HTTP认证')
results.push('客户端夹具经真实PNG票据/密码/会话事务引导，再由实际HTTP me鉴权；未将夹具引导计为HTTP登录测试')
const streamAbort=new AbortController();const stream=await fetch(base+'/api/client-feedback/stream',{headers:{Cookie:headerOf(client)},signal:streamAbort.signal});assert.equal(stream.status,200);assert.match(stream.headers.get('content-type')??'',/text\/event-stream/);const reader=stream.body.getReader();const first=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('SSE首帧被缓冲')),5000))]);assert.ok(first.value?.length);const second=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('SSE心跳未通过代理')),12000))]);assert.ok(second.value?.length);await reader.cancel();streamAbort.abort();results.push('真实客户端认证/SSE首帧与后续心跳')
const png=await sharp(randomBytes(1600*1200*3),{raw:{width:1600,height:1200,channels:3}}).png({compressionLevel:0}).toBuffer();assert.ok(png.length>1024*1024);const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'runtime-large.png')
const uploaded=await json('/api/upload',{method:'POST',headers:adminHeaders,body:form});assert.equal(uploaded.response.status,200);assert.equal(uploaded.payload.code,0);const image=await fetch(base+uploaded.payload.data.url);assert.equal(image.status,200);assert.match(image.headers.get('cache-control')??'',/immutable/);assert.ok((await image.arrayBuffer()).byteLength>0);results.push('真实大图片上传/重编码/公开图片immutable缓存')
fs.mkdirSync('/app/uploads/client-feedback',{recursive:true});fs.mkdirSync('/app/uploads/.tmp',{recursive:true});fs.writeFileSync('/app/uploads/client-feedback/verify-private.txt','private fixture');fs.writeFileSync('/app/uploads/.tmp/verify-private.txt','temporary fixture')
for(const url of ['/uploads/client-feedback/verify-private.txt','/uploads/.tmp/verify-private.txt']){const response=await fetch(base+url);assert.equal(response.status,404);await response.text()}results.push('私有附件及临时上传不能直出')
const cache=[];for(let i=0;i<2;i++){const response=await fetch(base+'/api/o2o/mall/products');assert.equal(response.status,200);await response.arrayBuffer();cache.push(response.headers.get('x-ylink-cache'))}assert.ok(cache.includes('HIT'),'公开目录应命中真实Nginx微缓存');results.push('公开目录微缓存HIT')
const oversized=await json('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({padding:'x'.repeat(70*1024)})});assert.equal(oversized.response.status,413);results.push('边缘请求体413')
const bursts=await Promise.all(Array.from({length:40},()=>json('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'})));assert.ok(bursts.some(item=>item.response.status===429&&item.payload.data?.reason==='EDGE_RATE_LIMITED'));results.push('真实边缘限流429')
console.log(JSON.stringify({status:'passed',results,largeUploadBytes:png.length,cache}))
