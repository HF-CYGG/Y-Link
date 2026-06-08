/**
 * 文件说明：backend/scripts/task2-verify.ts
 * 文件职责：验证单双流水号、订单类型校验、默认出单人逻辑与流水配置异常处理。
 * 维护说明：若调整单号生成规则、出库提交入参或系统配置键名，请同步更新本脚本。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'

const runtimeRoot = path.resolve(process.cwd(), '.local-dev')
const sqlitePath = path.resolve(runtimeRoot, `task2-verify-${Date.now()}.sqlite`)

process.env.APP_PROFILE = `task2-verify-${Date.now()}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

const mockActor: AuthUserContext = {
  userId: '10001',
  username: 'task2op',
  displayName: 'Task2操作员',
  role: 'operator',
  permissions: [],
  status: 'enabled',
  sessionToken: 'task2-token',
}

function pass(message: string) {
  console.log(`✅ ${message}`)
}

async function expectBizError(
  task: string,
  runner: () => Promise<unknown>,
  statusCode: number,
  keyword: string,
  BizErrorCtor: new (...args: any[]) => Error,
) {
  try {
    await runner()
    assert.fail(`${task} 未抛出 BizError`)
  } catch (error) {
    assert.ok(error instanceof BizErrorCtor, `${task} 应抛出 BizError`)
    const bizError = error as Error & { statusCode: number }
    assert.equal(bizError.statusCode, statusCode, `${task} 错误码不符合预期`)
    assert.match(bizError.message, new RegExp(keyword), `${task} 错误文案不符合预期`)
  }
}

async function main() {
  const [
    { AppDataSource },
    { BaseProduct },
    { BizOutboundOrder },
    { ClientUser },
    { O2oPreorder },
    { SystemConfig },
    { orderSerialService },
    { orderService },
    { systemConfigService },
    { BizError },
  ] =
    await Promise.all([
      import('../src/config/data-source.js'),
      import('../src/entities/base-product.entity.js'),
      import('../src/entities/biz-outbound-order.entity.js'),
      import('../src/entities/client-user.entity.js'),
      import('../src/entities/o2o-preorder.entity.js'),
      import('../src/entities/system-config.entity.js'),
      import('../src/services/order-serial.service.js'),
      import('../src/services/order.service.js'),
      import('../src/services/system-config.service.js'),
      import('../src/utils/errors.js'),
    ])

  fs.mkdirSync(runtimeRoot, { recursive: true })
  await AppDataSource.initialize()

  try {
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()

    const productRepo = AppDataSource.getRepository(BaseProduct)
    const createdProduct = await productRepo.save(
      productRepo.create({
        productCode: 'TASK2P01',
        productName: 'Task2验证产品',
        pinyinAbbr: 'TASK2',
        defaultPrice: '12.50',
        isActive: true,
      }),
    )

    const walkinOrder = await orderService.submit(
      {
        idempotencyKey: `task2-walkin-${Date.now()}`,
        orderType: 'walkin',
        customerName: '散客A',
        items: [{ productId: String(createdProduct.id), qty: 1, unitPrice: 12.5 }],
      },
      mockActor,
    )
    assert.match(walkinOrder.order.showNo, /^hyyz\d{6}$/)

    const departmentOrder = await orderService.submit(
      {
        idempotencyKey: `task2-department-${Date.now()}`,
        orderType: 'department',
        issuerName: '值班出单员',
        customerDepartmentName: '后勤保障部',
        customerName: '后勤客户',
        items: [{ productId: String(createdProduct.id), qty: 2, unitPrice: 12.5 }],
      },
      mockActor,
    )
    assert.match(departmentOrder.order.showNo, /^hyyzjd\d{6}$/)
    pass('创建接口已按 orderType 生成 showNo，且双流水前缀正确')

    const secondWalkinOrder = await orderService.submit(
      {
        idempotencyKey: `task2-walkin-second-${Date.now()}`,
        orderType: 'walkin',
        customerName: '散客B',
        items: [{ productId: String(createdProduct.id), qty: 1, unitPrice: 12.5 }],
      },
      mockActor,
    )
    const walkinSerialA = Number.parseInt(walkinOrder.order.showNo.replace('hyyz', ''), 10)
    const walkinSerialB = Number.parseInt(secondWalkinOrder.order.showNo.replace('hyyz', ''), 10)
    assert.equal(walkinSerialB, walkinSerialA + 1)
    pass('散客流水号连续递增且不受部门流水影响')

    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const thirdWalkinOrder = await orderService.submit(
      {
        idempotencyKey: `task2-walkin-third-${Date.now()}`,
        orderType: 'walkin',
        customerName: '散客C',
        items: [{ productId: String(createdProduct.id), qty: 1, unitPrice: 12.5 }],
      },
      mockActor,
    )
    const thirdWalkinSerial = Number.parseInt(thirdWalkinOrder.order.showNo.replace('hyyz', ''), 10)
    assert.equal(thirdWalkinSerial, walkinSerialB + 1)

    await orderRepo.update({ id: thirdWalkinOrder.order.id }, { isDeleted: true, deletedAt: new Date() })
    let recalibrationResult = await orderSerialService.recalibrateCurrentFromOccupancy('walkin')
    assert.equal(recalibrationResult.current, thirdWalkinSerial)
    assert.equal(recalibrationResult.maxOccupiedSerial, thirdWalkinSerial)
    pass('软删除出库单仍占用流水，避免恢复时单号冲突')

    await orderRepo.delete({ id: thirdWalkinOrder.order.id })
    recalibrationResult = await orderSerialService.recalibrateCurrentFromOccupancy('walkin')
    assert.equal(recalibrationResult.current, walkinSerialB)
    assert.equal(recalibrationResult.maxOccupiedSerial, walkinSerialB)
    assert.equal(recalibrationResult.rolledBack, true)
    pass('永久删除最大流水单后，current 按剩余最大单号重算')

    const clientUserRepo = AppDataSource.getRepository(ClientUser)
    const preorderRepo = AppDataSource.getRepository(O2oPreorder)
    const serialOccupiedByPreorder = walkinSerialB + 1
    const occupiedPreorderShowNo = `hyyz${String(serialOccupiedByPreorder).padStart(6, '0')}`
    const serialClientUser = await clientUserRepo.save(
      clientUserRepo.create({
        mobile: `139${String(Date.now()).slice(-8)}`,
        email: null,
        passwordHash: 'task2-password-hash',
        realName: 'Task2流水校准客户',
        departmentName: '',
        accountType: 'personal',
        staffNo: null,
        staffVerified: false,
        status: 'enabled',
      }),
    )
    await preorderRepo.save(
      preorderRepo.create({
        showNo: occupiedPreorderShowNo,
        clientUserId: serialClientUser.id,
        verifyCode: `task2-verify-${Date.now()}`,
        status: 'pending',
        cancelReason: null,
        businessStatus: null,
        merchantMessage: null,
        clientOrderType: 'walkin',
        departmentNameSnapshot: null,
        staffNoSnapshot: null,
        isSystemApplied: false,
        hasCustomerOrder: false,
        pickupContact: 'Task2流水校准客户',
        totalQty: 1,
        remark: null,
        updateCount: 0,
        timeoutAt: null,
        verifiedAt: null,
        verifiedBy: null,
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deletedByUsername: null,
        deletedByDisplayName: null,
      }),
    )
    const generatedAfterStaleCurrent = await orderSerialService.generateOrderNo('walkin')
    const generatedAfterStaleSerial = Number.parseInt(generatedAfterStaleCurrent.replace('hyyz', ''), 10)
    assert.equal(generatedAfterStaleSerial, serialOccupiedByPreorder + 1)
    pass('流水 current 落后于已有预订单时会自动跳过已占用单号')

    const serialOccupiedByHiddenVerifiedPreorder = generatedAfterStaleSerial + 1
    await preorderRepo.save(
      preorderRepo.create({
        showNo: `hyyz${String(serialOccupiedByHiddenVerifiedPreorder).padStart(6, '0')}`,
        clientUserId: serialClientUser.id,
        verifyCode: `task2-hidden-verified-${Date.now()}`,
        status: 'verified',
        cancelReason: null,
        businessStatus: null,
        merchantMessage: null,
        clientOrderType: 'walkin',
        departmentNameSnapshot: null,
        staffNoSnapshot: null,
        isSystemApplied: false,
        hasCustomerOrder: false,
        pickupContact: 'Task2隐藏已核销客户',
        totalQty: 1,
        remark: null,
        updateCount: 0,
        timeoutAt: null,
        verifiedAt: new Date(),
        verifiedBy: 'task2',
        isDeleted: true,
        deletedAt: new Date(),
        deletedByUserId: serialClientUser.id,
        deletedByUsername: 'task2',
        deletedByDisplayName: 'Task2隐藏已核销客户',
      }),
    )
    const generatedAfterHiddenVerified = await orderSerialService.generateOrderNo('walkin')
    const generatedAfterHiddenVerifiedSerial = Number.parseInt(generatedAfterHiddenVerified.replace('hyyz', ''), 10)
    assert.equal(generatedAfterHiddenVerifiedSerial, serialOccupiedByHiddenVerifiedPreorder + 1)
    pass('已核销或客户端隐藏的预订单仍参与流水占用校准')

    const savedWalkinOrder = await orderRepo.findOneOrFail({ where: { id: walkinOrder.order.id } })
    const savedDepartmentOrder = await orderRepo.findOneOrFail({ where: { id: departmentOrder.order.id } })
    assert.equal(savedWalkinOrder.issuerName, mockActor.displayName)
    assert.equal(savedDepartmentOrder.issuerName, '值班出单员')
    assert.equal(savedDepartmentOrder.orderType, 'department')
    assert.equal(savedDepartmentOrder.customerDepartmentName, '后勤保障部')
    pass('issuerName 默认逻辑与自定义覆盖逻辑生效')

    await expectBizError(
      '非法 orderType 校验',
      () =>
        orderService.submit(
          {
            idempotencyKey: `task2-invalid-type-${Date.now()}`,
            orderType: 'other',
            items: [{ productId: String(createdProduct.id), qty: 1, unitPrice: 12.5 }],
          },
          mockActor,
        ),
      400,
      '订单类型非法',
      BizError,
    )

    const configRepo = AppDataSource.getRepository(SystemConfig)
    await configRepo.delete({ configKey: 'order.serial.walkin.current' })
    await expectBizError('配置缺失校验', () => orderSerialService.generateOrderNo('walkin'), 500, '配置缺失', BizError)

    await configRepo.insert({
      configKey: 'order.serial.walkin.current',
      configValue: '999999',
      configGroup: 'order_serial',
      remark: '散客单号当前值',
    })
    await expectBizError('序号上限校验', () => orderSerialService.generateOrderNo('walkin'), 409, '位宽上限', BizError)
    pass('参数校验与错误码行为符合预期')

    const generatedDepartmentOrderNos: string[] = []
    for (let i = 0; i < 6; i += 1) {
      generatedDepartmentOrderNos.push(await orderSerialService.generateOrderNo('department'))
    }
    const uniqueOrderNos = new Set(generatedDepartmentOrderNos)
    assert.equal(uniqueOrderNos.size, generatedDepartmentOrderNos.length)
    assert.equal(generatedDepartmentOrderNos.every((item) => /^hyyzjd\d{6}$/.test(item)), true)
    pass('OrderSerialService 连续生成场景下无重复单号')
  } finally {
    await AppDataSource.destroy()
    fs.rmSync(sqlitePath, { force: true })
  }
}

try {
  await main()
  console.log('Task2 自动化验证通过')
} catch (error) {
  console.error('Task2 自动化验证失败', error)
  process.exit(1)
}
