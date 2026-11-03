/** 本批统一验收浏览器行为回归；仅在独立深审与集中修复后执行。所有API均由本脚本隔离fixture提供。 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const root=process.cwd();
const onlyScene=process.env.POLISH_SCENE??'';
const evidence=path.resolve(process.env.POLISH_EVIDENCE_DIR??'output/playwright/pensive-polish');
fs.mkdirSync(evidence,{recursive:true});
const req=createRequire(path.join(root,'package.json'));
const {createServer}=await import(pathToFileURL(req.resolve('vite')).href);
const source=fs.readFileSync(path.join(root,'scripts/verify-login-theme-transition.mjs'),'utf8');
const CdpPage=new Function(source.slice(source.indexOf('class CdpPage'),source.indexOf('async function waitFor'))+';return CdpPage')();
const user={id:'fixture-1',username:'隔离体验账号',account:'隔离体验账号',realName:'隔离体验账号',mobile:'',email:'demo@example.test',departmentName:'测试',accountType:'personal',status:'enabled',staffVerified:false};
const price={defaultPrice:'12.00',originalPrice:'12.00',discountRate:'10.00',discountedPrice:'12.00'};
const products=[{id:'p1',productCode:'DEMO',productName:'隔离基线商品',...price,o2oRecommended:true,tags:[],thumbnail:null,thumbnailSmall:null,detailContent:'<p>基线商品说明</p>',limitPerUser:0,currentStock:20,preOrderedStock:0,availableStock:20,soldQty:0,skus:[{id:'s1',productId:'p1',skuCode:'DEMO-1',specValues:{},specText:'标准',...price,currentStock:20,preOrderedStock:0,availableStock:20,isActive:true,isCurrent:true,o2oRecommended:true,thumbnail:null,thumbnailSmall:null,sortOrder:0}]}];
products.push({...products[0],id:'p2',productCode:'DETAIL',productName:'详情规格基线商品',skus:[{...products[0].skus[0],id:'d1',productId:'p2',specValues:{规格:'有货SKU1'},specText:'有货SKU1'},{...products[0].skus[0],id:'d2',productId:'p2',specValues:{规格:'无货SKU2'},specText:'无货SKU2',currentStock:0,availableStock:0}]}); const storefront={businessHoursText:'10:00 - 22:00',mallAnnouncementText:'隔离 API fixture，非真实业务后端',pickupWindowHours:24};
const api=[];
// API fixture 边界：实际 Vue 页面与事件执行真实代码，网络端仅提供隔离、可延迟的契约数据。
const availability={isOnline:true,offlineFaqs:[],statusText:'在线',serviceHoursText:'测试时段'};
const conversation={id:'f1',conversationNo:'FIXTURE-001',clientUserId:user.id,clientUsername:user.username,clientAccount:user.account,clientAccountType:'personal',staffNoSnapshot:null,departmentNameSnapshot:'测试',subject:'隔离反馈',status:'processing',priority:'normal',assignedUserId:null,assignedUsername:null,assignedDisplayName:null,lastMessagePreview:'初始说明',lastMessageSenderType:'client',lastMessageAt:new Date().toISOString(),unreadForClientCount:0,unreadForServiceCount:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),restock:null,serverNow:new Date().toISOString(),fields:{issueType:'suggestion',category:'other',orderRef:null,expectedResult:'',actualResult:'初始说明',reproductionSteps:null,contactPreference:null,tags:[],sourceLabel:'fixture'}};
const messages=[]; const streams=new Set();
const waits=new Map(), pending=new Map(); let detailReads=0, posts=[];
const waitBoundary=async(name)=>{if(!waits.get(name))return;await new Promise(resolve=>pending.set(name,resolve))};
const release=(name)=>{waits.delete(name);pending.get(name)?.();pending.delete(name)};
const fixture={name:'隔离交互API',configureServer(server){server.middlewares.use(async(r,s,next)=>{
  const p=r.url.split('?')[0];
  const send=(data,status=200)=>{s.writeHead(status,{'Content-Type':'application/json'});s.end(JSON.stringify({code:status===200?0:status,message:status===200?'ok':'fixture 错误',data}))};
  if(!p.startsWith('/api/')&&p!=='/health')return next();
  api.push({method:r.method,path:p});
  if(p==='/api/client-feedback/stream'){s.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});s.write('event: connected\ndata: '+JSON.stringify({availability})+'\n\n');streams.add(s);r.on('close',()=>streams.delete(s));return}
  if(r.method==='POST'){
    let body='';for await(const chunk of r)body+=chunk; let data;try{data=JSON.parse(body)}catch{data={}}
    posts.push({path:p,data});
    if(p==='/api/client-feedback/attachments'){await waitBoundary('upload');return send({attachment:{id:'a1',name:'fixture.png',url:'/uploads/client-feedback/fixture.png',mimeType:'image/png',size:100}})}
    if(p.endsWith('/messages')){await waitBoundary('reply');messages.push({id:'m'+messages.length,conversationId:'f1',senderType:'client',senderName:user.username,messageType:'text',internalOnly:false,content:data.content,attachments:[],createdAt:new Date().toISOString()});return send({})}
    if(p==='/api/client-feedback/conversations'){await waitBoundary('create');return send({conversation})}
    return send({});
  }
  if(p==='/api/client-feedback/portal-config')return send({entryNotice:'隔离反馈 fixture',availability});
  if(p==='/api/client-feedback/conversations')return send({list:[conversation],total:1,page:1,pageSize:100});
  if(p==='/api/client-feedback/conversations/f1'){detailReads++;await waitBoundary('detail');return send({conversation,messages})}
  if(p==='/api/client-auth/me')return send(user);
  if(p==='/api/auth/me')return send(null,401);
  if(p.endsWith('/capabilities'))return send({enabled:false,channels:{mobile:true,email:true},registerValidationModes:{mobile:'verification_code',email:'verification_code'},forgotPasswordEnabled:true,departmentTree:[],departmentRootOptions:[],departmentOptions:[]});
  if(p.endsWith('/mall/products'))return send({list:products,storefront});
  if(p.endsWith('/mall/storefront'))return send(storefront);
  if(p.includes('/restock-requests/active'))return send({restock:null,serverNow:new Date().toISOString()});
  if(p.endsWith('/captcha'))return send({captchaId:'fixture',captchaSvg:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="10" y="25">1234</text></svg>',expiresInSeconds:300});
  if(p.includes('preorders'))return send({records:[],total:0,page:1,pageSize:20});
  if(p.includes('kingdee'))return send({items:[],list:[],total:0,hasUnread:false});
  if(p==='/health')return send({status:'UP'});
  return send(null,404);
})}};
let vite,chrome,page;
try{
process.chdir(root);process.env.VITE_DEV_SERVER_HTTPS='false';
vite=await createServer({root,cacheDir:path.join(evidence,'vite-cache'),plugins:[fixture],server:{host:'127.0.0.1',port:0,strictPort:false,open:false},optimizeDeps:{force:false}});await vite.listen();
const origin='http://127.0.0.1:'+vite.httpServer.address().port;
const profile=path.join(evidence,'chrome-baseline-'+Date.now());fs.mkdirSync(profile,{recursive:true});
chrome=spawn(process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});let spawnError;chrome.once('error',e=>spawnError=e);
let port;for(let i=0;i<200;i++){if(spawnError)throw spawnError;try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break}catch{}await delay(100)}
if(!port)throw Error('Chrome 调试端口超时');const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();const socket=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise((res,rej)=>{socket.addEventListener('open',res,{once:true});socket.addEventListener('error',rej,{once:true})});page=new CdpPage(socket);
await page.send('Page.enable');await page.send('Runtime.enable');await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('y-link.client-auth.user',${JSON.stringify(JSON.stringify(user))});localStorage.setItem('y-link.client-auth.expiresAt','2099-01-01T00:00:00.000Z');document.cookie='y_link_client_csrf=fixture';localStorage.setItem('y-link-theme-preference','dark');`});
const save=async name=>{const r=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(r.data,'base64'))};
let present=false,purchase=false,restock;
if(!onlyScene){
await page.send('Page.navigate',{url:origin+'/client/mall'});for(let i=0;i<150;i++){await delay(300);if(await page.evaluate(`!!document.querySelector('.client-card-stepper__plus')`))break;}

await save('after-mall-390');
present=await page.evaluate(`!!document.querySelector('.client-card-stepper__plus')`);
if(present){await page.evaluate(`document.querySelector('.client-card-stepper__plus').click()`);for(let i=0;i<7;i++){await save('after-split-'+i);await delay(40)}await page.evaluate(`document.querySelector('.client-card-stepper__minus').click()`);for(let i=0;i<7;i++){await save('after-stepper-collapse-'+i);await delay(40)}}
await page.evaluate(`Array.from(document.querySelectorAll('.client-product-card__body')).find(e=>e.textContent.includes('详情规格基线商品')).click()`);await delay(500);
purchase=await page.evaluate(`!!document.querySelector('.client-detail-action-bar.is-purchase')`);if(!purchase)throw Error('未进入有货详情');await save('after-detail-purchase');
await page.evaluate(`Array.from(document.querySelectorAll('.client-detail-sku-option')).find(e=>e.textContent.trim()==='无货SKU2').click()`);
for(let i=0;i<7;i++){await save('after-detail-restock-merge-'+i);await delay(40)}
restock=await page.evaluate(`({mode:document.querySelector('.client-detail-action-bar')?.className,label:document.querySelector('.client-detail-cart-button')?.textContent.trim(),qtyInert:document.querySelector('.client-detail-qty-collapse')?.inert})`);
if(!restock.mode?.includes('is-restock')||restock.label!=='申请补货'||!restock.qtyInert)throw Error('缺货合并状态断言失败:'+JSON.stringify(restock));
await page.evaluate(`Array.from(document.querySelectorAll('.client-detail-sku-option')).find(e=>e.textContent.trim()==='有货SKU1').click()`);for(let i=0;i<7;i++){await save('after-detail-purchase-split-'+i);await delay(40)}
}
const results=[];
const until=async(check,label)=>{for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('等待超时：'+label)};
const click=async(text)=>{const hit=await page.evaluate(`(()=>{const e=Array.from(document.querySelectorAll('button,a')).find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)return false;e.click();return true})()`);assert.ok(hit,'动作入口存在：'+text)};
const fill=async(selector,value)=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('输入框不存在');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
const navigate=async(route,selector)=>{await page.send('Page.navigate',{url:origin+route});await until(()=>page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),route)};
const scene=async(name,run)=>{if(onlyScene&&!name.includes(onlyScene))return;const row={name,status:'running'};results.push(row);try{await run();row.status='passed'}catch(error){row.status='failed';row.error=error.message;throw error}finally{fs.writeFileSync(path.join(evidence,'behavior-results.json'),JSON.stringify({fixture:true,realBackend:false,results,runtimeErrors:page.runtimeErrors},null,2))}};
await scene('商城既有分裂/收拢、详情有货缺货反向切换',async()=>{assert.ok(present&&purchase);assert.equal(restock.label,'申请补货');assert.equal(restock.qtyInert,true)});
if(!onlyScene)await page.evaluate(`document.querySelector('[aria-label="关闭商品详情"]').click()`);
await scene('发送期间新增正文不会被清空',async()=>{
  await navigate('/client/feedback/f1','textarea[placeholder^="例如：今天"]');await delay(500);
  await fill('textarea[placeholder^="例如：今天"]','已发送正文A');waits.set('reply',true);await click('发送补充说明');await until(()=>pending.has('reply'),'消息进入延迟边界');
  await fill('textarea[placeholder^="例如：今天"]','后续新正文B');release('reply');await until(()=>page.evaluate(`!document.querySelector('button[disabled]')?.textContent.includes('发送中')`),'消息完成');await delay(500);
  assert.equal(await page.evaluate(`document.querySelector('textarea[placeholder^="例如：今天"]').value`),'后续新正文B');await save('feedback-new-draft');
});
await scene('SSE响应不覆盖期间编辑',async()=>{
  waits.set('detail',true);const before=detailReads;
  for(const stream of streams)stream.write('event: conversation\ndata: '+JSON.stringify({eventType:'message',conversationId:'f1',clientUserId:user.id,occurredAt:new Date().toISOString(),conversation})+'\n\n');
  await until(()=>detailReads>before&&pending.has('detail'),'SSE回读进入边界');await fill('textarea[placeholder^="例如：今天"]','实时刷新期间的新内容');release('detail');await delay(500);
  assert.equal(await page.evaluate(`document.querySelector('textarea[placeholder^="例如：今天"]').value`),'实时刷新期间的新内容');
});
await scene('新建提交后离页不被迟到响应拉回',async()=>{
  await navigate('/client/feedback/create','input[aria-label="问题标题"]');
  await fill('input[aria-label="问题标题"]','隔离提交');await fill('textarea[aria-label="问题描述"]','隔离说明');
  waits.set('create',true);await click('提交反馈并进入会话');await until(()=>pending.has('create'),'新建已请求');
  // 同一 SPA 中离页，不能用整页刷新掩盖异步回调问题。
  await click('返回');await until(()=>page.evaluate(`!location.pathname.endsWith('/create')`),'离开新建页');const pathBefore=await page.evaluate('location.pathname');release('create');await delay(700);assert.equal(await page.evaluate('location.pathname'),pathBefore);
});
await scene('上传中按钮与handler共同阻止提交',async()=>{
  await navigate('/client/feedback/create','input[aria-label="问题标题"]');await fill('input[aria-label="问题标题"]','上传互斥');await fill('textarea[aria-label="问题描述"]','图片还在上传');
  waits.set('upload',true);
  await page.evaluate(`(async()=>{const b=await(await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')).blob();const input=document.querySelector('input[type=file]'),dt=new DataTransfer();dt.items.add(new File([b],'fixture.png',{type:'image/png'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await until(()=>pending.has('upload'),'上传延迟边界');const before=posts.filter(x=>x.path==='/api/client-feedback/conversations').length;
  assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='提交反馈并进入会话').disabled`),true);
  // 直接调用真实组件的生产 handler，覆盖 disabled 按钮以外的程序化路径。
  await page.evaluate(`(()=>{let v=document.querySelector('input[aria-label="问题标题"]')?.__vueParentComponent;while(v&&!v.setupState?.handleCreateConversation)v=v.parent;if(!v)throw Error('找不到生产提交handler');return v.setupState.handleCreateConversation()})()`);
  assert.equal(posts.filter(x=>x.path==='/api/client-feedback/conversations').length,before);release('upload');
});
assert.ok(results.length>0,'指定场景必须实际执行，不能空通过');
fs.writeFileSync(path.join(evidence,'action-assertions.json'),JSON.stringify({fixture:true,theme:'dark',viewport:[390,844],results,covered:results.filter(x=>x.status==='passed').map(x=>x.name),notCovered:['真实后端业务写入','二维码失败注入','完整订单改撤退','auth全流程','Redis多实例','实际Nginx']},null,2));
console.log(JSON.stringify({origin,evidence,present,runtimeErrors:page.runtimeErrors}));
}finally{for(const name of pending.keys())release(name);for(const stream of streams)stream.end();page?.close();if(chrome?.pid&&chrome.exitCode===null)chrome.kill();await vite?.close()}



