/** 金蝶实际组件行为：编辑草稿/冲突、替换清空、提醒会话与独立版本响应收敛。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test, { beforeEach, afterEach } from 'node:test'
import { reactive } from 'vue'
import { AxiosError, isCancel } from 'axios'
import { root, host, compileBehaviorSfc, buildModule, freshness, mountBehavior, withBrowser, deferred, flush, unmountAll } from './vue-behavior-test-runtime.mjs'
const output = path.join(root,'tmp/coverage-vue-kingdee')
const editor = await compileBehaviorSfc('src/components/common/KingdeeRegistrationEditor.vue',path.join(output,'KingdeeRegistrationEditor-setup.mjs'))
const reminder = await compileBehaviorSfc('src/views/client/components/ClientKingdeeReminder.vue',path.join(output,'ClientKingdeeReminder-setup.mjs'))
const voucher = await compileBehaviorSfc('src/views/order-list/components/OrderVoucherTemplate.vue',path.join(output,'OrderVoucherTemplate-setup.mjs'))
const api = await freshness()
const summary = await buildModule('src/utils/client-order-summary.ts',path.join(output,'client-order-summary.mjs'))
const formatter = await buildModule('src/utils/kingdee-status.ts',path.join(output,'kingdee-status.mjs'))
let identity = 0
const registration = (version=5,no='001-AbC') => ({ kingdeeVersion:version, kingdeeVoucherNo:no, kingdeeStatus:no?'registered':'applied_pending', kingdeeEditable:true, isSystemApplied:true })
const detail = (version=5,no='001-AbC') => ({ order:{ id:'preorder-1', clientOrderType:'department', ...registration(version,no) } })
beforeEach(() => {
  identity+=1; api.setKingdeeIdentity('client',`client-${identity}`); api.setKingdeeIdentity('admin',`admin-${identity}`)
  host.auth=reactive({ initialized:true, initializing:false, currentUser:{ id:`client-${identity}` } })
  host.navigations.length=0; host.api={}
})
afterEach(unmountAll)
test('替换/清空时申请标记仍true，草稿不受轮询覆盖；成功后的旧props不能倒退',async()=>withBrowser(async()=>{
  const requests=[], events=[]
  host.api.updateMyKingdeeRegistration=async(id,payload)=>{ requests.push({id,payload}); return detail(payload.expectedKingdeeVersion+1,payload.kingdeeVoucherNo) }
  const {state,props}=mountBehavior(editor,{orderId:'preorder-1',registration:registration()},(...args)=>events.push(args))
  state.begin(); state.draft.value='  New-Number  '
  props.registration=registration(6,'跨设备编号'); await flush()
  assert.equal(state.draft.value,'  New-Number  '); assert.equal(state.version.value,5,'轮询不能替用户确认提交版本')
  // 模拟冲突之后用户显式重新开始编辑，使用已看到的最新服务器版本。
  state.begin(); state.draft.value='  New-Number  '; await state.save()
  assert.deepEqual(requests[0],{id:'preorder-1',payload:{kingdeeVoucherNo:'New-Number',expectedKingdeeVersion:6}})
  props.registration=registration(5,'旧GET'); await flush()
  assert.equal(state.localRegistration.value.kingdeeVersion,7); assert.equal(state.localRegistration.value.kingdeeVoucherNo,'New-Number')
  state.begin(); state.draft.value=''; await state.save(); props.registration=registration(7,'New-Number'); await flush()
  assert.equal(state.localRegistration.value.kingdeeVersion,8); assert.equal(state.localRegistration.value.kingdeeVoucherNo,null)
  assert.equal(state.localRegistration.value.isSystemApplied,true); assert.equal(state.label.value,'已申请待补编号'); assert.equal(events.length,2)
}))
test('409实际错误模型触发最新读取但保留输入，必须显式确认才可重试',async()=>withBrowser(async()=>{
  let conflicts=true,patches=0
  host.api.updateAdminKingdeeRegistration=async(id,payload)=>{ patches+=1; if(conflicts) throw new AxiosError('Request failed with status code 409',undefined,undefined,undefined,{status:409,data:{code:409,message:'登记已变化'},headers:{},config:{headers:{}}}); return detail(payload.expectedKingdeeVersion+1,payload.kingdeeVoucherNo) }
  host.api.getO2oConsoleOrderDetail=async()=>detail(9,'跨设备修改')
  const {state}=mountBehavior(editor,{orderId:'preorder-1',registration:registration(),admin:true})
  state.begin(); state.draft.value='自己的意图'; await state.save()
  assert.equal(state.draft.value,'自己的意图'); assert.equal(state.conflictVersion.value,9); assert.equal(state.version.value,5)
  await state.save(); assert.equal(patches,1,'没有确认时不能重放提交')
  state.confirmConflict(); conflicts=false; await state.save()
  assert.equal(patches,2); assert.equal(state.localRegistration.value.kingdeeVoucherNo,'自己的意图'); assert.equal(state.localRegistration.value.kingdeeVersion,10)
}))

test('冲突刷新失败保留草稿，关闭编辑后重进；不可编辑与超长编号不发请求',async()=>withBrowser(async()=>{
  let patches=0
  host.api.updateMyKingdeeRegistration=async()=>{ patches+=1; throw new AxiosError('登记冲突',undefined,undefined,undefined,{status:409,data:{code:409,message:'登记已变化'},headers:{},config:{headers:{}}}) }
  host.api.getO2oPreorderDetail=async()=>{ throw new Error('隔离网络不可用') }
  const {state,props}=mountBehavior(editor,{orderId:'conflict-refresh',registration:registration(),canEdit:false})
  state.begin(); state.draft.value='自己的草稿'; await state.save(); assert.equal(patches,0)
  props.canEdit=true; state.draft.value='字'.repeat(129); await state.save(); assert.equal(patches,0); assert.match(state.message.value,/128/)
  state.draft.value='自己的草稿'; await state.save()
  assert.equal(patches,1); assert.equal(state.draft.value,'自己的草稿'); assert.equal(state.busy.value,false)
  assert.match(state.message.value,/冲突且刷新失败/); assert.equal(state.editing.value,true)
  state.begin(); assert.equal(state.version.value,5)
  props.registration={...registration(),kingdeeEditable:false}; await flush(); await state.save(); assert.equal(patches,1)
}))

test('同一会话正常请求保留原错误，切换账号把旧请求失败转换为取消',async()=>{
  const failure=new Error('当前会话真实网络失败')
  await assert.rejects(api.requestWithKingdeeFreshness('client',async()=>{throw failure}),error=>error===failure)
  const waiting=deferred(), pending=api.requestWithKingdeeFreshness('client',()=>waiting.promise)
  api.setKingdeeIdentity('client','another-session'); waiting.reject(failure)
  await assert.rejects(pending,error=>isCancel(error))
})
test('重复提交、失败、非法编号及换号/卸载迟到响应不会串入当前编辑',async()=>withBrowser(async()=>{
  const waiting=deferred(); const events=[]; let patches=0
  host.api.updateMyKingdeeRegistration=()=>{ patches+=1; return waiting.promise }
  const mounted=mountBehavior(editor,{orderId:'preorder-1',registration:registration()},(...args)=>events.push(args))
  const {state}=mounted
  state.begin(); state.draft.value='A\nB'; await state.save(); assert.equal(patches,0); assert.match(state.message.value,/控制字符/)
  state.draft.value='自己的输入'; const pending=state.save(); await state.save(); assert.equal(patches,1)
  api.setKingdeeIdentity('client','different-account'); waiting.resolve(detail(6,'旧账号编号')); await pending; await flush()
  assert.equal(events.length,0); assert.equal(state.editing.value,false); assert.equal(state.localRegistration.value.kingdeeVoucherNo,null)
  const late=deferred(); host.api.updateMyKingdeeRegistration=()=>late.promise
  const next=mountBehavior(editor,{orderId:'preorder-2',registration:registration()}); next.state.begin(); next.state.draft.value='另一单'; const closing=next.state.save(); next.unmount(); late.reject(new Error('旧响应失败')); await closing
  assert.equal(events.length,0)
}))
test('请求层以原预订单kingdeeVersion收敛正式单来源，不依赖Biz版本，旧GET和摘要/凭证不倒退',async()=>withBrowser(async()=>{
  const source=(version,no)=>({sourceOrderId:'formal-source',businessNo:'业务来源',sourcePreorderId:'preorder-1',sourcePreorderNo:'PRE-D-1',...registration(version,no)})
  const order=(version,no)=>({id:'formal-parent',editVersion:12,orderType:'department',inventoryMode:'o2o_preapplied',isSystemApplied:true,sourceDocType:'o2o_preorder',sourcePreorderRegistrations:[source(version,no)],merge:{role:'standalone',children:[]},items:[]})
  const old=deferred(); const request=api.requestWithKingdeeFreshness('admin',()=>old.promise)
  api.synchronizeKingdeeResponse('admin',{order:{id:'preorder-1',...registration(6,'替换编号')}})
  old.resolve({order:order(5,'旧编号')}); const accepted=await request
  assert.equal(accepted.order.editVersion,12); assert.equal(accepted.order.sourcePreorderRegistrations[0].kingdeeVoucherNo,'替换编号')
  const mounted=mountBehavior(voucher,{order:accepted.order,measurePages:false})
  assert.equal(mounted.state.voucherKingdeeNo.value,'替换编号')
  const cleared=api.synchronizeKingdeeResponse('admin',{order:{id:'preorder-1',...registration(7,null)}})
  const response=api.synchronizeKingdeeResponse('admin',{list:[order(5,'旧编号')]})
  mounted.props.order={...response.list[0],items:[]}; await flush()
  assert.equal(mounted.state.voucherKingdeeNo.value,'未登记'); assert.match(formatter.formatOrderKingdeeStatus(response.list[0]),/已申请待补编号/)
  const latest=summary.buildClientOrderSummaryFromDetail({...detail(7,null),order:{...detail(7,null).order,status:'verified',statusReport:{},preorderNo:'PRE-D-1'},items:[],returnRequests:[]})
  assert.equal(latest.kingdeeVersion,7); assert.equal(latest.kingdeeVoucherNo,null)
  assert.equal(cleared.order.isSystemApplied,true)
}))
test('请求层换号后的迟到成功/失败都作为取消，两个权限域相互隔离',async()=>{
  for(const outcome of ['resolve','reject']){
    const waiting=deferred(); const request=api.requestWithKingdeeFreshness('client',()=>waiting.promise)
    api.setKingdeeIdentity('client',`next-${identity}-${outcome}`)
    const rejected=assert.rejects(request,(error)=>isCancel(error))
    waiting[outcome](outcome==='resolve'?detail(99,'旧账号'):new Error('旧账号错误')); await rejected
    assert.equal(api.synchronizeKingdeeResponse('client',detail(1,null)).order.kingdeeVersion,1)
  }
  api.synchronizeKingdeeResponse('admin',detail(50,'管理端')); assert.equal(api.synchronizeKingdeeResponse('client',detail(2,null)).order.kingdeeVersion,2)
})
test('提醒等待服务器会话确认，仅本次打开按账号提醒；关闭/普通路由不重复，分页可跳详情',async()=>withBrowser(async()=>{
  host.auth.initialized=false; const reads=[]
  host.api.getMyKingdeeTodos=async(query)=>{reads.push(query);return{list:[{id:`preorder-${query.page}`,status:'verified',preorderNo:'PRE-D-1'}],total:21,page:query.page,pageSize:20}}
  const mounted=mountBehavior(reminder,{})
  await flush(); assert.equal(reads.length,0)
  host.auth.initialized=true; await flush(); assert.equal(mounted.state.visible.value,true); assert.equal(reads.length,1)
  mounted.state.visible.value=false; mounted.state.page.value=2; await mounted.state.load()
  assert.equal(reads.length,2); assert.equal(reads[1].page,2)
  mounted.state.go('preorder/2'); assert.equal(host.navigations[0],'/client/orders/preorder%2F2')
  mounted.unmount(); const remounted=mountBehavior(reminder,{}); await flush(); assert.equal(remounted.state.visible.value,false); assert.equal(reads.length,2)
}))
test('提醒失败可重试，不当零待办；保存事件更新；退出换号取消迟到响应并清理',async()=>withBrowser(async(browser)=>{
  let fail=true; host.api.getMyKingdeeTodos=async()=>{if(fail)throw new Error('隔离网络失败');return{list:[{id:'preorder-1',status:'verified',preorderNo:'PRE-D-1'}],total:1,page:1,pageSize:20}}
  const mounted=mountBehavior(reminder,{}); await flush(); assert.equal(mounted.state.visible.value,true); assert.match(mounted.state.error.value,/读取失败/)
  fail=false; await mounted.state.load(true); assert.equal(mounted.state.total.value,1)
  host.api.getMyKingdeeTodos=async()=>({list:[],total:0,page:1,pageSize:20})
  // 实际编辑器使用的同一 CustomEvent 通道，不能靠持久已读标记屏蔽更新。
  browser.listeners.get('y-link:client-order-refresh').values().next().value({detail:{orderId:'preorder-1',reason:'compliance_updated',eventAt:Date.now(),sourceId:null}})
  await flush(); assert.equal(mounted.state.total.value,0)
  const old=deferred(), current=deferred(); const signals=[]; let reads=0
  host.api.getMyKingdeeTodos=(_query,config)=>{signals.push(config.signal);reads+=1;return reads===1?old.promise:current.promise}
  const pending=mounted.state.load(true)
  host.auth.currentUser=null; api.setKingdeeIdentity('client',null); await flush()
  assert.equal(signals[0].aborted,true); assert.deepEqual(mounted.state.list.value,[]); assert.equal(mounted.state.total.value,0)
  host.auth.currentUser={id:'next-reminder-account'}; api.setKingdeeIdentity('client','next-reminder-account'); await flush()
  old.resolve({list:[{id:'old-account'}],total:99,page:1,pageSize:20}); await pending; await flush()
  assert.deepEqual(mounted.state.list.value,[]); assert.equal(mounted.state.total.value,0,'旧账号不能回填99条待办')
  current.resolve({list:[{id:'own-account'}],total:1,page:1,pageSize:20}); await flush()
  assert.equal(mounted.state.list.value[0].id,'own-account'); assert.equal(mounted.state.total.value,1)
  const late=deferred(); host.api.getMyKingdeeTodos=()=>late.promise; const lateRequest=mounted.state.load(); mounted.unmount(); late.resolve({list:[{id:'late'}],total:9,page:1,pageSize:20}); await lateRequest
  assert.equal(mounted.state.loading.value,false); assert.deepEqual(mounted.state.list.value,[])
}))

test('活动编辑失败保留草稿/版本，非法长度及无权限不能发送请求',async()=>withBrowser(async()=>{
  let patches=0
  host.api.updateMyKingdeeRegistration=async()=>{patches+=1;throw new Error('隔离网络故障')}
  const {state,props}=mountBehavior(editor,{orderId:'preorder-1',registration:registration()})
  state.begin();state.draft.value='A'.repeat(129);await state.save();assert.equal(patches,0)
  state.draft.value='保留草稿';await state.save();assert.equal(patches,1);assert.equal(state.draft.value,'保留草稿');assert.equal(state.version.value,5);assert.equal(state.busy.value,false);assert.equal(state.editing.value,true);assert.ok(state.message.value)
  props.canEdit=false;await state.save();assert.equal(patches,1)
}))
test('提醒直接卸载后的迟到成功和失败不显示旧数据/旧错误',async()=>withBrowser(async()=>{
  for(const outcome of ['resolve','reject']){
    const waiting=deferred();host.auth.currentUser={id:`reminder-unmount-${outcome}-${identity}`};host.api.getMyKingdeeTodos=()=>waiting.promise
    const mounted=mountBehavior(reminder,{});await flush();mounted.unmount()
    waiting[outcome](outcome==='resolve'?{list:[{id:'late'}],total:99,page:1,pageSize:20}:new Error('过期错误'));await flush()
    assert.deepEqual(mounted.state.list.value,[]);assert.equal(mounted.state.visible.value,false);assert.equal(mounted.state.error.value,'')
  }
}))
