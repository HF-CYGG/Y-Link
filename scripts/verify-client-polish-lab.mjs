/** 隔离HTTP边界验证fixture的请求归属与reset，不代替产品后端测试。 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createClientPolishLab } from './client-polish-lab-fixture.mjs'
const lab=createClientPolishLab()
let handler
lab.plugin.configureServer({middlewares:{use(value){handler=value}}})
const server=http.createServer((req,res)=>handler(req,res,()=>{res.writeHead(404);res.end()}))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin='http://127.0.0.1:'+server.address().port
const request=(path,method='GET',body)=>fetch(origin+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).then(r=>r.json())
const waitFor=async(predicate)=>{for(let n=0;n<200;n++){if(predicate())return;await new Promise(r=>setTimeout(r,5))}throw Error('fixture请求未到达')}
try {
  for(const [path,body] of [
    ['/api/o2o/mall/preorders',{clientRequestId:'owner-check',items:[{productId:'p1',skuId:'s1',qty:1}],pickupContact:'甲'}],
    ['/api/client-auth/profile',{currentPassword:'FixturePass42',username:'甲的新名',mobile:'13800000001',email:'a@example.test'}],
  ]) {
    lab.control({action:'reset'})
    const method=path.endsWith('profile')?'PATCH':'POST',key=method+' '+path
    lab.control({action:'hold',key})
    const pending=request(path,method,body)
    await waitFor(()=>lab.state().ledger.some(x=>x.key===key))
    lab.control({action:'session',user:'B'})
    lab.control({action:'release',key})
    const result=await pending
    assert.equal(result.code,0)
    assert.equal(lab.state().ledger.find(x=>x.key===key).owner,'lab-A')
    assert.equal(lab.state().session,'B')
    if(method==='POST')assert.equal(result.data.owner,'lab-A')
    else {assert.equal(lab.state().users.A.username,'甲的新名');assert.equal(lab.state().users.B.username,'体验乙')}
  }
  lab.control({action:'images',mode:'all-fail'})
  lab.control({action:'reset'})
  assert.equal(lab.state().users.A.username,'体验甲')
  assert.equal(lab.state().products[0].thumbnail,'/__polish/images/original.svg')
  assert.equal(lab.state().imageVersion,1)
  assert.equal(lab.state().imageMode,'normal')
  const portal=await request('/api/client-feedback/portal-config')
  assert.equal(portal.data.availability.serviceConnectedCount,1)
  const created=await request('/api/client-feedback/restock-requests','POST',{productId:'p2',skuId:'s3',quantity:2,latestPickupAt:'2099-01-01T12:00:00+08:00',clientRequestId:'restock-shape'})
  assert.equal(created.code,0)
  assert.equal(created.data.conversation.restock.specTextSnapshot,'无货SKU2')
  assert.equal(created.data.conversation.restock.skuCodeSnapshot,'s3')
  assert.equal(created.data.conversation.restock.quantity,2)
  assert.equal(lab.state().conversations.find(c=>c.id==='f3').status,'closed','新建不能覆盖种子会话')
  const returned=await request('/api/o2o/mall/preorders/o2/returns','POST',{reason:'隔离退货',items:[{productId:'p1',skuId:'s1',qty:1}]})
  assert.equal(returned.code,0)
  const orderDetail=await request('/api/o2o/mall/preorders/o2')
  assert.equal(orderDetail.data.items[0].returnedQty,1)
  assert.equal(orderDetail.data.items[0].availableReturnQty,1)
  assert.equal(orderDetail.data.returnRequests[0].status,'pending')
  const orderSummary=await request('/api/o2o/mall/preorders/o2/summary')
  assert.equal(orderSummary.data.pendingReturnRequestCount,1)
  const rating=await request('/api/client-feedback/conversations/f2/satisfaction','POST',{level:'neutral',comment:'隔离评价'})
  assert.equal(rating.code,0)
  assert.ok(Number.isFinite(Date.parse(rating.data.satisfaction.ratedAt)))
  const feedback=await request('/api/client-feedback/conversations/f2')
  assert.equal(feedback.data.conversation.satisfaction.ratedAt,rating.data.satisfaction.ratedAt)
  console.log('PASS fixture satisfaction ratedAt response/detail contract')
  console.log('PASS fixture pending return quantity/item/summary consistency')
  console.log('PASS fixture restock snapshots/portal online count/new conversation identity')
  console.log('PASS fixture HTTP: held order/profile belong to A after switching B; ledger owner; users/products reset. Not real backend proof.')
} finally {lab.close();await new Promise(resolve=>server.close(resolve))}
