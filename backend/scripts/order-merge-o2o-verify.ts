/**
 * 模块说明：Issue #71 O2O 合并边界专项验证。
 * 文件职责：在隔离 SQLite 中验证跨账号部门单隐私、父/原单号、打印锁定、退货与删除恢复联动。
 * 实现逻辑：直接构造已核销预订单及其正式出库单，避免重复测试核销建单本身，聚焦合并后的身份与数据边界。
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

const seed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqliteRoot = path.resolve(process.cwd(), 'data', 'local-dev')
const sqlitePath = path.resolve(sqliteRoot, `order-merge-o2o-${seed}.sqlite`)
process.env.APP_PROFILE = `order-merge-o2o-${seed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const [
    { AppDataSource },
    { BaseProduct },
    { BizOutboundOrder },
    { BizOutboundOrderItem },
    { ClientUser },
    { O2oPreorder },
    { O2oPreorderItem },
    { O2oReturnRequest },
    { SysUser },
    { orderMergeService },
    { orderService },
    { o2oPreorderService },
    { systemConfigService },
    { BizError },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/biz-outbound-order-item.entity.js'),
    import('../src/entities/client-user.entity.js'),
    import('../src/entities/o2o-preorder.entity.js'),
    import('../src/entities/o2o-preorder-item.entity.js'),
    import('../src/entities/o2o-return-request.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/services/order-merge.service.js'),
    import('../src/services/order.service.js'),
    import('../src/services/o2o-preorder.service.js'),
    import('../src/services/system-config.service.js'),
    import('../src/utils/errors.js'),
  ])

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()
    const sysUserRepo = AppDataSource.getRepository(SysUser)
    const admin = await sysUserRepo.save(sysUserRepo.create({
      username: `issue71-o2o-admin-${seed}`,
      passwordHash: 'verify-only',
      displayName: 'Issue71 O2O 验证员',
      email: null,
      role: 'admin',
      status: 'enabled',
      lastLoginAt: null,
      deactivatedAt: null,
      deactivationReason: null,
      deactivatedByUserId: null,
      deactivatedByUsername: null,
      deactivatedByDisplayName: null,
      restoredAt: null,
      restoredByUserId: null,
      restoredByUsername: null,
      restoredByDisplayName: null,
    }))
    const actor: AuthUserContext = {
      userId: String(admin.id),
      username: admin.username,
      displayName: admin.displayName,
      role: 'admin',
      permissions: ['orders:view', 'orders:delete', 'orders:merge'],
      status: 'enabled',
      sessionToken: 'issue71-o2o-admin-session',
      authSource: 'bearer',
    }

    const clientRepo = AppDataSource.getRepository(ClientUser)
    let clientSequence = 0
    const createClient = async (): Promise<{ entity: InstanceType<typeof ClientUser>; auth: ClientAuthContext }> => {
      clientSequence += 1
      const entity = await clientRepo.save(clientRepo.create({
        mobile: `13971${String(Date.now()).slice(-5)}${clientSequence}`,
        email: null,
        mobileVerifiedAt: new Date(),
        emailVerifiedAt: null,
        passwordHash: 'verify-only',
        realName: `O2O 验证客户${clientSequence}`,
        departmentName: '海右书院/信息中心',
        departmentNodeId: `issue71-node-${seed}-${clientSequence}`,
        accountType: 'department',
        staffNo: `ISSUE71-${seed}-${clientSequence}`,
        staffVerified: true,
        status: 'enabled',
        lastLoginAt: null,
        deactivatedAt: null,
        deactivationReason: null,
        deactivatedByUserId: null,
        deactivatedByUsername: null,
        deactivatedByDisplayName: null,
        restoredAt: null,
        restoredByUserId: null,
        restoredByUsername: null,
        restoredByDisplayName: null,
      }))
      return {
        entity,
        auth: {
          userId: String(entity.id),
          account: entity.mobile ?? `client-${entity.id}`,
          mobile: entity.mobile ?? '',
          email: '',
          realName: entity.realName,
          accountType: 'department',
          staffNo: entity.staffNo,
          sessionToken: `issue71-client-session-${entity.id}`,
          authSource: 'bearer',
        },
      }
    }
    const clients = [await createClient(), await createClient(), await createClient(), await createClient()]

    const productRepo = AppDataSource.getRepository(BaseProduct)
    const product = await productRepo.save(productRepo.create({
      productCode: `ISSUE71-O2O-${seed}`,
      productName: 'Issue71 O2O 隐私商品',
      pinyinAbbr: 'ISSUEO2O',
      defaultPrice: '10.00',
      currentStock: 100,
      preOrderedStock: 0,
      isActive: true,
    }))
    const preorderRepo = AppDataSource.getRepository(O2oPreorder)
    const preorderItemRepo = AppDataSource.getRepository(O2oPreorderItem)
    const outboundRepo = AppDataSource.getRepository(BizOutboundOrder)
    const outboundItemRepo = AppDataSource.getRepository(BizOutboundOrderItem)
    let orderSequence = 0
    const createVerifiedPair = async (clientIndex: number, qty: number) => {
      orderSequence += 1
      const client = clients[clientIndex]!
      const preorder = await preorderRepo.save(preorderRepo.create({
        showNo: `O2O-ISSUE71-${seed}-${orderSequence}`,
        clientUserId: client.entity.id,
        clientRequestId: `issue71-request-${seed}-${orderSequence}`,
        clientRequestHash: randomUUID().replaceAll('-', ''),
        verifyCode: randomUUID(),
        status: 'verified',
        cancelReason: null,
        cancellationSource: null,
        cancellationRemark: null,
        cancelledAt: null,
        businessStatus: 'completed',
        merchantMessage: null,
        clientOrderType: 'department',
        departmentNameSnapshot: '海右书院/信息中心',
        staffNoSnapshot: client.entity.staffNo,
        isSystemApplied: false,
        hasCustomerOrder: false,
        pickupContact: client.entity.realName,
        totalQty: qty,
        remark: `client-${clientIndex + 1}`,
        updateCount: 0,
        timeoutAt: null,
        verifiedAt: new Date(),
        verifiedBy: actor.displayName,
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deletedByUsername: null,
        deletedByDisplayName: null,
      }))
      const preorderItem = await preorderItemRepo.save(preorderItemRepo.create({
        orderId: preorder.id,
        productId: product.id,
        qty,
        skuId: null,
        skuCodeSnapshot: null,
        specTextSnapshot: null,
        skuImageSnapshot: null,
        originalPrice: '10.00',
        discountRate: '10.0',
        unitPrice: '10.00',
        lineAmount: (qty * 10).toFixed(2),
      }))
      const outbound = await outboundRepo.save(outboundRepo.create({
        orderUuid: randomUUID(),
        showNo: `CK-ISSUE71-${seed}-${orderSequence}`,
        businessNo: `yy${String(710000 + orderSequence)}`,
        editVersion: 1,
        status: 'active',
        inventoryMode: 'o2o_preapplied',
        orderType: 'department',
        hasCustomerOrder: false,
        isSystemApplied: false,
        issuerName: actor.displayName,
        customerDepartmentName: '海右书院/信息中心',
        idempotencyKey: `o2o-preorder-verify:${preorder.id}`,
        customerName: client.entity.realName,
        remark: `preorder:${preorder.showNo}`,
        totalQty: qty.toFixed(2),
        totalAmount: (qty * 10).toFixed(2),
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deletedByUsername: null,
        deletedByDisplayName: null,
        creatorUserId: actor.userId,
        creatorUsername: actor.username,
        creatorDisplayName: actor.displayName,
      }))
      await outboundItemRepo.save(outboundItemRepo.create({
        orderId: outbound.id,
        lineNo: 1,
        productId: product.id,
        productNameSnapshot: `${product.productName}-客户${clientIndex + 1}`,
        skuId: null,
        skuCodeSnapshot: null,
        specTextSnapshot: null,
        qty: qty.toFixed(2),
        unitPrice: '10.00',
        lineAmount: (qty * 10).toFixed(2),
        remark: preorder.showNo,
        sourceOrderId: null,
        sourceOrderUuid: null,
        sourceOrderItemId: null,
      }))
      return { client, preorder, preorderItem, outbound }
    }

    const target = await createVerifiedPair(0, 1)
    const source = await createVerifiedPair(1, 2)
    const pendingSource = await createVerifiedPair(2, 1)
    const pendingTarget = await createVerifiedPair(3, 1)
    const merged = await orderService.commitMerge({
      target: { orderId: String(target.outbound.id), editVersion: 1 },
      sources: [{ orderId: String(source.outbound.id), editVersion: 1 }],
      reason: 'O2O 跨账号同部门合并验证',
      idempotencyKey: `issue71-o2o-merge-${seed}`,
    }, actor)
    assert.equal(merged.targetOrderId, String(target.outbound.id), '同部门跨账号正式出库单应允许合并')

    const targetPrinted = await o2oPreorderService.markCustomerOrderPrintedByClient(target.client.auth, String(target.preorder.id))
    assert.equal(targetPrinted.printedNow, true, '目标客户端首次打印应标记父单')
    const mergeMetadata = await orderMergeService.getMetadataMap([String(target.outbound.id)])
    const sourceReference = mergeMetadata.get(String(target.outbound.id))?.children
      .find((child) => child.id === String(source.outbound.id))
    assert.ok(sourceReference, '父单合并摘要应包含来源子单')
    assert.equal(sourceReference.hasCustomerOrder, false, '父单已打印时不得伪造来源子单已打印')
    assert.equal(sourceReference.isSystemApplied, false, '来源子单必须保留自身系统申请状态')
    assert.equal(sourceReference.issuerName, source.outbound.issuerName, '来源子单必须保留自身出单人')
    assert.equal(sourceReference.creatorDisplayName, source.outbound.creatorDisplayName, '来源子单必须保留自身开单人')
    assert.equal(sourceReference.createdAt, source.outbound.createdAt.toISOString(), '来源子单必须保留自身开单时间')

    const targetDetail = await o2oPreorderService.getMyOrderDetail(target.client.auth, String(target.preorder.id))
    const sourceDetail = await o2oPreorderService.getMyOrderDetail(source.client.auth, String(source.preorder.id))
    assert.equal(targetDetail.order.customerOrderShowNo, target.outbound.showNo)
    assert.equal(targetDetail.order.originalCustomerOrderShowNo, target.outbound.showNo)
    assert.equal(sourceDetail.order.customerOrderShowNo, target.outbound.showNo, '来源客户端当前正式单号必须解析为父单号')
    assert.equal(sourceDetail.order.originalCustomerOrderShowNo, source.outbound.showNo, '来源客户端必须保留原正式单号')
    assert.deepEqual(sourceDetail.items.map((item) => String(item.id)), [String(source.preorderItem.id)], '客户端详情只能返回本人原预订单明细')
    await assert.rejects(
      () => o2oPreorderService.getMyOrderDetail(target.client.auth, String(source.preorder.id)),
      (error: unknown) => error instanceof BizError && error.statusCode === 404,
      '不同客户端不得读取彼此原预订单详情',
    )

    const printed = await o2oPreorderService.markCustomerOrderPrintedByClient(source.client.auth, String(source.preorder.id))
    assert.equal(printed.printedNow, true)
    assert.equal(Boolean((await preorderRepo.findOneByOrFail({ id: source.preorder.id })).hasCustomerOrder), true)
    assert.equal(Boolean((await outboundRepo.findOneByOrFail({ id: source.outbound.id })).hasCustomerOrder), true)
    const printedParent = await outboundRepo.findOneByOrFail({ id: target.outbound.id })
    assert.equal(Boolean(printedParent.hasCustomerOrder), true, '来源客户端打印必须同步锁定父单')
    const appendAfterPrint = await orderMergeService.preview({
      target: { orderId: String(target.outbound.id), editVersion: Number(printedParent.editVersion) },
      sources: [{ orderId: String(pendingSource.outbound.id), editVersion: 1 }],
      reason: '已打印父单禁止继续追加',
    }, actor)
    assert.equal(appendAfterPrint.ready, false)
    assert.match(appendAfterPrint.blockers.map((item) => item.code).join(','), /CUSTOMER_ORDER_PRINTED/)

    const returnRequest = await o2oPreorderService.createReturnRequest(source.client.auth, String(source.preorder.id), {
      reason: '合并后退货验证',
      items: [{ productId: String(product.id), qty: 1 }],
    })
    const persistedReturnRequest = await AppDataSource.getRepository(O2oReturnRequest).findOneByOrFail({
      id: returnRequest.id,
    })
    assert.equal(String(persistedReturnRequest.orderId), String(source.preorder.id), '合并后退货仍必须绑定来源原预订单')
    const returnVerifyResult = await o2oPreorderService.verifyByCode(returnRequest.verifyCode, actor)
    assert.equal(returnVerifyResult?.verifyTargetType, 'return_request', '合并后退货核销应正常完成')

    await AppDataSource.getRepository(O2oReturnRequest).save(AppDataSource.getRepository(O2oReturnRequest).create({
      returnNo: `TH-ISSUE71-${seed}`,
      orderId: pendingSource.preorder.id,
      clientUserId: pendingSource.client.entity.id,
      verifyCode: randomUUID(),
      status: 'pending',
      sourceOrderStatus: 'verified',
      reason: '待退货阻断验证',
      totalQty: 1,
      handledAt: null,
      handledBy: null,
      rejectedReason: null,
      verifiedAt: null,
      verifiedBy: null,
    }))
    const pendingReturnPreview = await orderMergeService.preview({
      target: { orderId: String(pendingTarget.outbound.id), editVersion: 1 },
      sources: [{ orderId: String(pendingSource.outbound.id), editVersion: 1 }],
      reason: '待退货订单禁止合并',
    }, actor)
    assert.equal(pendingReturnPreview.ready, false)
    assert.match(pendingReturnPreview.blockers.map((item) => item.code).join(','), /PENDING_RETURN_EXISTS/)

    const deleteTarget = await createVerifiedPair(0, 1)
    const deleteSource = await createVerifiedPair(1, 1)
    await orderService.commitMerge({
      target: { orderId: String(deleteTarget.outbound.id), editVersion: 1 },
      sources: [{ orderId: String(deleteSource.outbound.id), editVersion: 1 }],
      reason: '待退货合并树软删并发门禁验证',
      idempotencyKey: `issue71-o2o-delete-guard-${seed}`,
    }, actor)
    const deleteGuardReturn = await o2oPreorderService.createReturnRequest(
      deleteSource.client.auth,
      String(deleteSource.preorder.id),
      {
        reason: '父单软删前待处理退货验证',
        items: [{ productId: String(product.id), qty: 1 }],
      },
    )
    await assert.rejects(
      () => orderService.softDeleteById(
        String(deleteTarget.outbound.id),
        actor,
        deleteTarget.outbound.showNo,
      ),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '合并组任一原预订单存在 pending 退货时必须原子阻断父单软删',
    )
    assert.equal(Boolean((await outboundRepo.findOneByOrFail({ id: deleteTarget.outbound.id })).isDeleted), false)
    assert.equal(Boolean((await preorderRepo.findOneByOrFail({ id: deleteTarget.preorder.id })).isDeleted), false)
    assert.equal(Boolean((await preorderRepo.findOneByOrFail({ id: deleteSource.preorder.id })).isDeleted), false)
    const deleteGuardVerify = await o2oPreorderService.verifyByCode(deleteGuardReturn.verifyCode, actor)
    assert.equal(deleteGuardVerify?.verifyTargetType, 'return_request', '软删被阻断后原退货申请必须仍可正常核销')

    await orderService.softDeleteById(String(target.outbound.id), actor, target.outbound.showNo)
    assert.equal(Boolean((await preorderRepo.findOneByOrFail({ id: target.preorder.id })).isDeleted), true)
    assert.equal(Boolean((await preorderRepo.findOneByOrFail({ id: source.preorder.id })).isDeleted), true, '父单软删必须联动所有来源预订单')
    await orderService.restoreById(String(target.outbound.id), actor)
    assert.equal(Boolean((await preorderRepo.findOneByOrFail({ id: target.preorder.id })).isDeleted), false)
    assert.equal(Boolean((await preorderRepo.findOneByOrFail({ id: source.preorder.id })).isDeleted), false, '父单恢复必须联动所有来源预订单')

    await assert.rejects(
      () => o2oPreorderService.deleteConsoleOrder({
        orderId: String(source.preorder.id),
        confirmShowNo: source.preorder.showNo,
      }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '任意合并成员关联的 O2O 预订单必须阻断永久删除',
    )

    console.log('✅ Issue #71 O2O 合并边界专项验证通过')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    fs.rmSync(sqlitePath, { force: true })
  }
}

main().catch((error) => {
  console.error('❌ Issue #71 O2O 合并边界专项验证失败', error)
  process.exitCode = 1
})
