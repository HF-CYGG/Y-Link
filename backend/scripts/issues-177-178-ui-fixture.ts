/**
 * 模块说明：#177/#178 真实浏览器隔离后端。
 * 文件职责：自建英文目录SQLite、测试账号/会话/商品及真实预订单，供实际页面通过真实HTTP读写。
 * 维护说明：只绑定loopback；引导会话路径仅通过父进程IPC传递，不输出token/Cookie/密码，不加载业务库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import express from 'express'
const parent = path.resolve(process.env.YLINK_ISSUES_VERIFY_ROOT ?? '')
assert.ok(process.env.YLINK_ISSUES_VERIFY_ROOT && /^[\x20-\x7e]+$/.test(parent), '必须显式指定本任务独占英文临时目录')
const runtime = fs.mkdtempSync(path.join(parent,'ylink-issues-ui-'))
Object.assign(process.env,{ NODE_ENV:'test', APP_PROFILE:'issues-177-178-browser', DB_TYPE:'sqlite', DB_SYNC:'true', SQLITE_DB_PATH:path.join(runtime,'verify.sqlite'), Y_LINK_DATA_DIR:runtime, Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE:'true' })
const { AppDataSource:db } = await import('../src/config/data-source.js')
const { prepareDatabaseRuntime,initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')
const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
const { BaseStorageLocation } = await import('../src/entities/base-storage-location.entity.js')
const { InvSkuLocationStock } = await import('../src/entities/inv-sku-location-stock.entity.js')
const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
const { orderService } = await import('../src/services/order.service.js')
const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
const { productService } = await import('../src/services/product.service.js')
const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
const { hashSessionToken } = await import('../src/utils/session-token.js')
const { hashPassword } = await import('../src/utils/password.js')
const { setClientAuthCookie } = await import('../src/utils/client-auth-cookie.js')
const { setAdminAuthCookies } = await import('../src/utils/admin-auth-cookie.js')
const { createApp } = await import('../src/app.js')
prepareDatabaseRuntime(); await db.initialize(); await initializeDatabaseSchemaIfNeeded(db)
const expiresAt=new Date(Date.now()+60*60_000), sessions=new Map<string,{ sessionToken:string; expiresAt:Date }>()
const passwordHash=await hashPassword(randomBytes(24).toString('base64url'))
const users=db.getRepository(SysUser)
const admin=await users.save(users.create({username:'issues-browser-admin',displayName:'隔离管理员',role:'admin',status:'enabled',passwordHash}))
const supplier=await users.save(users.create({username:'issues-browser-supplier',displayName:'只读标签用户',role:'supplier',status:'enabled',passwordHash}))
for(const [name,user] of [['admin',admin],['supplier',supplier]] as const){const sessionToken=randomBytes(32).toString('base64url'); await db.getRepository(SysUserSession).save({userId:user.id,sessionToken:hashSessionToken(sessionToken),expiresAt,lastAccessAt:new Date()});sessions.set(name,{sessionToken,expiresAt})}
const clients=db.getRepository(ClientUser)
const client=await clients.save(clients.create({username:'issues-browser-client',realName:'隔离教师',mobile:'13800000177',accountType:'department',departmentName:'隔离部门',staffNo:'177',staffVerified:true,status:'enabled',passwordHash}))
const other=await clients.save(clients.create({username:'issues-browser-other',realName:'另一账号',mobile:'13800000178',accountType:'department',departmentName:'隔离部门',staffNo:'178',staffVerified:true,status:'enabled',passwordHash}))
for(const [name,user] of [['client',client],['other',other]] as const){const sessionToken=randomBytes(32).toString('base64url');await db.getRepository(ClientUserSession).save({userId:user.id,sessionToken:hashSessionToken(sessionToken),expiresAt,lastAccessAt:new Date()});sessions.set(name,{sessionToken,expiresAt})}
const actor={userId:String(admin.id),username:admin.username,displayName:admin.displayName,role:'admin' as const,status:'enabled' as const,permissions:resolvePermissionsByRole('admin'),sessionToken:sessions.get('admin')!.sessionToken,authSource:'bearer' as const}
const locations=db.getRepository(BaseStorageLocation)
const main=await locations.save(locations.create({locationCode:'UI-MAIN',isActive:true})), extra=await locations.save(locations.create({locationCode:'UI-OTHER',isActive:true})), disabled=await locations.save(locations.create({locationCode:'UI-OFF',isActive:false}))
const product=await productService.create({productName:'浏览器标签商品',defaultPrice:1,o2oStatus:'listed',specGroups:[{name:'款式',values:['甲','乙']}],skus:[{specValues:{款式:'甲'},currentStock:20,locationId:main.id},{specValues:{款式:'乙'},currentStock:20,locationId:main.id}]},actor)
for(const sku of product.skus) {
  await db.getRepository(InvSkuLocationStock).save({skuId:sku.id,locationId:extra.id,qty:15})
  await db.getRepository(InvSkuLocationStock).save({skuId:sku.id,locationId:disabled.id,qty:5})
}
// 下单和标签使用不同商品；实际核销不会破坏用于主0/过滤项验收的标签分布。
const commerce=await productService.create({productName:'浏览器下单商品',defaultPrice:2,limitPerUser:100,o2oStatus:'listed',specGroups:[{name:'款式',values:['甲','乙']}],skus:[{specValues:{款式:'甲'},currentStock:200,locationId:main.id},{specValues:{款式:'乙'},currentStock:200,locationId:main.id}]},actor)
const clientAuth={userId:String(client.id),account:client.username!,realName:client.realName,mobile:client.mobile!,email:'',accountType:'department' as const,staffNo:'177',sessionToken:sessions.get('client')!.sessionToken,authSource:'bearer' as const}
const otherAuth={...clientAuth,userId:String(other.id),account:other.username!,realName:other.realName,mobile:other.mobile!,staffNo:'178',sessionToken:sessions.get('other')!.sessionToken}
const submit=(key:string,auth=clientAuth)=>o2oPreorderService.submit(auth,{clientRequestId:key,isSystemApplied:false,pickupContact:auth.realName,pickupAt:new Date(Date.now()+30*60_000).toISOString(),items:[{productId:commerce.id,skuId:commerce.skus[0]!.id,qty:1}]})
const pending=await submit('browser-pending-177-178'), verified=await submit('browser-verified-177-178')
await o2oPreorderService.verifyByCode(verified.order.verifyCode,actor)
// 明确的隔离历史数据：核销由真实服务完成，仅把历史缺编号版本和原超时日设置为昨天。
await db.getRepository(O2oPreorder).update(verified.order.id,{kingdeeVersion:0,timeoutAt:new Date(Date.now()-24*60*60_000)})
const ownSource=await submit('browser-merge-self'), otherSource=await submit('browser-merge-other',otherAuth)
for(const source of [ownSource,otherSource]) await o2oPreorderService.verifyByCode(source.order.verifyCode,actor)
const formal=db.getRepository(BizOutboundOrder)
const ownFormal=await formal.findOneByOrFail({sourceDocType:'o2o_preorder',sourceDocId:ownSource.order.id}), otherFormal=await formal.findOneByOrFail({sourceDocType:'o2o_preorder',sourceDocId:otherSource.order.id})
await orderService.commitMerge({target:{orderId:ownFormal.id,editVersion:ownFormal.editVersion},sources:[{orderId:otherFormal.id,editVersion:otherFormal.editVersion}],reason:'隔离浏览器逐来源验收',idempotencyKey:'browser-merge-177-178'},actor)
await o2oPreorderService.updateKingdeeRegistration(ownSource.order.id,{kingdeeVoucherNo:'KD-SELF-177',expectedKingdeeVersion:1},{client:clientAuth})
await o2oPreorderService.updateKingdeeRegistration(otherSource.order.id,{kingdeeVoucherNo:'KD-OTHER-178',expectedKingdeeVersion:1},{client:otherAuth})
const verifiedFormal=await formal.findOneByOrFail({sourceDocType:'o2o_preorder',sourceDocId:verified.order.id})
const manifest={preorderId:pending.order.id,preorderNo:pending.order.preorderNo,verifiedId:verified.order.id,verifiedNo:verified.order.preorderNo,verifiedFormalId:verifiedFormal.id,verifiedBusinessNo:verifiedFormal.businessNo,mergeParentId:ownFormal.id,mergeBusinessNo:ownFormal.businessNo,ownSourceId:ownSource.order.id,otherSourceId:otherSource.order.id,ownSourceNo:ownSource.order.preorderNo,otherSourceNo:otherSource.order.preorderNo,skuIds:product.skus.map((sku)=>sku.id),skuCodes:product.skus.map((sku)=>sku.skuCode),mainId:main.id,extraId:extra.id,disabledId:disabled.id,commerceProductName:commerce.productName}
const bootstrap=`/__issues_verify/${randomUUID()}`
const app=express()
app.get(`${bootstrap}/:kind`,(req,res)=>{const value=sessions.get(req.params.kind);if(!value){res.sendStatus(404);return}if(['client','other'].includes(req.params.kind))setClientAuthCookie(req,res,value);else setAdminAuthCookies(req,res,value);res.json({code:0,message:'ok'})})
app.get('/__issues_verify/manifest',(_req,res)=>res.json(manifest))
app.use(createApp())
const server=app.listen(0,'127.0.0.1')
await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
const address=server.address();assert.ok(address && typeof address!=='string')
process.send?.({type:'ready',port:address.port,bootstrap,...manifest})
let closing=false
const close=async()=>{if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>((resolve)=>server.close(()=>resolve()));await db.destroy();const resolved=path.resolve(runtime);assert.ok(resolved.startsWith(parent+path.sep)&&path.basename(resolved).startsWith('ylink-issues-ui-'));fs.rmSync(resolved,{recursive:true,force:true});process.disconnect?.()}
process.on('message',(message)=>{if(message==='stop')void close()});process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close())
