/** 本批统一验收浏览器行为回归；仅在独立深审与集中修复后执行。所有API均由本脚本隔离fixture提供。 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {createLabEvidenceDir,startClientPolishServer} from './client-polish-lab-server.mjs';
const root=process.cwd();
// production不会暴露setupState；程序化门禁执行同一SFC真实handler，浏览器继续验证按钮禁用与请求边界。
const createSource=fs.readFileSync(path.join(root,'src/views/client/ClientFeedbackCreateView.vue'),'utf8').split('<script setup lang="ts">')[1].split('</script>')[0];
const createAst=ts.createSourceFile('ClientFeedbackCreateView.ts',createSource,ts.ScriptTarget.Latest,true);
const createHandler=createAst.statements.filter(ts.isVariableStatement).flatMap(statement=>[...statement.declarationList.declarations]).find(declaration=>declaration.name.getText(createAst)==='handleCreateConversation');
assert.ok(createHandler?.initializer,'必须执行真实创建handler');
const guardCode=ts.transpileModule(`const handler=${createHandler.initializer.getText(createAst)};globalThis.run=handler;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const assertCreateBusyGuards=async()=>{
  for(const [creating,uploading] of [[true,false],[false,true]]){
    let businessRequests=0;
    const sandbox={creating:{value:creating},uploadingAttachments:{value:uploading},currentClientUser:{get value(){assert.fail('忙碌handler不应继续读取业务上下文')}},createClientFeedbackConversation:()=>{businessRequests++;return Promise.resolve({})}};
    vm.runInNewContext(guardCode,sandbox);await sandbox.run();assert.equal(businessRequests,0,'creating/uploading时真实源码handler不得发业务请求');
  }
  console.log('[source-handler] creating/uploading两项真实源码程序化门禁通过；浏览器按钮/API边界另行验证');
};
const onlyScene=process.env.POLISH_SCENE??'';
const evidence=process.env.POLISH_EVIDENCE_DIR?path.resolve(process.env.POLISH_EVIDENCE_DIR):createLabEvidenceDir('ylink-polish-behavior-');
fs.mkdirSync(evidence,{recursive:true});
const source=fs.readFileSync(path.join(root,'scripts/verify-login-theme-transition.mjs'),'utf8');
const CdpPage=new Function(source.slice(source.indexOf('class CdpPage'),source.indexOf('async function waitFor'))+';return CdpPage')();
const user={id:'fixture-1',username:'隔离体验账号',account:'隔离体验账号',realName:'隔离体验账号',mobile:'',email:'demo@example.test',departmentName:'测试',accountType:'personal',status:'enabled',staffVerified:false};
const price={defaultPrice:'12.00',originalPrice:'12.00',discountRate:'10.00',discountedPrice:'12.00'};
const products=[{id:'p1',productCode:'DEMO',productName:'隔离基线商品',...price,o2oRecommended:true,tags:[],thumbnail:null,thumbnailSmall:null,detailContent:'<p>基线商品说明</p>',limitPerUser:0,currentStock:20,preOrderedStock:0,availableStock:20,soldQty:0,skus:[{id:'s1',productId:'p1',skuCode:'DEMO-1',specValues:{},specText:'标准',...price,currentStock:20,preOrderedStock:0,availableStock:20,isActive:true,isCurrent:true,o2oRecommended:true,thumbnail:null,thumbnailSmall:null,sortOrder:0}]}];
products.push({...products[0],id:'p2',productCode:'DETAIL',productName:'详情规格基线商品',skus:[{...products[0].skus[0],id:'d1',productId:'p2',specValues:{规格:'有货SKU1'},specText:'有货SKU1'},{...products[0].skus[0],id:'d2',productId:'p2',specValues:{规格:'无货SKU2'},specText:'无货SKU2',currentStock:0,availableStock:0}]}); const storefront={businessHoursText:'10:00 - 22:00',mallAnnouncementText:'隔离 API fixture，非真实业务后端',pickupWindowHours:24};
const api=[];
let authenticated=true,loginFailure=null,captchaRevision=0;
// API fixture 边界：实际 Vue 页面与事件执行真实代码，网络端仅提供隔离、可延迟的契约数据。
const availability={isOnline:true,offlineFaqs:[],statusText:'在线',serviceHoursText:'测试时段'};
const conversation={id:'f1',conversationNo:'FIXTURE-001',clientUserId:user.id,clientUsername:user.username,clientAccount:user.account,clientAccountType:'personal',staffNoSnapshot:null,departmentNameSnapshot:'测试',subject:'隔离反馈',status:'processing',priority:'normal',assignedUserId:null,assignedUsername:null,assignedDisplayName:null,lastMessagePreview:'初始说明',lastMessageSenderType:'client',lastMessageAt:new Date().toISOString(),unreadForClientCount:0,unreadForServiceCount:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),restock:null,serverNow:new Date().toISOString(),fields:{issueType:'suggestion',category:'other',orderRef:null,expectedResult:'',actualResult:'初始说明',reproductionSteps:null,contactPreference:null,tags:[],sourceLabel:'fixture'}};
const messages=[]; const streams=new Set();
const waits=new Map(), pending=new Map(); let detailReads=0, posts=[];
const waitBoundary=async(name)=>{if(!waits.get(name))return;await new Promise(resolve=>pending.set(name,resolve))};
const release=(name)=>{waits.delete(name);pending.get(name)?.();pending.delete(name)};
const fixture={name:'隔离交互API',configureServer(server){server.middlewares.use(async(r,s,next)=>{
  const p=r.url.split('?')[0];
  const send=(data,status=200,message=status===200?'ok':'fixture 错误')=>{s.writeHead(status,{'Content-Type':'application/json'});s.end(JSON.stringify({code:status===200?0:status,message,data}))};
  if(!p.startsWith('/api/')&&p!=='/health')return next();
  api.push({method:r.method,path:p});
  if(p==='/api/client-feedback/stream'){s.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});s.write('event: connected\ndata: '+JSON.stringify({availability})+'\n\n');streams.add(s);r.on('close',()=>streams.delete(s));return}
  if(r.method==='POST'){
    let body='';for await(const chunk of r)body+=chunk; let data;try{data=JSON.parse(body)}catch{data={}}
    posts.push({path:p,data});
    if(p==='/api/client-auth/login'){
      if(loginFailure)return send(null,loginFailure.status,loginFailure.message);
      authenticated=true;return send({user,expiresAt:'2099-01-01T00:00:00.000Z'});
    }
    if(p==='/api/client-feedback/attachments'){await waitBoundary('upload');return send({attachment:{id:'a1',name:'fixture.png',url:'/uploads/client-feedback/fixture.png',mimeType:'image/png',size:100}})}
    if(p.endsWith('/messages')){await waitBoundary('reply');messages.push({id:'m'+messages.length,conversationId:'f1',senderType:'client',senderName:user.username,messageType:'text',internalOnly:false,content:data.content,attachments:[],createdAt:new Date().toISOString()});return send({})}
    if(p==='/api/client-feedback/conversations'){await waitBoundary('create');return send({conversation})}
    return send({});
  }
  if(p==='/api/client-feedback/portal-config')return send({entryNotice:'隔离反馈 fixture',availability});
  if(p==='/api/client-feedback/conversations')return send({list:[conversation],total:1,page:1,pageSize:100});
  if(p==='/api/client-feedback/conversations/f1'){detailReads++;await waitBoundary('detail');return send({conversation,messages})}
  if(p==='/api/client-auth/me')return authenticated?send(user):send(null,401,'未登录');
  if(p==='/api/auth/me')return send(null,401);
  if(p.endsWith('/capabilities'))return send({enabled:false,channels:{mobile:true,email:true},registerValidationModes:{mobile:'verification_code',email:'verification_code'},forgotPasswordEnabled:true,departmentTree:[],departmentRootOptions:[],departmentOptions:[]});
  if(p.endsWith('/mall/products'))return send({list:products,storefront});
  if(p.endsWith('/mall/storefront'))return send(storefront);
  if(p.includes('/restock-requests/active'))return send({restock:null,serverNow:new Date().toISOString()});
  if(p.endsWith('/captcha'))return send({captchaId:'fixture-'+(++captchaRevision),captchaSvg:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="10" y="25">1234</text></svg>',expiresInSeconds:300});
  if(p.includes('preorders'))return send({records:[],total:0,page:1,pageSize:20});
  if(p.includes('kingdee'))return send({items:[],list:[],total:0,hasUnread:false});
  if(p==='/health')return send({status:'UP'});
  return send(null,404);
})}};
let vite,chrome,page;
try{
vite=await startClientPolishServer({root,output:evidence,plugins:[fixture],readinessRoutes:['/health','/client/mall','/src/main.ts']});
const {origin}=vite;
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
await page.evaluate(`Array.from(document.querySelectorAll('.client-product-card__name')).find(e=>e.textContent.includes('详情规格基线商品')&&e.checkVisibility()).click()`);await delay(500);
purchase=await page.evaluate(`!!document.querySelector('.client-detail-action-bar.is-active.is-purchase')`);if(!purchase)throw Error('未进入有货详情');await save('after-detail-purchase');
await page.evaluate(`Array.from(document.querySelectorAll('.client-detail-mode-pane--single.is-active .client-detail-sku-option')).find(e=>e.textContent.trim()==='无货SKU2'&&e.checkVisibility()).click()`);
for(let i=0;i<7;i++){await save('after-detail-restock-merge-'+i);await delay(40)}
restock=await page.evaluate(`(()=>{const bar=document.querySelector('.client-detail-action-bar.is-active');return {mode:bar?.className,label:bar?.querySelector('.client-detail-cart-button')?.textContent.trim(),qtyInert:bar?.querySelector('.client-detail-qty-collapse')?.inert}})()`);
if(!restock.mode?.includes('is-restock')||restock.label!=='申请补货'||!restock.qtyInert)throw Error('缺货合并状态断言失败:'+JSON.stringify(restock));
await page.evaluate(`Array.from(document.querySelectorAll('.client-detail-mode-pane--single.is-active .client-detail-sku-option')).find(e=>e.textContent.trim()==='有货SKU1'&&e.checkVisibility()).click()`);for(let i=0;i<7;i++){await save('after-detail-purchase-split-'+i);await delay(40)}
}
const results=[];
const until=async(check,label)=>{for(let i=0;i<150;i++){if(await check())return;await delay(100)}throw Error('等待超时：'+label)};
const click=async(text)=>{const hit=await page.evaluate(`(()=>{const e=Array.from(document.querySelectorAll('button,a')).find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)return false;e.click();return true})()`);assert.ok(hit,'动作入口存在：'+text)};
const fill=async(selector,value)=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('输入框不存在');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
const navigate=async(route,selector)=>{await page.send('Page.navigate',{url:origin+route});await until(()=>page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),route)};
const scene=async(name,run)=>{if(onlyScene&&!name.includes(onlyScene))return;const row={name,status:'running'};results.push(row);try{await run();row.status='passed'}catch(error){row.status='failed';row.error=error.message;throw error}finally{fs.writeFileSync(path.join(evidence,'behavior-results.json'),JSON.stringify({fixture:true,realBackend:false,results,runtimeErrors:page.runtimeErrors},null,2))}};
// 只读真实持久化快照作观察；准备与目录同步全部通过用户实际入口，不导入开发TS或修改内部Pinia。
const cartRows=()=>page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify('y-link.client-cart.snapshot:'+user.id)})||'[]').map(x=>({skuId:x.skuId,qty:x.qty,selected:x.selected}))`);
const prepareTwoSkuCart=async()=>{
  await navigate('/client/mall','.client-card-stepper__plus');
  if((await cartRows()).length){
    await page.evaluate(`document.querySelector('.cart-summary-bar').click()`);
    await until(()=>page.evaluate(`!!document.querySelector('.mini-cart-wrapper.is-expanded .expand-clear-btn')?.checkVisibility()`),'迷你购物车清空入口');
    await click('清空');await until(()=>page.evaluate(`!!Array.from(document.querySelectorAll('.el-message-box')).find(e=>e.checkVisibility())`),'清空确认');await click('确认清空');
    await until(async()=>!(await cartRows()).length,'清空后快照为空');
    await until(()=>page.evaluate(`!Array.from(document.querySelectorAll('.el-message-box')).some(e=>e.checkVisibility())`),'清空确认关闭');
    await page.evaluate(`if(document.querySelector('.mini-cart-wrapper.is-expanded'))document.querySelector('.cart-summary-bar').click()`);
  }
  await page.evaluate(`Array.from(document.querySelectorAll('.client-product-card__name')).find(e=>e.textContent.includes('详情规格基线商品')&&e.checkVisibility()).click()`);
  await until(()=>page.evaluate(`!!document.querySelector('.client-detail-mode-toggle')`),'详情选购模式');
  await page.evaluate(`Array.from(document.querySelectorAll('.client-detail-mode-toggle .el-radio-button')).find(e=>e.textContent.trim()==='多规格选购').click()`);
  await until(()=>page.evaluate(`!!document.querySelector('.client-detail-mode-pane--multi.is-active button[aria-label="增加无货SKU2数量"]:not([disabled])')`),'两SKU真实可购');
  await fill('input[aria-label="有货SKU1本次数量"]','2');await fill('input[aria-label="无货SKU2本次数量"]','2');
  await page.evaluate(`document.querySelector('.client-detail-batch-bar.is-active button').click()`);
  await until(async()=>{const rows=await cartRows();return rows.length===2&&rows.every(item=>item.qty===2&&item.selected)},'多规格真实批量加购2+2');
};
await scene('商城既有分裂/收拢、详情有货缺货反向切换',async()=>{assert.ok(present&&purchase);assert.equal(restock.label,'申请补货');assert.equal(restock.qtyInert,true)});
if(!onlyScene)await page.evaluate(`Array.from(document.querySelectorAll('[aria-label="关闭商品详情"]')).find(e=>e.checkVisibility()).click()`);
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
  // 源码程序化门禁不依赖production不存在的devtools入口，也不能由ElButton内部disabled保护冒充。
  await assertCreateBusyGuards();
  assert.equal(posts.filter(x=>x.path==='/api/client-feedback/conversations').length,before);release('upload');
});
await scene('登录字段错误、首错焦点与autocomplete',async()=>{
  authenticated=false;
  await navigate('/client/login','#client-login-account');
  const before=posts.filter(x=>x.path==='/api/client-auth/login').length;
  await click('进入商品大厅');
  await until(()=>page.evaluate(`document.activeElement?.id==='client-login-account'`),'空账号首错焦点');
  assert.equal(await page.evaluate(`document.querySelector('#client-login-account').getAttribute('aria-invalid')`),'true');
  assert.equal(await page.evaluate(`document.querySelector('#client-login-account').getAttribute('autocomplete')`),'username');
  assert.equal(await page.evaluate(`document.querySelector('#client-login-password').getAttribute('autocomplete')`),'current-password');
  await fill('#client-login-account',user.username);await click('进入商品大厅');
  await until(()=>page.evaluate(`document.activeElement?.id==='client-login-password'`),'空密码首错焦点');
  assert.equal(posts.filter(x=>x.path==='/api/client-auth/login').length,before,'本地校验不能发送登录');
  await save('ux-login-field-errors');
});
await scene('登录servererror和lock验证码恢复',async()=>{
  authenticated=false;await navigate('/client/login','#client-login-account');
  await fill('#client-login-account',user.username);await fill('#client-login-password','WrongPass42');
  loginFailure={status:401,message:'用户名或密码错误'};
  await click('进入商品大厅');await until(()=>page.evaluate(`!!document.querySelector('#client-login-captcha')`),'错误后显示验证码');
  const before=posts.filter(x=>x.path==='/api/client-auth/login').length;
  await click('进入商品大厅');await until(()=>page.evaluate(`document.activeElement?.id==='client-login-captcha'`),'空验证码首错焦点');
  assert.equal(posts.filter(x=>x.path==='/api/client-auth/login').length,before);
  const previous=captchaRevision;
  loginFailure={status:429,message:'账号已锁定，请稍后重试'};
  await fill('#client-login-captcha','1234');await click('进入商品大厅');
  await until(()=>captchaRevision>previous,'锁定响应刷新验证码');
  await until(()=>page.evaluate(`document.querySelector('#client-login-captcha').value===''&&!document.querySelector('.submit-btn').disabled`),'验证码清空且按钮恢复');
  assert.equal(await page.evaluate(`document.body.textContent.includes('锁定')`),true);
  await save('ux-login-locked-captcha');loginFailure=null;authenticated=true;
});
await scene('购物车同名不同SKU标签、选择加减与失效商品',async()=>{
  authenticated=true;
  const p=products[1];p.skus[1].availableStock=20;p.skus[1].currentStock=20;
  await prepareTwoSkuCart();
  await navigate('/client/cart','input[type="checkbox"]');
  const label=action=>`${action}详情规格基线商品，`;
  const byLabel=async(label)=>{const hit=await page.evaluate(`(()=>{const e=document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']');if(!e)return false;e.click();return true})()`);assert.ok(hit,'存在独立SKU动作：'+label)};
  const rows=cartRows;
  await byLabel(label('选择')+'有货SKU1');
  let state=await rows();assert.equal(state.find(x=>x.skuId==='d1').selected,false);assert.equal(state.find(x=>x.skuId==='d2').selected,true);
  await byLabel(label('增加')+'有货SKU1数量');await byLabel(label('减少')+'无货SKU2数量');
  state=await rows();assert.equal(state.find(x=>x.skuId==='d1').qty,3);assert.equal(state.find(x=>x.skuId==='d2').qty,1);
  p.skus[1].isActive=false;
  await navigate('/client/cart','input[type="checkbox"]');
  await until(()=>page.evaluate(`!!document.querySelector('[aria-label="选择失效商品详情规格基线商品，无货SKU2"]')`),'失效SKU分组');
  await byLabel('选择失效商品详情规格基线商品，无货SKU2');
  state=await rows();assert.equal(state.find(x=>x.skuId==='d2').selected,false);
  await save('ux-cart-sku-labels');
  p.skus[1].isActive=true;
});
await scene('登录和购物车320px移动端无横向溢出',async()=>{
  authenticated=true;products[1].skus[1].isActive=true;products[1].skus[1].availableStock=20;
  await prepareTwoSkuCart();
  await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});
  for(const [route,selector,login]of [['/client/cart','input[type="checkbox"]',false],['/client/login','#client-login-account',true]]){
    authenticated=!login;await navigate(route,selector);
    await until(()=>page.evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`),'320px页面无横向溢出：'+route);
    await save('ux-mobile-'+(login?'login':'cart'));
  }
});
assert.ok(results.length>0,'指定场景必须实际执行，不能空通过');
fs.writeFileSync(path.join(evidence,'action-assertions.json'),JSON.stringify({fixture:true,theme:'dark',viewport:[390,844],results,covered:results.filter(x=>x.status==='passed').map(x=>x.name),notCovered:['真实后端业务写入','二维码失败注入','完整订单改撤退','auth全流程','Redis多实例','实际Nginx']},null,2));
console.log(JSON.stringify({origin,evidence,present,runtimeErrors:page.runtimeErrors}));
}finally{for(const name of pending.keys())release(name);for(const stream of streams)stream.end();page?.close();if(chrome?.pid&&chrome.exitCode===null)chrome.kill();await vite?.close()}



