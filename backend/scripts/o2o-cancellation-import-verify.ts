/**
 * 文件说明：验证 O2O 预订单取消留痕在 JSON 备份校验链路中的保真性。
 * 文件职责：覆盖取消来源、取消说明和取消时间的导出 JSON -> 导入校验回环，以及历史备份兼容和非法值拒绝。
 * 维护说明：若预订单取消字段或枚举变更，必须同步更新本脚本，确保备份恢复不会静默丢失取消留痕。
 */

import assert from 'node:assert/strict'
import { O2O_PREORDER_CANCELLATION_SOURCES } from '../src/entities/o2o-preorder.entity.js'
import { EXPORT_VERSION, type ExportPayload, validateExportPayload } from '../src/services/data-maintenance.shared.js'

const NOW = '2026-09-05T08:00:00.000Z'

assert.deepEqual(O2O_PREORDER_CANCELLATION_SOURCES, ['client', 'admin', 'system'])

function buildPreorder(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    showNo: `PO-${id}`,
    clientUserId: 'client-1',
    verifyCode: `VERIFY-${id}`,
    status: 'cancelled',
    cancelReason: 'manual',
    businessStatus: null,
    merchantMessage: null,
    clientOrderType: 'walkin',
    departmentNameSnapshot: null,
    isSystemApplied: false,
    hasCustomerOrder: false,
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function buildPayload(preorders: Record<string, unknown>[]): ExportPayload {
  return {
    exportedAt: NOW,
    version: EXPORT_VERSION,
    tables: {
      systemConfigs: [],
      products: [],
      clientUsers: [{
        id: 'client-1',
        mobile: '13800138000',
        email: null,
        passwordHash: 'test-password-hash',
        realName: '备份验证用户',
        departmentName: '',
        status: 'enabled',
        lastLoginAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      preorders,
      preorderItems: [],
      inventoryLogs: [],
    },
  }
}

function expectInvalid(payload: ExportPayload, expectedMessage: string) {
  assert.throws(
    () => validateExportPayload(payload),
    (error: unknown) => error instanceof Error && error.message.includes(expectedMessage),
    `应拒绝：${expectedMessage}`,
  )
}

const exportedPayload = buildPayload([
  buildPreorder('admin', {
    cancellationSource: 'admin',
    cancellationRemark: '管理员库存盘点取消',
    cancelledAt: '2026-09-04T10:00:00.000Z',
  }),
  buildPreorder('client', {
    cancellationSource: 'client',
    cancellationRemark: '用户主动撤回',
    cancelledAt: '2026-09-04T11:00:00.000Z',
  }),
  buildPreorder('timeout', {
    cancelReason: 'timeout',
    cancellationSource: 'system',
    cancellationRemark: '订单超时自动取消',
    cancelledAt: '2026-09-04T12:00:00.000Z',
  }),
  buildPreorder('legacy'),
])

const restoredPayload = validateExportPayload(JSON.parse(JSON.stringify(exportedPayload)) as ExportPayload)
const restoredPreorders = Object.fromEntries(restoredPayload.tables.preorders.map((row) => [row.id, row]))

assert.deepEqual(restoredPreorders.admin.cancellationSource, 'admin')
assert.deepEqual(restoredPreorders.admin.cancellationRemark, '管理员库存盘点取消')
assert.deepEqual(restoredPreorders.admin.cancelledAt, '2026-09-04T10:00:00.000Z')
assert.deepEqual(restoredPreorders.client.cancellationSource, 'client')
assert.deepEqual(restoredPreorders.client.cancellationRemark, '用户主动撤回')
assert.deepEqual(restoredPreorders.client.cancelledAt, '2026-09-04T11:00:00.000Z')
assert.deepEqual(restoredPreorders.timeout.cancellationSource, 'system')
assert.deepEqual(restoredPreorders.timeout.cancellationRemark, '订单超时自动取消')
assert.deepEqual(restoredPreorders.timeout.cancelledAt, '2026-09-04T12:00:00.000Z')
assert.equal(restoredPreorders.legacy.cancellationSource, null)
assert.equal(restoredPreorders.legacy.cancellationRemark, null)
assert.equal(restoredPreorders.legacy.cancelledAt, null)

expectInvalid(buildPayload([buildPreorder('invalid-source', {
  cancellationSource: 'operator',
  cancellationRemark: '非法来源',
  cancelledAt: '2026-09-04T10:00:00.000Z',
})]), '预订单取消来源取值非法')
expectInvalid(buildPayload([buildPreorder('too-long-remark', {
  cancellationSource: 'admin',
  cancellationRemark: 'x'.repeat(201),
  cancelledAt: '2026-09-04T10:00:00.000Z',
})]), 'cancellationRemark 长度不能超过 200 个字符')
expectInvalid(buildPayload([buildPreorder('invalid-date', {
  cancellationSource: 'admin',
  cancellationRemark: '非法日期',
  cancelledAt: '不是日期',
})]), 'cancelledAt 日期非法')

console.log('✅ O2O 取消留痕 JSON 导出/校验回环、历史兼容和非法值拦截通过')
