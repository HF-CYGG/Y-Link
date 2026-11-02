/** 金蝶实际组件行为：编辑草稿/冲突、替换清空、提醒会话与独立版本响应收敛。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse, compileScript } from '@vue/compiler-sfc'
import { rolldown } from 'rolldown'
import test, { beforeEach, afterEach } from 'node:test'
import { createRenderer, h, KeepAlive, reactive, ref } from 'vue'
import { AxiosError, isCancel } from 'axios'
import { root, host, compileBehaviorSfc, buildModule, freshness, mountBehavior, withBrowser, deferred, flush, unmountAll } from './vue-behavior-test-runtime.mjs'
const output = path.join(root,'tmp/coverage-vue-kingdee')
const editor = await compileBehaviorSfc('src/components/common/KingdeeRegistrationEditor.vue',path.join(output,'KingdeeRegistrationEditor-setup.mjs'))
const reminder = await compileBehaviorSfc('src/views/client/components/ClientKingdeeReminder.vue',path.join(output,'ClientKingdeeReminder-setup.mjs'))
const voucher = await compileBehaviorSfc('src/views/order-list/components/OrderVoucherTemplate.vue',path.join(output,'OrderVoucherTemplate-setup.mjs'))
const api = await freshness()
const summary = await buildModule('src/utils/client-order-summary.ts',path.join(output,'client-order-summary.mjs'))
const formatter = await buildModule('src/utils/kingdee-status.ts',path.join(output,'kingdee-status.mjs'))

// 直接编译实际父页面/抽屉 setup，仅替换平台与网络边界，不复制保存实现。
async function compileOrderBehavior(relative, inlineTemplate=false) {
  const input=path.join(root,relative), parsed=parse(fs.readFileSync(input,'utf8'),{filename:input})
  const script=compileScript(parsed.descriptor,{id:relative,inlineTemplate})
  const proxies=(names)=>names.map(name=>`export const ${name}=(...args)=>globalThis.__ylinkBehavior.api.${name}(...args)`).join('\n')
  const stubs={
    '@/api/modules/order':proxies(['getOrderDetailById','getOrderRevisions','updateOrderComplianceFlags']),
    '@/api/modules/o2o':proxies(['updateO2oOrderComplianceFlags','getO2oConsoleOrderDetail','getO2oPreorderDetail','updateAdminKingdeeRegistration','updateMyKingdeeRegistration']),
    '@/components/common/business-composite/BizCrudDialogShell.vue':'export default globalThis.__ylinkBehavior.dialogShell',
    '@/components/common':['BizResponsiveDataCollectionShell','BizResponsiveDrawerShell','PageContainer','PagePaginationBar','PageToolbarCard'].map(name=>`export const ${name}={}`).join('\n'),
    '@/store':'export const useAuthStore=()=>globalThis.__ylinkBehavior.auth',
    '@/store/pinia':'export default {}',
    '@/utils/error-dialog':'export const showCriticalErrorDialog=async(error)=>{globalThis.__ylinkBehavior.errors.push(error)}',
    '@/utils/app-alert':['Info','Success','Warning'].map(kind=>`export const showApp${kind}=(message)=>globalThis.__ylinkBehavior.${kind==='Success'?'successes':'warnings'}.push(message)`).join('\n'),
    '@/composables/usePermissionAction':'export const usePermissionAction=()=>{const allowed=()=>Boolean(globalThis.__ylinkBehavior.auth.currentUser?.permissions.includes("orders:update"));return {hasPermission:allowed,ensurePermission:allowed}}',
    './composables/useOrderListView':'export const useOrderListView=()=>globalThis.__ylinkBehavior.orderView',
  }
  const bundle=await rolldown({input,external:['vue','axios','dayjs'],plugins:[{
    name:'出库详情实际行为隔离',
    resolveId(id){
      if(id===input)return input
      if(id==='@/utils/kingdee-freshness')return {id:pathToFileURL(path.join(output,'kingdee-freshness.mjs')).href,external:true}
      if(id in stubs || id.endsWith('.vue'))return `\0order:${id}`
      if(id.startsWith('@/'))return path.join(root,'src',id.slice(2)+'.ts')
    },
    load(id){
      if(id===input)return {code:script.content.replaceAll('import.meta.env.VITE_ORDER_VOUCHER_HTML2PDF_ENABLED','undefined'),moduleType:'ts'}
      if(id.startsWith('\0order:'))return stubs[id.slice(7)]??'export default {}'
    },
  }]})
  const file=path.join(output,path.basename(relative)+(inlineTemplate?'.render':'')+'.mjs')
  await bundle.write({file,format:'esm',codeSplitting:false});await bundle.close()
  return (await import(pathToFileURL(file).href)).default
}
const orderPage=await compileOrderBehavior('src/views/order-list/OrderListView.vue')
const orderDrawer=await compileOrderBehavior('src/views/order-list/components/OrderDetailDrawerContent.vue')

// 渲染生产模板，壳层与 Element 控件仅替换节点协议；事件仍调用真实组件逻辑。
host.dialogShell={inheritAttrs:false,props:['modelValue'],setup(props,{attrs,slots}){
  return()=>props.modelValue?h('section',{'data-dialog':true,...attrs},[slots.default?.(),slots.footer?.()]):null
}}
const renderedEditor=await compileOrderBehavior('src/components/common/KingdeeRegistrationEditor.vue',true)
const uiRenderer=createRenderer({
  createElement:tag=>({tag,props:{},children:[],parent:null}),createText:text=>({text,parent:null}),createComment:()=>({text:'',parent:null}),
  setText:(node,text)=>{node.text=text},setElementText:(node,text)=>{node.children=[{text,parent:node}]},
  patchProp:(node,key,_old,value)=>{node.props[key]=value},
  insert:(node,parent,anchor)=>{if(node.parent){const i=node.parent.children.indexOf(node);if(i>=0)node.parent.children.splice(i,1)}node.parent=parent;const i=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(i<0?parent.children.length:i,0,node)},
  remove:node=>{const i=node.parent?.children.indexOf(node)??-1;if(i>=0)node.parent.children.splice(i,1)},
  parentNode:node=>node.parent,nextSibling:node=>node.parent?.children[node.parent.children.indexOf(node)+1]??null,
})
const uiText=node=>node.text??(node.children??[]).map(uiText).join('')
function mountEditorUi(incoming){
  const tree={children:[]},props=reactive(incoming)
  const app=uiRenderer.createApp({render:()=>h(renderedEditor,props)})
  for(const [name,tag] of [['el-button','button'],['el-input','input'],['el-form','form'],['el-form-item','label']]){
    app.component(name,{inheritAttrs:false,setup(_props,{attrs,slots}){return()=>h(tag,attrs,slots.default?.())}})
  }
  app.mount(tree)
  const find=(predicate,node=tree)=>[...(predicate(node)?[node]:[]),...(node.children??[]).flatMap(child=>find(predicate,child))]
  const button=text=>{const node=find(node=>node.tag==='button'&&uiText(node)===text)[0];assert.ok(node,`应显示按钮：${text}`);return node}
  return{tree,props,find,button,unmount:()=>app.unmount()}
}

// 真实 Vue KeepAlive 驱动生产 setup 的失活/激活 hook；不以壳替身证明 body teleport 行为。
// 真实共享壳、路由返回、遮罩和关闭栈由统一浏览器验收另行覆盖。
function mountKeepAliveEditor(incoming,emit=()=>{}){
  const props=reactive({admin:true,canEdit:true,numberOnly:true,...incoming}),visible=ref(true)
  let state,mounts=0
  const probe={name:'KingdeeKeepAliveLifecycleProbe',setup(){
    mounts+=1;state=editor.setup(props,{emit,expose:()=>{}})
    return()=>h('div')
  }}
  const app=uiRenderer.createApp({render:()=>h(KeepAlive,null,{default:()=>visible.value?h(probe,{key:'editor'}):h('aside',{key:'other'},'其他页面')})})
  app.mount({children:[]})
  return{get state(){return state},get mounts(){return mounts},props,
    async leave(){visible.value=false;await flush()},async enter(){visible.value=true;await flush()},unmount:()=>app.unmount()}
}

test('真实 KeepAlive 空闲编辑失活清理草稿与错误，回到同一实例不恢复旧弹窗',async()=>withBrowser(async()=>{
  let writes=0
  host.api.updateAdminKingdeeRegistration=async()=>{writes+=1;return detail()}
  const mounted=mountKeepAliveEditor({orderId:'keepalive-idle',registration:registration()})
  try{
    const state=mounted.state
    state.begin();state.draft.value='非法\n编号';await state.save()
    assert.match(state.message.value,/控制字符/);assert.equal(state.editing.value,true)
    await mounted.leave()
    assert.equal(state.editing.value,false);assert.equal(state.busy.value,false)
    assert.equal(state.draft.value,'');assert.equal(state.message.value,'');assert.equal(state.version.value,0)
    assert.equal(state.conflictVersion.value,null);assert.equal(state.conflictPending.value,false)
    await mounted.enter();assert.equal(mounted.state,state);assert.equal(mounted.mounts,1,'必须复用真实缓存实例，而非卸载重建')
    assert.equal(state.editing.value,false)
    state.begin();assert.equal(state.draft.value,'001-AbC');assert.equal(state.version.value,5)
    state.setEditing(false);assert.equal(state.editing.value,false);assert.equal(writes,0)
  }finally{mounted.unmount()}
}))

test('真实 KeepAlive 保存中失活绕过用户禁关，迟到成功或失败及 finally 不污染返回后的新保存',async()=>withBrowser(async(browser)=>{
  for(const outcome of ['resolve','reject']){
    const old=deferred(),current=deferred(),signals=[],events=[],refreshes=[];let writes=0,closed=0
    host.api.updateAdminKingdeeRegistration=(_id,_payload,config)=>{signals.push(config.signal);return ++writes===1?old.promise:current.promise}
    browser.listeners.set('y-link:client-order-refresh',new Set([event=>refreshes.push(event.detail)]))
    const mounted=mountKeepAliveEditor({orderId:`keepalive-save-${outcome}`,registration:registration()},(...args)=>events.push(args))
    try{
      const state=mounted.state
      state.begin();state.draft.value='离开前的保存';const pending=state.save()
      state.setEditing(false);state.beforeClose(()=>{closed+=1})
      assert.equal(state.editing.value,true);assert.equal(closed,0,'仍活动时禁止用户关闭')
      await mounted.leave()
      assert.equal(signals[0].aborted,true);assert.equal(state.editing.value,false)
      assert.equal(state.busy.value,false);assert.equal(state.draft.value,'');assert.equal(state.message.value,'')
      await mounted.enter();assert.equal(mounted.mounts,1)
      state.begin();state.draft.value='返回后的保存';const next=state.save()
      old[outcome](outcome==='resolve'?detail(99,'旧保存成功'):new Error('旧保存失败'));await pending
      assert.equal(state.editing.value,true);assert.equal(state.busy.value,true)
      assert.equal(state.draft.value,'返回后的保存');assert.equal(state.version.value,5)
      assert.equal(state.localRegistration.value.kingdeeVoucherNo,'001-AbC');assert.equal(state.message.value,'')
      assert.equal(events.length,0);assert.equal(refreshes.length,0);assert.equal(signals[1].aborted,false)
      await state.save();assert.equal(writes,2,'旧 finally 不得解除新请求 busy')
      current.resolve(detail(6,'返回后的保存'));await next
      assert.equal(state.busy.value,false);assert.equal(state.editing.value,false)
      assert.equal(events.length,1);assert.equal(refreshes.length,1)
    }finally{mounted.unmount()}
  }
}))

test('真实 KeepAlive 的 409 刷新中失活取消读取，迟到成功或失败不写新编辑和冲突确认版本',async()=>withBrowser(async()=>{
  for(const outcome of ['resolve','reject']){
    const latest=deferred(),events=[];let signal,writes=0,reads=0
    host.api.updateAdminKingdeeRegistration=async()=>{writes+=1;throw new AxiosError('冲突',undefined,undefined,undefined,{status:409,data:{code:409,message:'登记已变化'},headers:{},config:{headers:{}}})}
    host.api.getO2oConsoleOrderDetail=(_id,config)=>{reads+=1;signal=config.signal;return latest.promise}
    const mounted=mountKeepAliveEditor({orderId:`keepalive-conflict-${outcome}`,registration:registration()},(...args)=>events.push(args))
    try{
      const state=mounted.state
      state.begin();state.draft.value='冲突前的输入';const pending=state.save();await flush()
      assert.equal(reads,1);assert.equal(state.busy.value,true);assert.equal(state.conflictPending.value,true)
      state.setEditing(false);assert.equal(state.editing.value,true)
      await mounted.leave()
      assert.equal(signal.aborted,true);assert.equal(state.editing.value,false)
      assert.equal(state.draft.value,'');assert.equal(state.message.value,'');assert.equal(state.busy.value,false)
      assert.equal(state.conflictPending.value,false);assert.equal(state.conflictVersion.value,null)
      await mounted.enter();assert.equal(mounted.mounts,1)
      state.begin();state.draft.value='重新编辑的输入'
      latest[outcome](outcome==='resolve'?detail(99,'旧冲突刷新'):new Error('旧冲突读取失败'));await pending
      assert.equal(state.editing.value,true);assert.equal(state.draft.value,'重新编辑的输入')
      assert.equal(state.version.value,5);assert.equal(state.localRegistration.value.kingdeeVersion,5)
      assert.equal(state.message.value,'');assert.equal(state.conflictPending.value,false)
      assert.equal(state.conflictVersion.value,null);assert.equal(state.busy.value,false)
      state.confirmConflict();assert.equal(state.version.value,5)
      assert.equal(writes,1);assert.equal(reads,1);assert.equal(events.length,0)
    }finally{mounted.unmount()}
  }
}))

test('真实模板从右侧更改进入共享弹窗，输入不撑高卡片，保存禁关且成功关闭',async()=>withBrowser(async()=>{
  const waiting=deferred(),requests=[]
  host.api.updateMyKingdeeRegistration=(id,payload)=>{requests.push({id,payload});return waiting.promise}
  const ui=mountEditorUi({orderId:'template-order',registration:{...registration(),preorderNo:'PRE-D-TEMPLATE'},numberOnly:true})
  try{
    assert.equal(ui.find(node=>node.tag==='input').length,0)
    await ui.button('更改').props.onClick();await flush()
    const dialog=()=>ui.find(node=>node.props?.['data-dialog'])[0]
    assert.equal(dialog().props.title,'修改金蝶单据编号');assert.match(uiText(dialog()),/当前来源预订单：PRE-D-TEMPLATE/)
    assert.equal(dialog().props['height-mode'],'auto')
    const input=ui.find(node=>node.tag==='input')[0]
    input.props['onUpdate:modelValue']('  弹窗新编号  ')
    const pending=ui.button('保存').props.onClick();await flush()
    assert.deepEqual(requests,[{id:'template-order',payload:{kingdeeVoucherNo:'弹窗新编号',expectedKingdeeVersion:5}}])
    assert.equal(dialog().props['close-on-click-modal'],false);assert.equal(dialog().props['close-on-press-escape'],false)
    assert.equal(dialog().props['show-close'],false);assert.equal(ui.button('取消').props.disabled,true)
    dialog().props['onUpdate:modelValue'](false);await flush();assert.ok(dialog())
    waiting.resolve(detail(6,'弹窗新编号'));await pending;await flush()
    assert.equal(dialog(),undefined);assert.equal(ui.find(node=>node.tag==='input').length,0)
    assert.match(uiText(ui.tree),/弹窗新编号/);assert.ok(ui.button('更改'))
  }finally{ui.unmount()}
}))

test('真实模板无号显示无与填写，取消无写入，非授权只读不渲染入口',async()=>withBrowser(async()=>{
  host.api.updateMyKingdeeRegistration=async()=>assert.fail('取消或只读不能发写入')
  const ui=mountEditorUi({orderId:'template-empty',registration:registration(5,null),numberOnly:true})
  try{
    assert.match(uiText(ui.tree),/无/);await ui.button('填写').props.onClick();await flush()
    await ui.button('取消').props.onClick();await flush()
    assert.equal(ui.find(node=>node.props?.['data-dialog']).length,0)
    ui.props.canEdit=false;await flush()
    assert.equal(ui.find(node=>node.tag==='button').length,0);assert.match(uiText(ui.tree),/无/)
  }finally{ui.unmount()}
}))

test('金蝶状态不泄露编号并保留各来源状态',()=>{
  const base={orderType:'department',inventoryMode:'o2o_preapplied',isSystemApplied:true}
  const sources=[{businessNo:'业务一',kingdeeStatus:'registered',kingdeeVoucherNo:'秘密编号'}, {businessNo:'业务二',kingdeeStatus:'not_applied',kingdeeVoucherNo:null}]
  assert.equal(formatter.formatOrderKingdeeStatus({...base,sourcePreorderRegistrations:sources}),'业务一：已登记；业务二：未申请')
  assert.equal(formatter.formatOrderKingdeeStatus({...base,sourcePreorderRegistrations:[sources[0]]}),'已登记')
})
test('客户端待填提醒遵循账号、登记权限、状态和超时',()=>{
  const now=Date.parse('2026-01-01T00:00:00Z')
  const order={clientOrderType:'department',kingdeeVoucherNo:' ',kingdeeEditable:true,status:'pending',timeoutAt:'2026-01-01T00:01:00Z',isSystemApplied:false}
  const needs=(changes={})=>summary.needsKingdeeRegistration({...order,...changes},now)
  assert.equal(needs(),true)
  assert.equal(needs({status:'verified',timeoutAt:'2025-01-01T00:00:00Z'}),true)
  assert.equal(needs({timeoutAt:null}),true)
  for(const changes of [{clientOrderType:'walkin'},{kingdeeVoucherNo:' 编号 '},{kingdeeEditable:false},{status:'cancelled'},{timeoutAt:'2026-01-01T00:00:00Z'}]) assert.equal(needs(changes),false)
})
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
  assert.equal(state.editing.value,false,'只读状态不能打开弹窗')
  props.canEdit=true; state.begin(); state.draft.value='字'.repeat(129); await state.save(); assert.equal(patches,0); assert.match(state.message.value,/128/)
  state.draft.value='自己的草稿'; await state.save()
  assert.equal(patches,1); assert.equal(state.draft.value,'自己的草稿'); assert.equal(state.busy.value,false)
  assert.match(state.message.value,/冲突且刷新失败/); assert.equal(state.editing.value,true)
  await state.save(); assert.equal(patches,1,'冲突刷新失败也不能自动或直接重放旧版本')
  state.begin(); assert.equal(state.version.value,5)
  props.registration={...registration(),kingdeeEditable:false}; await flush(); await state.save(); assert.equal(patches,1)
}))

test('弹窗取消不写入，重开从最新登记初始化；来源号优先且未知订单不可编辑',async()=>withBrowser(async()=>{
  let patches=0
  host.api.updateMyKingdeeRegistration=async()=>{patches+=1;return detail()}
  const {state,props}=mountBehavior(editor,{orderId:'preorder-1',registration:{...registration(),preorderNo:'PRE-D-1'},numberOnly:true})
  assert.equal(state.orderContext.value,'PRE-D-1')
  state.begin();state.draft.value='未保存的更改';state.setEditing(false);await state.save()
  assert.equal(patches,0);assert.equal(state.editing.value,false)
  props.registration={...registration(6,'其他设备的新编号'),sourcePreorderNo:'PRE-D-SOURCE'};await flush()
  state.begin();assert.equal(state.draft.value,'其他设备的新编号');assert.equal(state.version.value,6)
  assert.equal(state.orderContext.value,'PRE-D-SOURCE')
  props.orderId='';await flush();assert.equal(state.editing.value,false)
  state.begin();await state.save();assert.equal(patches,0);assert.equal(state.editing.value,false)
}))

test('保存期间所有关闭入口与重复打开均受约束，失败后可关闭且保留草稿',async()=>withBrowser(async()=>{
  const waiting=deferred();let signal,closed=0
  host.api.updateMyKingdeeRegistration=(_id,_payload,config)=>{signal=config.signal;return waiting.promise}
  const {state}=mountBehavior(editor,{orderId:'preorder-1',registration:registration()})
  state.begin();state.draft.value='待保存草稿';const pending=state.save()
  state.beforeClose(()=>{closed+=1});state.setEditing(false);state.begin()
  assert.equal(closed,0);assert.equal(state.editing.value,true);assert.equal(state.busy.value,true)
  assert.equal(signal.aborted,false);assert.equal(state.draft.value,'待保存草稿')
  waiting.reject(new Error('保存失败'));await pending
  assert.equal(state.draft.value,'待保存草稿');assert.ok(state.message.value)
  state.beforeClose(()=>{closed+=1});assert.equal(closed,1)
  state.setEditing(false);assert.equal(state.editing.value,false);assert.equal(signal.aborted,true)
}))

test('A 到 B 到 A 期间旧成功与失败都不能关闭新弹窗、解除新保存或发送刷新通知',async()=>withBrowser(async(browser)=>{
  for(const outcome of ['resolve','reject']){
    const old=deferred(),current=deferred(),signals=[],events=[],refreshes=[];let writes=0
    host.api.updateMyKingdeeRegistration=(_id,_payload,config)=>{signals.push(config.signal);return ++writes===1?old.promise:current.promise}
    const listener=event=>refreshes.push(event.detail)
    browser.listeners.set('y-link:client-order-refresh',new Set([listener]))
    const {state,props}=mountBehavior(editor,{orderId:`a-${outcome}`,registration:registration()},(...args)=>events.push(args))
    state.begin();state.draft.value='旧A';const first=state.save()
    props.orderId=`b-${outcome}`;props.registration=registration(1,'B');await flush()
    assert.equal(signals[0].aborted,true);assert.equal(state.editing.value,false)
    props.orderId=`a-${outcome}`;props.registration=registration(6,'新A');await flush()
    state.begin();state.draft.value='本次A';const next=state.save()
    old[outcome](outcome==='resolve'?detail(99,'迟到旧A'):new Error('迟到失败'));await first
    assert.equal(state.editing.value,true);assert.equal(state.busy.value,true)
    assert.equal(state.draft.value,'本次A');assert.equal(state.message.value,'')
    assert.equal(events.length,0);assert.equal(refreshes.length,0)
    current.resolve(detail(7,'本次A'));await next
    assert.equal(state.localRegistration.value.kingdeeVoucherNo,'本次A');assert.equal(state.busy.value,false)
    assert.equal(events.length,1);assert.equal(refreshes.length,1)
  }
}))

test('409 读最新期间换单或换域，迟到读取不影响新弹窗与冻结版本',async()=>withBrowser(async()=>{
  for(const change of ['order','scope']){
    const latest=deferred();let signal
    host.api.updateMyKingdeeRegistration=async()=>{throw new AxiosError('冲突',undefined,undefined,undefined,{status:409,data:{code:409,message:'登记已变化'},headers:{},config:{headers:{}}})}
    host.api.getO2oPreorderDetail=(_id,config)=>{signal=config.signal;return latest.promise}
    const {state,props}=mountBehavior(editor,{orderId:`conflict-${change}`,registration:registration()})
    state.begin();state.draft.value='旧草稿';const pending=state.save();await flush()
    if(change==='order')props.orderId='another-order'
    else props.admin=true
    props.registration=registration(8,'新上下文');await flush();state.begin();state.draft.value='新草稿'
    assert.equal(signal.aborted,true)
    latest.resolve(detail(99,'迟到冲突编号'));await pending
    assert.equal(state.editing.value,true);assert.equal(state.draft.value,'新草稿');assert.equal(state.version.value,8)
    assert.equal(state.conflictVersion.value,null);assert.equal(state.conflictPending.value,false)
    assert.equal(state.localRegistration.value.kingdeeVoucherNo,'新上下文');assert.equal(state.message.value,'')
  }
}))

test('打开后撤销编辑许可不提交，不改变只读编号；重新获得许可仍显式保存原草稿版本',async()=>withBrowser(async()=>{
  const requests=[]
  host.api.updateAdminKingdeeRegistration=async(id,payload)=>{requests.push({id,payload});return detail(6,payload.kingdeeVoucherNo)}
  const {state,props}=mountBehavior(editor,{orderId:'admin-source',registration:registration(),admin:true})
  state.begin();state.draft.value='管理员草稿';props.canEdit=false;await state.save()
  assert.equal(requests.length,0);assert.equal(state.draft.value,'管理员草稿')
  assert.equal(state.localRegistration.value.kingdeeVoucherNo,'001-AbC')
  props.canEdit=true;await state.save()
  assert.deepEqual(requests,[{id:'admin-source',payload:{kingdeeVoucherNo:'管理员草稿',expectedKingdeeVersion:5}}])
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

const formalSource=(overrides={})=>({sourceOrderId:'formal-1',sourcePreorderId:'preorder-real',businessNo:'D-1',sourcePreorderNo:'PRE-D-1',...registration(5,''),...overrides})
const formalOrder=(overrides={})=>({id:'formal-1',editVersion:12,orderType:'department',inventoryMode:'o2o_preapplied',sourceDocType:'o2o_preorder',hasCustomerOrder:false,isSystemApplied:true,sourcePreorderRegistrations:[formalSource()],merge:{role:'standalone',children:[]},items:[],totalAmount:'12.34',...overrides})
async function mountOrderPage(order=formalOrder()) {
  host.auth=reactive({currentUser:{id:'admin',permissions:['orders:update']}})
  host.errors.length=0;host.warnings.length=0;host.successes.length=0
  host.orderView={currentOrder:ref(null),drawerVisible:ref(true),listState:reactive({records:[order]}),searchForm:ref({})}
  const mounted=mountBehavior(orderPage,{})
  host.orderView.currentOrder.value=order;await flush()
  return mounted
}

test('正式 O2O 保存走唯一原预订单和冻结 CAS，成功刷新完整来源投影及列表，禁止重入',async()=>withBrowser(async()=>{
  const requests=[], waiting=deferred()
  host.api.updateOrderComplianceFlags=async(id,payload)=>{assert.deepEqual({id,payload},{id:'formal-1',payload:{editVersion:12,hasCustomerOrder:true}});return formalOrder({editVersion:13,hasCustomerOrder:true,sourcePreorderRegistrations:[formalSource({kingdeeVersion:6})]})}
  host.api.updateO2oOrderComplianceFlags=(id,payload)=>{requests.push({id,payload});return waiting.promise}
  host.api.getOrderDetailById=async(id)=>{assert.equal(id,'formal-1');return formalOrder({isSystemApplied:false,hasCustomerOrder:true,sourcePreorderRegistrations:[formalSource({kingdeeVersion:7,kingdeeStatus:'not_applied',isSystemApplied:false})]})}
  const {state}=await mountOrderPage()
  state.complianceForm.value={hasCustomerOrder:true,isSystemApplied:false}
  host.orderView.currentOrder.value=formalOrder({sourcePreorderRegistrations:[formalSource({kingdeeVersion:6})]});await flush()
  assert.equal(state.complianceBaseline.value.kingdeeVersion,5)
  const pending=state.handleSaveComplianceFlags();await flush();await state.handleSaveComplianceFlags()
  assert.deepEqual(requests,[{id:'preorder-real',payload:{isSystemApplied:false,expectedKingdeeVersion:5}}])
  waiting.resolve({order:{}});await pending;await flush()
  assert.equal(state.currentOrder.value.isSystemApplied,false)
  assert.equal(state.listState.records[0].sourcePreorderRegistrations[0].kingdeeVersion,7)
  assert.equal(state.complianceBaseline.value.kingdeeVersion,7);assert.equal(state.hasUnsavedComplianceDraft.value,false)
}))

test('手工单使用正式接口；O2O 缺 ID/多来源仅保存客户标记，不发送申请字段或猜 ID',async()=>withBrowser(async()=>{
  const requests=[]
  host.api.updateOrderComplianceFlags=async(id,payload)=>{requests.push({id,payload});return formalOrder()}
  for(const sources of [[formalSource({sourcePreorderId:null})],[formalSource(),formalSource({sourceOrderId:'formal-2',sourcePreorderId:'other'})],[]]){
    const mounted=await mountOrderPage(formalOrder({sourcePreorderRegistrations:sources}))
    assert.equal(mounted.state.canEditSystemApplied.value,false)
    mounted.state.complianceForm.value.hasCustomerOrder=true
    await mounted.state.handleSaveComplianceFlags()
    assert.deepEqual(requests.at(-1),{id:'formal-1',payload:{editVersion:12,hasCustomerOrder:true}})
    mounted.unmount()
  }
  const {state}=await mountOrderPage(formalOrder({inventoryMode:'manual_applied',sourceDocType:null,sourcePreorderRegistrations:[]}))
  state.complianceForm.value.isSystemApplied=false;await state.handleSaveComplianceFlags()
  assert.deepEqual(requests.at(-1),{id:'formal-1',payload:{editVersion:12,hasCustomerOrder:false,isSystemApplied:false}})
}))

test('409 保留输入/原版本且不自动重试；必须显式刷新确认才采用新版',async()=>withBrowser(async()=>{
  const requests=[]
  host.api.updateO2oOrderComplianceFlags=async(id,payload)=>{requests.push({id,payload});throw new AxiosError('冲突',undefined,undefined,undefined,{status:409,data:{code:409,message:'登记已变化'},headers:{},config:{headers:{}}})}
  host.api.getOrderDetailById=async()=>formalOrder({sourcePreorderRegistrations:[formalSource({kingdeeVersion:9})]})
  const {state}=await mountOrderPage();state.complianceForm.value.isSystemApplied=false
  await state.handleSaveComplianceFlags();await state.handleSaveComplianceFlags()
  assert.equal(requests.length,1);assert.equal(state.complianceForm.value.isSystemApplied,false)
  assert.equal(state.complianceBaseline.value.kingdeeVersion,5);assert.equal(state.complianceRefreshRequired.value,'conflict')
  host.orderView.currentOrder.value=formalOrder({sourcePreorderRegistrations:[formalSource({kingdeeVersion:8})]});await flush()
  assert.equal(state.complianceBaseline.value.kingdeeVersion,5)
  await state.handleRefreshCompliance();assert.equal(state.complianceForm.value.isSystemApplied,false)
  assert.equal(state.complianceBaseline.value.kingdeeVersion,9)
  await state.handleSaveComplianceFlags();assert.equal(requests[1].payload.expectedKingdeeVersion,9)
}))

test('已有编号不能改未申请；只改客户标记不触发金蝶 CAS；无权限/合并来源不可保存',async()=>withBrowser(async()=>{
  let patches=0
  host.api.updateO2oOrderComplianceFlags=async()=>{assert.fail('只改客户标记不能调用原预订单申请接口')}
  host.api.updateOrderComplianceFlags=async(id,payload)=>{patches+=1;assert.deepEqual({id,payload},{id:'formal-1',payload:{editVersion:12,hasCustomerOrder:true}});return formalOrder({editVersion:13,hasCustomerOrder:true})}
  host.api.getOrderDetailById=async()=>formalOrder()
  const {state}=await mountOrderPage(formalOrder({sourcePreorderRegistrations:[formalSource({kingdeeVoucherNo:'12345678910',kingdeeStatus:'registered'})]}))
  state.complianceForm.value.isSystemApplied=false;await state.handleSaveComplianceFlags();assert.equal(patches,0)
  assert.match(host.warnings.at(-1),/先清空编号/)
  state.complianceForm.value={hasCustomerOrder:true,isSystemApplied:true};await state.handleSaveComplianceFlags();assert.equal(patches,1)
  host.auth.currentUser.permissions=[];await state.handleSaveComplianceFlags();assert.equal(patches,1)
  host.auth.currentUser.permissions=['orders:update'];host.orderView.currentOrder.value=formalOrder({merge:{role:'source',children:[]}});await flush()
  await state.handleSaveComplianceFlags();assert.equal(patches,1)
}))

test('保存成功但刷新失败只提示重读，不重发写入；重读成功清理草稿',async()=>withBrowser(async()=>{
  let patches=0,fail=true
  host.api.updateO2oOrderComplianceFlags=async()=>{patches+=1;return {order:{}}}
  host.api.getOrderDetailById=async()=>{if(fail)throw new Error('显示刷新失败');return formalOrder({isSystemApplied:false})}
  const {state}=await mountOrderPage();state.complianceForm.value.isSystemApplied=false
  await state.handleSaveComplianceFlags();assert.equal(state.complianceRefreshRequired.value,'saved')
  assert.match(host.warnings.at(-1),/已保存.*刷新失败/)
  await state.handleSaveComplianceFlags();assert.equal(patches,1)
  fail=false;await state.handleRefreshCompliance();assert.equal(patches,1);assert.equal(state.complianceRefreshRequired.value,null)
  assert.equal(state.hasUnsavedComplianceDraft.value,false)
}))

test('切换单据/来源、关闭抽屉、换账号或卸载后迟到回包不得写入详情/列表',async()=>withBrowser(async()=>{
  for(const change of ['order','source','close','session','unmount']){
    const waiting=deferred();let reads=0
    host.api.updateO2oOrderComplianceFlags=()=>waiting.promise
    host.api.getOrderDetailById=async()=>{reads+=1;return formalOrder({editVersion:99})}
    const mounted=await mountOrderPage();mounted.state.complianceForm.value.isSystemApplied=false
    const pending=mounted.state.handleSaveComplianceFlags()
    if(change==='order')host.orderView.currentOrder.value=formalOrder({id:'other-order'})
    if(change==='source')host.orderView.currentOrder.value=formalOrder({sourcePreorderRegistrations:[formalSource({sourcePreorderId:'new-source'})]})
    if(change==='close')host.orderView.drawerVisible.value=false
    if(change==='session')api.setKingdeeIdentity('admin','changed-session')
    if(change==='unmount')mounted.unmount()
    waiting.resolve({order:{}});await pending;await flush()
    assert.equal(reads,0,change);assert.equal(host.orderView.listState.records[0].editVersion,12,change)
    mounted.unmount()
  }
}))

test('单来源编号移入主单，多来源按真实父子关系判定，缺 ID 只读并保留已知号/散客 null',async()=>withBrowser(async()=>{
  host.auth=reactive({currentUser:{permissions:['orders:update']}});host.api.getOrderRevisions=async()=>[]
  const {state,props}=mountBehavior(orderDrawer,{order:formalOrder(),complianceSaving:false,canEditStandaloneComplianceFlags:true,canEditSystemApplied:true,complianceRefreshRequired:null,complianceFeedback:'',complianceForm:{hasCustomerOrder:false,isSystemApplied:true}})
  assert.equal(state.isMultiSourceOrder.value,false);assert.equal(state.singleRegistration.value.sourcePreorderId,'preorder-real')
  props.order=formalOrder({sourcePreorderRegistrations:[formalSource({sourcePreorderId:null,kingdeeVoucherNo:'完整编号12345678910'})]});await flush()
  assert.equal(state.singleRegistration.value.kingdeeVoucherNo,'完整编号12345678910');assert.equal(state.singleRegistration.value.sourcePreorderId,null)
  props.order=formalOrder({merge:{role:'source',children:[]}});await flush();assert.equal(state.isMultiSourceOrder.value,false)
  props.order=formalOrder({merge:{role:'parent',children:[{id:'other'}]},sourcePreorderRegistrations:[]});await flush()
  assert.equal(state.isMultiSourceOrder.value,true);assert.equal(state.singleRegistration.value,null)
  props.order=formalOrder({sourcePreorderRegistrations:[formalSource(),formalSource({sourceOrderId:'other'})]});await flush();assert.equal(state.isMultiSourceOrder.value,true)
  props.order=formalOrder({orderType:'walkin',sourcePreorderRegistrations:[formalSource({kingdeeStatus:null})]});await flush();assert.equal(state.singleRegistration.value.kingdeeStatus,null)
  host.auth.currentUser.permissions=[];assert.equal(state.canEditRegistration.value,false)
  const source=fs.readFileSync(path.join(root,'src/views/order-list/components/OrderDetailDrawerContent.vue'),'utf8')
  const main=source.slice(source.indexOf('        主单信息'),source.indexOf('<section v-if="order.merge.role'))
  assert.match(main,/label="金蝶单据编号"/);assert.match(main,/singleRegistration\?\.sourcePreorderId/)
  assert.doesNotMatch(source,/el-descriptions-item label="总金额"/);assert.equal((source.match(/>合计金额</g)??[]).length,1)
  assert.match(source,/v-if="canEditSystemApplied"/);assert.match(source,/v-if="isMultiSourceOrder"/)
}))

test('正式详情刷新途中的迟到成功/失败不回填换单、关闭或新会话，失败保存保留草稿',async()=>withBrowser(async()=>{
  for(const outcome of ['resolve','reject']){
    const waiting=deferred();host.api.updateO2oOrderComplianceFlags=async()=>({order:{}})
    host.api.getOrderDetailById=()=>waiting.promise
    const mounted=await mountOrderPage();mounted.state.complianceForm.value.isSystemApplied=false
    const pending=mounted.state.handleSaveComplianceFlags();await flush()
    host.orderView.drawerVisible.value=false;host.orderView.currentOrder.value=formalOrder({id:'other-order'})
    const warnings=host.warnings.length
    waiting[outcome](outcome==='resolve'?formalOrder({editVersion:99}):new Error('迟到读取失败'))
    await pending;await flush()
    assert.equal(host.orderView.currentOrder.value.id,'other-order');assert.equal(host.orderView.listState.records[0].editVersion,12)
    assert.equal(host.warnings.length,warnings+1);assert.match(host.warnings.at(-1),/formal-1.*已保存/);mounted.unmount()
  }
  host.api.updateO2oOrderComplianceFlags=async()=>{throw new Error('隔离写入失败')}
  const {state}=await mountOrderPage();state.complianceForm.value.isSystemApplied=false
  await state.handleSaveComplianceFlags()
  assert.equal(state.complianceForm.value.isSystemApplied,false);assert.equal(state.complianceBaseline.value.kingdeeVersion,5)
  assert.equal(state.complianceRefreshRequired.value,null);assert.equal(state.complianceSaving.value,false)
}))

const complianceConflict=()=>new AxiosError('状态冲突',undefined,undefined,undefined,{status:409,data:{code:409,message:'登记已变化'},headers:{},config:{headers:{}}})

test('并发客户标记已由 B 改为 true 时，A 只改申请不会写回旧 false',async()=>withBrowser(async()=>{
  let server=formalOrder(),formalPatches=0;const sourcePatches=[]
  host.api.updateOrderComplianceFlags=async()=>{formalPatches+=1;assert.fail('仅改申请不能触碰正式单客户标记')}
  host.api.updateO2oOrderComplianceFlags=async(id,payload)=>{
    sourcePatches.push({id,payload});assert.equal(Object.hasOwn(payload,'hasCustomerOrder'),false)
    server={...server,isSystemApplied:payload.isSystemApplied,sourcePreorderRegistrations:[formalSource({kingdeeVersion:6,kingdeeStatus:'not_applied'})]}
    return {order:{id,...registration(6,''),isSystemApplied:false}}
  }
  host.api.getOrderDetailById=async()=>server
  const {state}=await mountOrderPage(server);state.complianceForm.value.isSystemApplied=false
  // B 使用正式单 editVersion 12 保存客户标记，未改变金蝶版本；A 仍持有原草稿。
  server=formalOrder({editVersion:13,hasCustomerOrder:true})
  host.orderView.currentOrder.value=server;await flush()
  assert.equal(state.complianceBaseline.value.hasCustomerOrder,false);assert.equal(state.complianceBaseline.value.kingdeeVersion,5)
  await state.handleSaveComplianceFlags()
  assert.equal(formalPatches,0);assert.equal(server.hasCustomerOrder,true)
  assert.deepEqual(sourcePatches,[{id:'preorder-real',payload:{isSystemApplied:false,expectedKingdeeVersion:5}}])
  assert.equal(state.currentOrder.value.hasCustomerOrder,true);assert.equal(state.listState.records[0].hasCustomerOrder,true)
}))

test('双改完整成功严格先正式 CAS 后原单 CAS，不从第一步返回投影抬高申请版本',async()=>withBrowser(async()=>{
  const calls=[]
  host.api.updateOrderComplianceFlags=async(id,payload)=>{calls.push({kind:'formal',id,payload});return formalOrder({editVersion:13,hasCustomerOrder:true,sourcePreorderRegistrations:[formalSource({kingdeeVersion:8})]})}
  host.api.updateO2oOrderComplianceFlags=async(id,payload)=>{calls.push({kind:'source',id,payload});return{order:{id,...registration(6,''),isSystemApplied:false}}}
  host.api.getOrderDetailById=async(id)=>{calls.push({kind:'get',id});return formalOrder({editVersion:14,hasCustomerOrder:true,isSystemApplied:false,sourcePreorderRegistrations:[formalSource({kingdeeVersion:9,kingdeeStatus:'not_applied'})]})}
  const {state}=await mountOrderPage();state.complianceForm.value={hasCustomerOrder:true,isSystemApplied:false}
  await state.handleSaveComplianceFlags()
  assert.deepEqual(calls,[{kind:'formal',id:'formal-1',payload:{editVersion:12,hasCustomerOrder:true}},{kind:'source',id:'preorder-real',payload:{isSystemApplied:false,expectedKingdeeVersion:5}},{kind:'get',id:'formal-1'}])
  assert.equal(state.complianceBaseline.value.kingdeeVersion,9);assert.equal(state.hasUnsavedComplianceDraft.value,false)
  assert.equal(state.complianceRefreshRequired.value,null);assert.equal(state.complianceFeedback.value,'')
}))

test('双改第一步正式 CAS 冲突立即停止，保留两项草稿，不调用原预订单接口',async()=>withBrowser(async()=>{
  let formal=0,source=0,gets=0
  host.api.updateOrderComplianceFlags=async(_id,payload)=>{formal+=1;assert.deepEqual(payload,{editVersion:12,hasCustomerOrder:true});throw complianceConflict()}
  host.api.updateO2oOrderComplianceFlags=async()=>{source+=1}
  host.api.getOrderDetailById=async()=>{gets+=1}
  const {state}=await mountOrderPage();state.complianceForm.value={hasCustomerOrder:true,isSystemApplied:false}
  await state.handleSaveComplianceFlags();await state.handleSaveComplianceFlags()
  assert.equal(formal,1);assert.equal(source,0);assert.equal(gets,0)
  assert.deepEqual(state.complianceForm.value,{hasCustomerOrder:true,isSystemApplied:false})
  assert.equal(state.complianceBaseline.value.editVersion,12);assert.equal(state.complianceRefreshRequired.value,'conflict')
}))

test('双改第二步 409 明确部分成功，刷新保留申请意图，仅重试未保存字段并保留他人客户标记',async()=>withBrowser(async()=>{
  const formal=[],source=[];let conflict=true,readFails=true
  let server=formalOrder()
  host.api.updateOrderComplianceFlags=async(id,payload)=>{formal.push({id,payload});server=formalOrder({editVersion:13,hasCustomerOrder:true});return server}
  host.api.updateO2oOrderComplianceFlags=async(id,payload)=>{
    source.push({id,payload});if(conflict)throw complianceConflict()
    server={...server,isSystemApplied:false,sourcePreorderRegistrations:[formalSource({kingdeeVersion:9,kingdeeStatus:'not_applied'})]};return{order:{id,...registration(9,''),isSystemApplied:false}}
  }
  host.api.getOrderDetailById=async()=>{if(readFails)throw new Error('隔离刷新失败');return server}
  const {state}=await mountOrderPage();state.complianceForm.value={hasCustomerOrder:true,isSystemApplied:false}
  await state.handleSaveComplianceFlags()
  assert.equal(state.currentOrder.value.hasCustomerOrder,true);assert.equal(state.listState.records[0].hasCustomerOrder,true)
  assert.equal(state.complianceBaseline.value.editVersion,13);assert.equal(state.complianceBaseline.value.kingdeeVersion,5)
  assert.equal(state.complianceRefreshRequired.value,'partial');assert.match(state.complianceFeedback.value,/客户订单标记已保存.*系统申请未保存/)
  assert.deepEqual(state.complianceForm.value,{hasCustomerOrder:true,isSystemApplied:false})
  // 轮询不得自动确认新版本；第一次显式刷新失败仍须保留部分成功及草稿。
  server=formalOrder({editVersion:14,hasCustomerOrder:false,sourcePreorderRegistrations:[formalSource({kingdeeVersion:8})]})
  host.orderView.currentOrder.value=server;await flush()
  assert.equal(state.complianceBaseline.value.kingdeeVersion,5)
  await state.handleSaveComplianceFlags();assert.equal(formal.length,1);assert.equal(source.length,1)
  await state.handleRefreshCompliance();assert.equal(state.complianceRefreshRequired.value,'partial');assert.equal(state.complianceForm.value.isSystemApplied,false)
  readFails=false;await state.handleRefreshCompliance()
  assert.equal(state.complianceBaseline.value.kingdeeVersion,8)
  assert.deepEqual(state.complianceForm.value,{hasCustomerOrder:false,isSystemApplied:false},'已成功客户字段须采用明确读取的最新值，不能带回旧 true')
  conflict=false;await state.handleSaveComplianceFlags()
  assert.equal(formal.length,1);assert.equal(source.length,2)
  assert.deepEqual(source.map(x=>x.payload),[{isSystemApplied:false,expectedKingdeeVersion:5},{isSystemApplied:false,expectedKingdeeVersion:8}])
  assert.equal(server.hasCustomerOrder,false);assert.equal(state.currentOrder.value.hasCustomerOrder,false)
  assert.equal(state.hasUnsavedComplianceDraft.value,false)
}))

test('双改都已保存而末尾 GET 失败，只能重读，不能重发任一成功字段',async()=>withBrowser(async()=>{
  let formal=0,source=0,fail=true
  host.api.updateOrderComplianceFlags=async()=>{formal+=1;return formalOrder({editVersion:13,hasCustomerOrder:true})}
  host.api.updateO2oOrderComplianceFlags=async()=>{source+=1;return{order:{}}}
  host.api.getOrderDetailById=async()=>{if(fail)throw new Error('读取失败');return formalOrder({editVersion:14,hasCustomerOrder:true,isSystemApplied:false,sourcePreorderRegistrations:[formalSource({kingdeeVersion:6,kingdeeStatus:'not_applied'})]})}
  const {state}=await mountOrderPage();state.complianceForm.value={hasCustomerOrder:true,isSystemApplied:false}
  await state.handleSaveComplianceFlags();assert.equal(state.complianceRefreshRequired.value,'saved')
  assert.match(state.complianceFeedback.value,/已保存.*刷新失败/)
  await state.handleSaveComplianceFlags();assert.equal(formal,1);assert.equal(source,1)
  fail=false;await state.handleRefreshCompliance();assert.equal(formal,1);assert.equal(source,1)
  assert.equal(state.hasUnsavedComplianceDraft.value,false);assert.equal(state.complianceBaseline.value.kingdeeVersion,6)
}))

test('第一步迟到成功不提交旧来源，旧 finally 不解除另一张单据新请求的 busy',async()=>withBrowser(async()=>{
  const old=deferred(),next=deferred();const calls=[];let sources=0
  host.api.updateOrderComplianceFlags=(id,payload)=>{calls.push({id,payload});return id==='formal-1'?old.promise:next.promise}
  host.api.updateO2oOrderComplianceFlags=async()=>{sources+=1;assert.fail('换单后不能继续第二步原申请提交')}
  const {state}=await mountOrderPage();state.complianceForm.value={hasCustomerOrder:true,isSystemApplied:false}
  const previous=state.handleSaveComplianceFlags()
  const nextOrder=formalOrder({id:'formal-2',sourcePreorderRegistrations:[formalSource({sourceOrderId:'formal-2',sourcePreorderId:'preorder-2'})]})
  host.orderView.currentOrder.value=nextOrder;await flush()
  assert.equal(state.complianceSaving.value,false)
  state.complianceForm.value.hasCustomerOrder=true
  const pending=state.handleSaveComplianceFlags();assert.equal(state.complianceSaving.value,true)
  old.resolve(formalOrder({editVersion:13,hasCustomerOrder:true}));await previous
  assert.equal(sources,0);assert.equal(state.complianceSaving.value,true)
  assert.equal(state.currentOrder.value.id,'formal-2');assert.match(host.warnings.at(-1),/formal-1.*客户订单标记已保存.*系统申请未保存/)
  await state.handleSaveComplianceFlags();assert.equal(calls.length,2,'旧 finally 不得放开新请求重入')
  next.resolve({...nextOrder,editVersion:13,hasCustomerOrder:true});await pending
  assert.equal(state.complianceSaving.value,false);assert.equal(state.currentOrder.value.id,'formal-2')
}))

test('第二步迟到失败在原单反馈部分成功，不污染新抽屉或新会话',async()=>withBrowser(async()=>{
  for(const change of ['order','session']){
    const waiting=deferred();host.api.updateOrderComplianceFlags=async()=>formalOrder({editVersion:13,hasCustomerOrder:true})
    host.api.updateO2oOrderComplianceFlags=()=>waiting.promise
    const {state}=await mountOrderPage();state.complianceForm.value={hasCustomerOrder:true,isSystemApplied:false}
    const pending=state.handleSaveComplianceFlags();await flush()
    if(change==='order')host.orderView.currentOrder.value=formalOrder({id:'different'})
    else api.setKingdeeIdentity('admin','partial-next-session')
    await flush();const warnings=host.warnings.length
    waiting.reject(complianceConflict());await pending;await flush()
    if(change==='order'){
      assert.equal(state.currentOrder.value.id,'different');assert.equal(state.complianceRefreshRequired.value,null)
      assert.match(host.warnings.at(-1),/formal-1.*客户订单标记已保存.*系统申请未保存/)
    } else assert.equal(host.warnings.length,warnings,'不能向新账号显示旧账号原单结果')
    assert.equal(state.complianceSaving.value,false)
  }
}))
