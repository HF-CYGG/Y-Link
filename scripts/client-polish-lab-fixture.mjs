/**
 * 客户端全入口手工/自动浏览器共用 fixture。仅供 loopback 独占验收服务器装配。
 * 所有写入只作用于内存；不连接数据库、不发送短信、不加载真实会话或服务端环境。
 * 失败/延迟控制只改变网络边界，生产页面、Store、路由及真实 qrcode 渲染保持原代码。
 */
export function createClientPolishLab() {
  const now = () => new Date().toISOString()
  const password = 'FixturePass42'
  const users = {
    A: { id:'lab-A',username:'体验甲',realName:'体验甲',account:'体验甲',mobile:'13800000001',email:'a@example.test',departmentName:'隔离部门',accountType:'personal',staffNo:null,staffVerified:false,status:'enabled',emailVerifiedAt:null,mobileVerifiedAt:null,lastLoginAt:null },
    B: { id:'lab-B',username:'体验乙',realName:'体验乙',account:'体验乙',mobile:'13800000002',email:'b@example.test',departmentName:'隔离部门',accountType:'personal',staffNo:null,staffVerified:false,status:'enabled',emailVerifiedAt:null,mobileVerifiedAt:null,lastLoginAt:null },
    teacher: { id:'lab-T',username:'隔离教师',realName:'隔离教师',account:'隔离教师',mobile:'13800000003',email:'teacher@example.test',departmentName:'隔离部门',accountType:'personal',staffNo:'T001',staffVerified:true,status:'enabled',emailVerifiedAt:null,mobileVerifiedAt:null,lastLoginAt:null },
  }
  const price={defaultPrice:'12.00',originalPrice:'12.00',discountRate:'10.00',discountedPrice:'12.00'}
  const sku=(id,productId,value,stock)=>({id,productId,skuCode:id,specValues:{规格:value},specText:value,...price,currentStock:stock,preOrderedStock:0,availableStock:stock,isActive:true,isCurrent:true,o2oRecommended:false,thumbnail:'/__polish/images/original.svg',thumbnailSmall:'/__polish/images/small.svg',sortOrder:0})
  const product=(id,name,skus,tags)=>({id,productCode:id,productName:name,...price,o2oRecommended:false,tags,thumbnail:'/__polish/images/original.svg',thumbnailSmall:'/__polish/images/small.svg',detailContent:'<p>首段 &amp; 实体</p><p>正常比较 2 < 3 与 5 > 4</p>',limitPerUser:0,currentStock:40,preOrderedStock:0,availableStock:40,soldQty:0,skus})
  const products=[product('p1','单规格体验商品',[sku('s1','p1','标准',40)],['分类甲']),product('p2','双规格体验商品',[sku('s2','p2','有货SKU1',40),sku('s3','p2','无货SKU2',0)],['分类乙'])]
  for(let n=3;n<=35;n++)products.push(product('p'+n,'滚动商品'+n,[sku('s'+(n+1),'p'+n,'标准',40)],['分类甲']))
  const initialUsers=structuredClone(users), initialProducts=structuredClone(products)
  const storefront={businessHoursText:'10:00 - 22:00',mallAnnouncementText:'本地隔离验收数据，非业务后端',pickupWindowHours:24}
  const availability={status:'online',reason:'within_work_hours',isOnline:true,withinWorkHours:true,hasOnlineStaff:true,serviceConnectedCount:1,serverTime:now(),workHoursText:'10:00 - 22:00',offlineNotice:'客服暂时离线',offlineFaqs:[]}
  const ledger=[],unexpected=[],records=[],streams=new Set(),holds=new Map(),failures=new Map()
  let session='A',sessionGeneration=0,resetGeneration=0,sequence=4,captcha=0,imageMode='normal',imageVersion=1
  const orders=new Map(), conversations=new Map(), messages=new Map(),restocks=new Map(),intentOrders=new Map()
  function order(id,status='pending',items=[{productId:'p1',skuId:'s1',qty:2}], owner=users.A) {
    const lines=items.map((row,index)=>{const p=products.find(p=>p.id===String(row.productId));const s=p?.skus.find(s=>s.id===String(row.skuId));return {id:id+'-'+index,productId:p.id,skuId:s?.id??null,productCode:p.productCode,productName:p.productName,skuCode:s?.skuCode??null,specText:s?.specText??null,skuImage:p.thumbnail,...price,unitPrice:'12.00',lineAmount:(12*row.qty).toFixed(2),qty:row.qty,returnedQty:0,availableReturnQty:status==='verified'?row.qty:0,subTotal:(12*row.qty).toFixed(2)}})
    const totalQty=lines.reduce((sum,row)=>sum+row.qty,0),totalAmount=(12*totalQty).toFixed(2)
    return {owner:owner.id,order:{id,preorderNo:'LAB-'+id,customerOrderBusinessNo:null,verifyCode:'LAB'+id,status,businessStatus:null,statusReport:null,hasCustomerOrder:false,isSystemApplied:false,kingdeeVoucherNo:null,kingdeeVersion:0,merchantMessage:null,clientOrderType:'walkin',departmentNameSnapshot:null,staffNoSnapshot:null,pickupContact:owner.realName,pickupAt:null,remark:'隔离订单',updateCount:0,maxUpdateCount:3,remainingUpdateCount:3,totalQty,totalAmount,expireInSeconds:3600,timeoutAt:new Date(Date.now()+3600000).toISOString(),verifiedAt:status==='verified'?now():null,createdAt:now()},customerProfile:owner,items:lines,returnRequests:[],amountSummary:{totalQty,totalAmount,totalItemCount:lines.length},storefront,qrPayload:'LAB-PICKUP-'+id}
  }
  function conversation(id,status='processing',subject='隔离反馈',owner=users.A) {
    return {id,conversationNo:'LAB-'+id,clientUserId:owner.id,clientUsername:owner.username,clientAccount:owner.account,clientAccountType:'personal',staffNoSnapshot:null,departmentNameSnapshot:'隔离部门',subject,status,priority:'normal',assignedUserId:null,assignedUsername:null,assignedDisplayName:null,lastMessagePreview:'隔离初始说明',lastMessageSenderType:'client',lastMessageAt:now(),unreadForClientCount:0,unreadForServiceCount:0,createdAt:now(),updatedAt:now(),restock:null,serverNow:now(),satisfaction:null,fields:{issueType:'suggestion',category:'other',orderRef:null,expectedResult:'',actualResult:'隔离初始说明',reproductionSteps:null,contactPreference:null,tags:[],sourceLabel:'本地fixture'}}
  }
  const clone=value=>JSON.parse(JSON.stringify(value))
  function reset(){resetGeneration++;sessionGeneration++;session='A';sequence=4;captcha=0;imageVersion=1;for(const key of Object.keys(users))delete users[key];Object.assign(users,clone(initialUsers));products.splice(0,products.length,...clone(initialProducts));orders.clear();conversations.clear();messages.clear();restocks.clear();intentOrders.clear();ledger.length=0;unexpected.length=0;failures.clear();releaseAll();imageMode='normal';for(const [id,status] of [['o1','pending'],['o2','verified'],['o3','cancelled']])orders.set(id,order(id,status));for(const [id,status] of [['f1','processing'],['f2','resolved'],['f3','closed']]){conversations.set(id,conversation(id,status));messages.set(id,[])}}
  function release(key){const hold=holds.get(key);holds.delete(key);hold?.resolve()}
  function releaseAll(){for(const key of holds.keys())release(key)}
  function emit(id){const value=conversations.get(id);if(!value)return;const event={eventType:'message',conversationId:id,clientUserId:value.clientUserId,occurredAt:now(),conversation:value};for(const s of streams)s.write('event: conversation\ndata: '+JSON.stringify(event)+'\n\n')}
  reset()
  const snapshot=()=>({session,users:clone(users),products:clone(products),orders:[...orders.values()].map(clone),conversations:[...conversations.values()].map(clone),ledger:clone(ledger),unexpected:clone(unexpected),holds:[...holds.keys()],records:clone(records),imageMode,imageVersion,password,verificationCode:'123456'})
  const control=(input)=>{
    if(input.action==='reset')reset()
    else if(input.action==='session'){if(input.user!==null&&!users[input.user])throw Error('未知隔离账号');session=input.user;sessionGeneration++}
    else if(input.action==='hold'){const key=input.key;if(!holds.has(key)){let resolve;const promise=new Promise(done=>resolve=done);holds.set(key,{promise,resolve})}}
    else if(input.action==='release')release(input.key)
    else if(input.action==='failure')failures.set(input.key,{status:input.status??503,message:input.message??'隔离故障',remaining:input.count??1})
    // 仅切换内存目录中的既有 SKU，供同名多规格/失效分组验收；不接触生产数据。
    else if(input.action==='catalog-sku'){
      const target=products.flatMap(p=>p.skus).find(s=>s.id===input.skuId)
      if(!target)throw Error('未知隔离SKU')
      if(input.stock!==undefined&&(!Number.isSafeInteger(input.stock)||input.stock<0))throw Error('库存必须为非负整数')
      if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw Error('启用态必须为布尔值')
      if(input.stock!==undefined){target.availableStock=input.stock;target.currentStock=input.stock;target.preOrderedStock=0}
      if(input.enabled!==undefined)target.isActive=input.enabled
    }
    else if(input.action==='images'){imageMode=input.mode;imageVersion++;for(const p of products){p.thumbnail='/__polish/images/original.svg?v='+imageVersion;if(!input.keepSmall)p.thumbnailSmall='/__polish/images/small.svg?v='+imageVersion;for(const s of p.skus){s.thumbnail=p.thumbnail;if(!input.keepSmall)s.thumbnailSmall=p.thumbnailSmall}}}
    else if(input.action==='order-status'){const detail=orders.get(input.id);if(!detail)throw Error('订单不存在');detail.order.status=input.status;detail.order.statusReport=null;detail.order.verifiedAt=input.status==='verified'?now():null}
    else if(input.action==='feedback-status'){const value=conversations.get(input.id);if(!value)throw Error('会话不存在');value.status=input.status;emit(input.id)}
    else if(input.action==='sse')emit(input.id??'f1')
    else if(input.action==='record'){if(!input.id||!['passed','failed','blocked'].includes(input.status)||!input.evidence?.length)throw Error('必须提供场景ID、状态和证据路径/观察记录');records.push({id:input.id,status:input.status,evidence:input.evidence,at:now()})}
    else throw Error('未知测试控制动作')
    return snapshot()
  }
  const plugin={name:'client-polish-full-entry-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    const url=new URL(req.url,'http://localhost'),p=url.pathname,key=req.method+' '+p
    const send=(data,status=200,message='ok')=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({code:status===200?0:status,message,data}))}
    if(p.startsWith('/__polish/images/')){const missing=imageMode==='all-fail'||imageMode==='small-fail'&&p.endsWith('small.svg');res.writeHead(missing?404:200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});res.end(missing?'':`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#0f766e"/><text x="15" y="65" fill="white">LAB ${imageVersion}</text></svg>`);return}
    if(p.startsWith('/__polish/')){let body='';for await(const chunk of req)body+=chunk;try{if(p==='/__polish/state')return send(snapshot());if(p==='/__polish/control')return send(control(JSON.parse(body)));return send(null,404,'未知测试控制路径')}catch(error){return send(null,400,error.message)}}
    if(!p.startsWith('/api/')&&p!=='/health')return next()
    // 请求到达时固定身份；控制台换号只影响后续请求。
    const requestSession=session, requestUser=requestSession?users[requestSession]:null, requestSessionGeneration=sessionGeneration, requestResetGeneration=resetGeneration
    const clearRequestSession=()=>{if(sessionGeneration===requestSessionGeneration){session=null;sessionGeneration++}}
    const entry={owner:requestUser?.id??null,key,query:Object.fromEntries(url.searchParams),at:now(),body:null,status:null};ledger.push(entry)
    let body={};if(!['GET','HEAD'].includes(req.method)){let raw='';for await(const chunk of req)raw+=chunk;if(req.headers['content-type']?.includes('json'))try{body=JSON.parse(raw)}catch{return send(null,400,'畸形JSON')};entry.body=clone(body);if(entry.body.password)entry.body.password='[fixture-redacted]';if(entry.body.currentPassword)entry.body.currentPassword='[fixture-redacted]';if(entry.body.newPassword)entry.body.newPassword='[fixture-redacted]'}
    const finish=(data,status=200,message='ok')=>{entry.status=status;return send(data,status,message)}
    try{
      await holds.get(key)?.promise
      if(requestResetGeneration!==resetGeneration)return finish(null,409,'fixture已重置，旧请求失效')
      const fail=failures.get(key);if(fail?.remaining>0){fail.remaining--;return finish(null,fail.status,fail.message)}
      if(p==='/health')return finish({status:'UP'})
      if(p==='/api/auth/me')return finish(null,401,'未登录')
      if(p==='/api/client-auth/me')return finish(requestUser,requestUser?200:401,requestUser?'ok':'未登录')
      if(p==='/api/auth/webauthn/capabilities')return finish({enabled:false})
      if(p==='/api/client-auth/capabilities')return finish({channels:{mobile:true,email:true},registerValidationModes:{mobile:'verification_code',email:'verification_code'},forgotPasswordEnabled:true,departmentTree:[],departmentRootOptions:['隔离部门'],departmentOptions:['隔离部门']})
      if(p==='/api/client-auth/captcha')return finish({captchaId:'lab-captcha-'+(++captcha),captchaSvg:`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="10" y="25">1234-${captcha}</text></svg>`,expiresInSeconds:300})
      if(p==='/api/client-auth/login'){if(body.password!==password)return finish(null,401,'用户名或密码错误');sessionGeneration++;session=body.account.includes('乙')?'B':body.account==='T001'?'teacher':'A';res.setHeader('Set-Cookie','y_link_client_csrf=fixture; Path=/; SameSite=Lax');return finish({user:users[session],expiresAt:new Date(Date.now()+3600000).toISOString()})}
      if(p==='/api/client-auth/register')return finish({user:{...users.A,username:body.username??'隔离教师'},expiresAt:new Date(Date.now()+3600000).toISOString()})
      if(p==='/api/client-auth/logout'){clearRequestSession();return finish(true)}
      if(p==='/api/client-auth/verification-code/send'||p.endsWith('/verification-code/send')||p.endsWith('/contact-verification/send'))return finish({expireSeconds:60,userId:requestUser?.id??null})
      if(p==='/api/client-auth/forgot-password/verify')return body.verificationCode==='123456'?finish({resetToken:'fixture-only-reset',expiresInSeconds:300}):finish(null,400,'验证码错误')
      if(p==='/api/client-auth/forgot-password/reset'){clearRequestSession();return finish(true)}
      if(!requestUser && (p.startsWith('/api/client-auth/')||p.startsWith('/api/o2o/')||p.startsWith('/api/client-feedback/')))return finish(null,401,'未登录')
      if(p==='/api/client-auth/change-password'){if(body.currentPassword!==password)return finish(null,400,'原密码错误');clearRequestSession();return finish(true)}
      if(p==='/api/client-auth/profile'&&req.method==='PATCH'){if(body.currentPassword!==password)return finish(null,400,'原密码错误');Object.assign(requestUser,{username:body.username,realName:body.username,mobile:body.mobile??'',email:body.email??''});return finish({...requestUser,requiresRelogin:false})}
      if(p.endsWith('/contact-verification/confirm')){requestUser[body.channel+'VerifiedAt']=now();return finish(requestUser)}
      if(p==='/api/o2o/mall/products')return finish({list:products,storefront})
      if(p==='/api/o2o/mall/storefront')return finish(storefront)
      if(p==='/api/o2o/mall/preorders/kingdee-todos')return finish({list:[],total:0,page:1,pageSize:20})
      if(p==='/api/o2o/mall/preorders'&&req.method==='GET'){let list=[...orders.values()].filter(x=>x.owner===requestUser.id).map(x=>({...x.order,returnRequestCount:x.returnRequests.length,pendingReturnRequestCount:x.returnRequests.filter(x=>x.status==='pending').length,latestReturnRequest:null}));if(url.searchParams.get('status'))list=list.filter(x=>x.status===url.searchParams.get('status'));if(url.searchParams.get('keyword'))list=list.filter(x=>x.preorderNo.includes(url.searchParams.get('keyword')));const page=Number(url.searchParams.get('page')??1),pageSize=Number(url.searchParams.get('pageSize')??20);return finish({list:list.slice((page-1)*pageSize,page*pageSize),total:list.length,page,pageSize})}
      if(p==='/api/o2o/mall/preorders'&&req.method==='POST'){const existing=intentOrders.get(requestUser.id+':'+body.clientRequestId);if(existing)return finish(existing);const value=order('o'+(++sequence),'pending',body.items,requestUser);value.order.pickupContact=body.pickupContact;value.order.remark=body.remark??null;orders.set(value.order.id,value);intentOrders.set(requestUser.id+':'+body.clientRequestId,value);return finish(value)}
      const match=p.match(/^\/api\/o2o\/mall\/preorders\/([^/]+)(?:\/(summary|cancel|returns))?$/)
      if(match){const value=orders.get(match[1]);if(!value||value.owner!==requestUser.id)return finish(null,404,'隔离订单不存在');if(match[2]==='cancel'){value.order.status='cancelled';value.order.statusReport={scenario:'cancelled',cancelReason:'manual',cancellationSource:'client',cancellationRemark:null};return finish(value)}if(match[2]==='returns'){const id='r'+sequence++;const request={id,returnNo:'LAB-'+id,verifyCode:'RETURN'+id,status:'pending',sourceOrderStatus:value.order.status,reason:body.reason,totalQty:body.items.reduce((n,x)=>n+x.qty,0),createdAt:now(),handledAt:null,handledBy:null,verifiedAt:null,verifiedBy:null,rejectedReason:null,qrPayload:'LAB-RETURN-'+id,items:body.items.map((x,i)=>({...value.items.find(y=>y.skuId===x.skuId),id:id+'-'+i,qty:x.qty}))};value.returnRequests.unshift(request);for(const item of value.items){item.returnedQty=Math.min(item.qty,value.returnRequests.filter(r=>r.status==='pending').flatMap(r=>r.items).filter(r=>r.productId===item.productId&&r.skuId===item.skuId).reduce((n,r)=>n+r.qty,0));item.availableReturnQty=Math.max(0,item.qty-item.returnedQty)}return finish(request)}if(match[2]==='summary')return finish({...value.order,returnRequestCount:value.returnRequests.length,pendingReturnRequestCount:value.returnRequests.filter(r=>r.status==='pending').length,latestReturnRequest:value.returnRequests[0]??null});if(req.method==='PATCH'){const next=order(value.order.id,value.order.status,body.items,requestUser);Object.assign(value,{items:next.items,amountSummary:next.amountSummary});Object.assign(value.order,{...next.order,remark:body.remark,updateCount:value.order.updateCount+1,remainingUpdateCount:value.order.remainingUpdateCount-1})}return finish(value)}
      if(p==='/api/client-feedback/portal-config')return finish({entryNotice:'隔离反馈门户',availability})
      if(p==='/api/client-feedback/stream'){entry.status=200;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.write('event: connected\ndata: '+JSON.stringify({availability})+'\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return}
      if(p==='/api/client-feedback/attachments'){const id='a'+sequence++;return finish({attachment:{id,name:'fixture.png',url:'/__polish/images/original.svg',mimeType:'image/png',size:100}})}
      if(p.match(/^\/api\/client-feedback\/attachments\/[^/]+$/)){res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>');entry.status=200;return}
      if(p==='/api/client-feedback/restock-requests/active')return finish({restock:restocks.get(requestUser.id+':'+url.searchParams.get('skuId'))??null,serverNow:now()})
      if(p==='/api/client-feedback/restock-requests'){const previous=restocks.get(requestUser.id+':'+body.skuId);if(previous)return finish({created:false,restock:previous,conversation:conversations.get(previous.conversationId),message:null,serverNow:now()});const id='f'+sequence++,value=conversation(id,'open','商品补货',requestUser);const stock={id:'stock-'+id,conversationId:id,productId:body.productId,skuId:body.skuId,productNameSnapshot:products.find(p=>p.id===body.productId)?.productName??'',productCodeSnapshot:body.productId,skuCodeSnapshot:body.skuId,specTextSnapshot:products.find(p=>p.id===body.productId)?.skus.find(s=>s.id===body.skuId)?.specText??'',quantity:body.quantity,latestPickupAt:body.latestPickupAt,remark:body.remark??null,status:'requested',effectiveStatus:'requested',handledAt:null,createdAt:now(),updatedAt:now(),clientRequestId:body.clientRequestId};value.restock=stock;value.fields.issueType='restock';conversations.set(id,value);messages.set(id,[]);restocks.set(requestUser.id+':'+body.skuId,stock);return finish({created:true,restock:stock,conversation:value,message:null,serverNow:now()})}
      if(p==='/api/client-feedback/conversations'&&req.method==='GET'){const list=[...conversations.values()].filter(x=>x.clientUserId===requestUser.id);return finish({list,total:list.length,page:1,pageSize:100})}
      if(p==='/api/client-feedback/conversations'&&req.method==='POST'){const id='f'+sequence++,value=conversation(id,'open',body.subject,requestUser);Object.assign(value.fields,{...body,issueType:body.issueType,actualResult:body.content});conversations.set(id,value);messages.set(id,[]);return finish({conversation:value})}
      const feedback=p.match(/^\/api\/client-feedback\/conversations\/([^/]+)(?:\/(messages|confirm-resolved|withdraw|satisfaction))?$/)
      if(feedback){const value=conversations.get(feedback[1]);if(!value||value.clientUserId!==requestUser.id)return finish(null,404,'隔离会话不存在');if(feedback[2]==='messages'){messages.get(value.id).push({id:'m'+sequence++,conversationId:value.id,senderType:'client',senderName:requestUser.username,messageType:'text',internalOnly:false,content:body.content,attachments:body.attachments??[],createdAt:now()});emit(value.id);return finish(true)}if(['confirm-resolved','withdraw'].includes(feedback[2])){value.status='closed';emit(value.id);return finish(true)}if(feedback[2]==='satisfaction'){value.satisfaction={...body,ratedAt:now()};return finish({satisfaction:value.satisfaction})}return finish({conversation:value,messages:messages.get(value.id)??[]})}
      unexpected.push({key,at:now()});return finish(null,501,'验收 fixture 未定义此API，不能计为覆盖')
    }catch(error){return finish(null,500,'fixture处理失败：'+error.message)}
  })}}
  // 只包裹测试服务器中的 qrcode 导入；成功仍调用真实库，不以假图片替代二维码。
  const qrPlugin={name:'client-polish-qr-boundary',enforce:'pre',resolveId(id,importer){if(id==='qrcode'&&importer?.includes('ClientOrderDetailView.vue'))return '\0client-polish-qr'},load(id){if(id!=='\0client-polish-qr')return;return `import * as real from 'qrcode';const renderer=real.default??real;export async function toDataURL(...args){await globalThis.__polishQrBoundary?.(args[0]);return renderer.toDataURL(...args)};export default {toDataURL}`}}
  return {plugin,qrPlugin,state:snapshot,control,close(){releaseAll();for(const stream of streams)stream.end()}}
}
