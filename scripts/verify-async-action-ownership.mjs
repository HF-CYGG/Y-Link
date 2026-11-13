/**
 * 模块说明：实际页面异步操作归属回归。
 * 文件职责：执行生产 SFC 的下单收尾、商家进度及反馈三个动作，验证未知结果、恢复确认与跨上下文迟到响应。
 * 实现逻辑：只抽取生产声明，使用真实 Vue ref/watch 和反馈生命周期；网络、确认框与界面提示是可控边界。
 * 维护说明：不复制 handler、不访问真实 API/账号/数据库；购物车数量与后端事务另由对应专项覆盖。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { ref, computed, reactive, watch, nextTick } from 'vue'

const read = (file) => fs.readFileSync(file, 'utf8')
const pageAst = (file) => ts.createSourceFile(file, read(file).split('<script setup lang="ts">')[1].split('</script>')[0], ts.ScriptTarget.Latest, true)
const declarations = (ast, names) => names.map((name) => {
  const declaration = ast.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((item) => item.name.getText(ast) === name)
  assert.ok(declaration?.initializer, `生产声明必须存在：${name}`)
  return `let ${name} = ${declaration.initializer.getText(ast)};`
}).join('\n')
const execute = (source, bindings, names) => {
  const sandbox = { ref, computed, reactive, watch, ...bindings }
  const javascript = ts.transpileModule(`${source}\nglobalThis.subject = {${names.join(',')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  vm.runInNewContext(javascript, sandbox)
  return sandbox.subject
}
const helper = (file) => {
  const output = ts.transpileModule(read(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}; new Function('exports', output)(exports); return exports
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let index=0; index<12; index++) await Promise.resolve(); await nextTick() }
const plain = (value) => JSON.parse(JSON.stringify(value))
const checkoutPolicy = helper('src/views/client/client-checkout-submit-policy.ts')
const checkoutAst = pageAst('src/views/client/ClientCheckoutView.vue')
const checkoutSource = declarations(checkoutAst, ['sendFrozenSubmission'])
const payload = { clientRequestId:'original-key', isSystemApplied:false, pickupContact:'原领取人', items:[{productId:'p',skuId:'s',qty:2}] }
const checkout = ({status, recovered=true, refreshSuccess=true}={}) => {
  const sent=deferred(), refreshed=deferred(), calls={clear:[],consume:[],apply:[],sync:[],success:[],warning:[],error:[],navigate:[],restore:0}
  let current=true
  const subject=execute(checkoutSource, {
    ...checkoutPolicy, submitO2oPreorder:()=>sent.promise,
    normalizeRequestError:(error)=>({status:error.status,message:'fixture'}),
    restorePendingSubmit:()=>{calls.restore++}, clearClientPreorderSubmitLock:(...args)=>calls.clear.push(args), pendingSubmit:ref({payload}),
    clientCartStore:{consumeSubmittedItems:(items)=>calls.consume.push(plain(items)),syncWithCatalog:(items)=>calls.sync.push(items)},
    clientCatalogStore:{products:[{availableStock:8}],applyPreorderSubmission:(items)=>calls.apply.push(items)},
    refreshMallSnapshot:async(context)=>{await refreshed.promise;assert.equal(context.isCurrent(),current);return {success:refreshSuccess}},
    showAppSuccess:(value)=>calls.success.push(value), showAppWarning:(value)=>calls.warning.push(value), showCriticalErrorDialog:(value)=>calls.error.push(value),
    props:{standalone:true},emit:()=>assert.fail('独立宿主不应关闭父弹层'),router:{replace:async(value)=>calls.navigate.push(value)},
  }, ['sendFrozenSubmission'])
  const running=subject.sendFrozenSubmission(payload,()=>current,'owner',recovered)
  if(status!==undefined) sent.reject({status})
  return {calls,running,sent,refreshed,leave:()=>{current=false}}
}
for(const status of [500,501,502,503,504,507,599]) {
  const h=checkout({status});await h.running
  assert.equal(h.calls.clear.length,0,`${status}不能清原请求键`);assert.equal(h.calls.consume.length,0);assert.equal(h.calls.warning.length,1);assert.equal(h.calls.restore,1)
}
{
  const h=checkout();h.sent.reject({status:undefined});await h.running
  assert.equal(h.calls.clear.length,0,'无响应不能清原请求键');assert.equal(h.calls.warning.length,1)
}
for(const status of [400,403,409,422]) {const h=checkout({status});await h.running;assert.equal(h.calls.clear.length,1);assert.equal(h.calls.error.length,1)}
for(const refreshSuccess of [true,false]) {
  const h=checkout({refreshSuccess});h.sent.resolve({order:{id:'original-order'}});await flush()
  assert.deepEqual(h.calls.consume,[payload.items]);assert.equal(h.calls.apply.length,0,'确认恢复不能重复增量扣库存')
  h.refreshed.resolve();await h.running
  assert.equal(h.calls.clear.length,1);assert.equal(h.calls.success.length,1);assert.equal(h.calls.error.length,0);assert.equal(h.calls.warning.length,refreshSuccess?0:1)
  assert.deepEqual(h.calls.navigate,['/client/orders/original-order'])
}
{
  const h=checkout({recovered:false});h.sent.resolve({order:{id:'new'}});await h.running
  assert.equal(h.calls.apply.length,1,'首次提交仍只增量扣一次')
}
{
  const h=checkout();h.leave();h.sent.resolve({order:{id:'old'}});await h.running
  assert.equal(h.calls.clear.length,0);assert.equal(h.calls.consume.length,0);assert.equal(h.calls.navigate.length,0)
}

const progressAst=pageAst('src/views/o2o/O2oOrderQueryView.vue')
const progressNames=['activeBusinessStatus','draftBusinessStatus','businessStatusSaving','businessStatusOwnerGeneration','businessStatusOperation','businessStatusPageActive','handleBusinessStatusChange','deactivatePageRuntime']
const progressWatcher=progressAst.statements.find((statement)=>ts.isExpressionStatement(statement)&&statement.getText(progressAst).startsWith('watch(')&&statement.getText(progressAst).includes('businessStatusOwnerGeneration'))
assert.ok(progressWatcher,'必须执行真实归属watcher')
const progressSource=declarations(progressAst,progressNames)+'\n'+progressWatcher.getText(progressAst)
const order=(id,status='awaiting_shipment')=>({order:{id,preorderNo:id,businessStatus:status}})
const progress=()=>{
  const activeOrderId=ref('A'),activeOrderDetail=ref(order('A')),authStore=reactive({currentUser:{id:'admin'}})
  const confirms=[],posts=[],success=[],errors=[]
  const subject=execute(progressSource,{activeOrderId,activeOrderDetail,authStore,
    pageRuntimeActive:true,document:{removeEventListener:()=>{}},handleVisibilityChange:()=>{},scheduleAutoRefresh:()=>{},stopSecondTick:()=>{},
    getO2oOrderBusinessStatusMeta:(value)=>({label:value}),
    ElMessageBox:{confirm:()=>{const d=deferred();confirms.push(d);return d.promise}},
    updateO2oOrderBusinessStatus:(id,value)=>{const d=deferred();posts.push({id,value,...d});return d.promise},
    mergeOrderSummaryFromDetail:()=>{},showAppSuccess:(value)=>success.push(value),showAppError:(value)=>errors.push(value),
  },progressNames)
  return {subject,activeOrderId,activeOrderDetail,authStore,confirms,posts,success,errors,
    switch:(id)=>{activeOrderId.value=id??'';activeOrderDetail.value=id?order(id,'preparing'):null},
    unmount:()=>subject.deactivatePageRuntime(),
  }
}
// 生命周期变量由handler闭包读取，卸载测试必须执行真实deactivate中的归属失效语句。
const deactivate=progressAst.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(d=>d.name.getText(progressAst)==='deactivatePageRuntime')
assert.ok(deactivate.initializer.getText(progressAst).includes('businessStatusPageActive = false'))
for(const mode of ['B','empty','ABA','account','unmount']) {
  const h=progress(),p=h.subject.handleBusinessStatusChange('ready')
  if(mode==='unmount')h.unmount()
  else if(mode==='account')h.authStore.currentUser={id:'other'}
  else {h.switch(mode==='empty'?null:'B');if(mode==='ABA')h.switch('A')}
  h.confirms[0].resolve();await p
  assert.equal(h.posts.length,0,`确认期间${mode}不得发请求`)
}
{
  const h=progress(),p=h.subject.handleBusinessStatusChange('ready');h.confirms[0].resolve();await flush()
  h.switch('B');h.switch('A');h.posts[0].resolve(order('A','ready'));await p
  assert.equal(h.activeOrderDetail.value.order.businessStatus,'preparing','在途A→B→A也不能复活旧操作')
}
{
  const h=progress(),p=h.subject.handleBusinessStatusChange('ready');h.switch('B');h.confirms[0].reject('cancel');await p
  assert.equal(h.subject.draftBusinessStatus.value,'preparing','取消旧确认不能覆盖B草稿')
}
for(const reject of [false,true]) {
  const h=progress(),p=h.subject.handleBusinessStatusChange('ready');h.confirms[0].resolve();await flush()
  assert.equal(h.posts[0].id,'A');h.switch('B')
  const next=h.subject.handleBusinessStatusChange('after_sale');h.confirms[1].resolve();await flush()
  if(reject)h.posts[0].reject(new Error('old failure'));else h.posts[0].resolve(order('A','ready'))
  await p
  assert.equal(h.activeOrderDetail.value.order.id,'B');assert.equal(h.subject.businessStatusSaving.value,true,'旧finally不能清新操作saving')
  assert.equal(h.success.length,0);assert.equal(h.errors.length,0)
  h.posts[1].resolve(order('B','after_sale'));await next
  assert.equal(h.activeOrderDetail.value.order.businessStatus,'after_sale')
}

const feedbackAst=pageAst('src/views/client/ClientFeedbackDetailView.vue')
const feedbackNames=['handleConfirmResolved','handleWithdrawConversation','handleSubmitSatisfaction']
const feedbackWatcher=feedbackAst.statements.find(statement=>ts.isExpressionStatement(statement)&&statement.getText(feedbackAst).startsWith('watch(')&&statement.getText(feedbackAst).includes('detailLifecycle.invalidatePage'))
assert.ok(feedbackWatcher)
const feedbackSource=declarations(feedbackAst,feedbackNames)+'\n'+feedbackWatcher.getText(feedbackAst)
const {createFeedbackDetailLifecycle}=helper('src/views/client/client-feedback-detail-lifecycle.ts')
const replyPolicy=helper('src/views/client/client-feedback-reply-policy.ts')
const feedback=()=>{
  let mounted=true
  const route=reactive({params:{id:'A'}}),clientAuthStore=reactive({currentUser:{id:'owner'},sessionGeneration:1})
  const conversation=ref({id:'A',issueNo:'A',status:'resolved',satisfaction:null}),confirms=[],posts=[],reads=[],success=[],errors=[]
  const fields=Object.fromEntries(['replySubmitting','confirmingResolved','withdrawingConversation','satisfactionSubmitting','uploadingReplyAttachments','satisfactionDialogVisible','unavailable','loading','detailLoading'].map(name=>[name,ref(false)]))
  Object.assign(fields,Object.fromEntries(['satisfactionComment','replyDraft','previewImageUrl','loadError','refreshWarning','reconnectTip'].map(name=>[name,ref('')])),{replyAttachments:ref([]),selectedSatisfactionLevel:ref('satisfied'),availability:ref(null)})
  const detailLifecycle=createFeedbackDetailLifecycle({isMounted:()=>mounted,readContext:()=>({ownerId:clientAuthStore.currentUser?.id,sessionGeneration:clientAuthStore.sessionGeneration,conversationId:route.params.id})})
  const post=(kind,id,payload)=>{const d=deferred();posts.push({kind,id,payload:payload&&plain(payload),...d});return d.promise}
  const subject=execute(feedbackSource,{...fields,...replyPolicy,conversation,route,clientAuthStore,detailLifecycle,
    detailRequest:{cancel:()=>{}},stopRealtime:()=>{},normalizeSubmitText:(value)=>value.trim(),
    canWithdrawConversation:computed(()=>conversation.value?.status!=='closed'),canRateSatisfaction:computed(()=>['resolved','closed'].includes(conversation.value?.status)),hasRatedSatisfaction:computed(()=>Boolean(conversation.value?.satisfaction)),
    ElMessageBox:{confirm:()=>{const d=deferred();confirms.push(d);return d.promise}},
    confirmClientFeedbackResolved:id=>post('confirm',id),withdrawClientFeedbackConversation:id=>post('withdraw',id),submitClientFeedbackSatisfaction:(id,payload)=>post('rating',id,payload),
    loadConversationDetail:async(id)=>{const d=deferred();reads.push({id,...d});await d.promise},
    showAppSuccess:value=>success.push(value),showAppWarning:()=>{},showAppError:value=>errors.push(value),showCriticalErrorDialog:value=>errors.push(value),
  },feedbackNames)
  const change=(mode)=>{
    if(mode==='account')clientAuthStore.currentUser={id:'other'}
    else if(mode==='session')clientAuthStore.sessionGeneration++
    else if(mode==='unmount'){mounted=false;detailLifecycle.invalidatePage()}
    else {route.params.id='B';if(mode==='ABA')route.params.id='A'}
    conversation.value={id:route.params.id,issueNo:route.params.id,status:'resolved',satisfaction:null}
  }
  return {subject,fields,conversation,confirms,posts,reads,success,errors,change}
}
const handlers={confirm:'handleConfirmResolved',withdraw:'handleWithdrawConversation',rating:'handleSubmitSatisfaction'}
for(const mode of ['conversation','account','session','unmount','ABA']) {
  const h=feedback(),running=h.subject.handleWithdrawConversation();h.change(mode);h.confirms[0].resolve();await running
  assert.equal(h.posts.length,0,`撤回确认期间${mode}不得撤回新目标`)
}
for(const [kind,name] of Object.entries(handlers))for(const mode of ['conversation','account','session','unmount','ABA'])for(const rejected of [false,true]) {
  const h=feedback();h.fields.satisfactionComment.value='原评价';const running=h.subject[name]()
  if(kind==='withdraw'){h.confirms[0].resolve();await flush()}
  assert.equal(h.posts[0].id,'A');if(kind==='rating')assert.deepEqual(h.posts[0].payload,{level:'satisfied',comment:'原评价'})
  await h.subject[name]();assert.equal(h.posts.length,1,'在途重复点击不能再发POST')
  h.change(mode)
  if(rejected)h.posts[0].reject(new Error('old failure'));else h.posts[0].resolve({level:'satisfied',comment:'原评价',ratedAt:'2026-11-09T00:00:00Z'})
  await running
  assert.equal(h.reads.length,0,'失效POST回包不能读取新会话');assert.equal(h.success.length,0);assert.equal(h.errors.length,0)
}
for(const [kind,name] of Object.entries(handlers)) {
  const h=feedback(),running=h.subject[name]();if(kind==='withdraw'){h.confirms[0].resolve();await flush()}
  h.posts[0].resolve({level:'satisfied',ratedAt:'2026-11-09T00:00:00Z'});await flush()
  assert.equal(h.reads[0].id,'A');h.reads[0].reject(new Error('GET failed'));await running
  assert.equal(h.success.length,1,'POST成功立即按成功反馈');assert.equal(h.errors.length,0,'回读失败不能提示写入失败')
  assert.ok(h.fields.refreshWarning.value.includes('同步失败'))
  await h.subject[name]();assert.equal(h.posts.length,1,'已确认成功但回读失败不能诱导重复提交')
}
for(const [kind,name] of Object.entries(handlers))for(const mode of ['conversation','account','session','unmount','ABA']) {
  const h=feedback(),running=h.subject[name]();if(kind==='withdraw'){h.confirms[0].resolve();await flush()}
  h.posts[0].resolve({level:'satisfied',ratedAt:'2026-11-09T00:00:00Z'});await flush()
  assert.equal(h.reads[0].id,'A');h.change(mode)
  h.reads[0].reject(new Error('late GET failed'));await running
  assert.equal(h.conversation.value.status,'resolved','迟到回读不能改新会话状态')
  assert.equal(h.fields.refreshWarning.value,'','迟到回读不能写新上下文警告');assert.equal(h.errors.length,0)
}
console.log('[verify:async-action-ownership] 真实下单收尾、商家状态与反馈动作的未知结果/归属/迟到回读回归通过')
