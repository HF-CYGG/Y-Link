/**
 * 模块说明：backend/scripts/security-business-contract-verify.ts
 * 文件职责：回归校验 Web 业务边界工作包中的输入上限、打印状态、导出租约、路由装配、回跳与图表 HTML 输出契约。
 * 实现逻辑：
 * - 对跨模块边界采用源码契约与可调用导航函数相结合的方式，避免依赖本机开发数据库；
 * - 重点固定明细数量、角色边界、流式导出与匿名路由的安全约束；
 * - 本脚本不启动应用、不写业务数据，可安全用于本地回归。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_DATABASE_INT, MAX_O2O_ORDER_ITEM_COUNT, MAX_INBOUND_ORDER_ITEM_COUNT } from '../src/constants/web-resource-limits.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(backendRoot, '..')
const readSource = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')

const o2oRouteSource = readSource('backend/src/routes/o2o.routes.ts')
const o2oServiceSource = readSource('backend/src/services/o2o-preorder.service.ts')
const inboundRouteSource = readSource('backend/src/routes/inbound.routes.ts')
const inboundServiceSource = readSource('backend/src/services/inbound.service.ts')
const reportRouteSource = readSource('backend/src/routes/report.routes.ts')
const reportServiceSource = readSource('backend/src/services/report.service.ts')
const routeContractSource = readSource('backend/scripts/task2-route-permission-contract-verify.ts')
const trendChartSource = readSource('src/views/dashboard/components/TrendChartCard.vue')

function assertBoundedDetailInputs(source: string, label: string) {
  assert.match(source, /from '\.\.\/constants\/web-resource-limits\.js'/, `${label} 路由必须复用统一的单据输入上限`)
  assert.match(source, /\.max\(MAX_[A-Z0-9_]*ITEM_COUNT/, `${label} 路由必须拒绝超过 200 条的原始明细`)
  assert.match(source, /\.max\(MAX_DATABASE_INT/, `${label} 路由必须拒绝超过数据库 INT 上限的单条数量`)
}

async function main() {
  assert.equal(MAX_O2O_ORDER_ITEM_COUNT, 200)
  assert.equal(MAX_INBOUND_ORDER_ITEM_COUNT, 200)
  assert.equal(MAX_DATABASE_INT, 2_147_483_647)
  assertBoundedDetailInputs(o2oRouteSource, 'O2O')
  assertBoundedDetailInputs(inboundRouteSource, '供应方送货单')
  assert.match(o2oServiceSource, /MAX_O2O_ORDER_ITEM_COUNT/, 'O2O 服务层必须再次限制原始明细数量')
  assert.match(o2oServiceSource, /assertPreorderQuantityBounds/, 'O2O 服务层必须校验合并后每项与总数量的 INT 上限')
  assert.match(inboundServiceSource, /MAX_INBOUND_ORDER_ITEM_COUNT/, '入库服务层必须再次限制原始明细数量')
  assert.match(inboundServiceSource, /assertInboundQuantityBounds/, '入库服务层必须校验合并后每项与总数量的 INT 上限')

  assert.match(o2oServiceSource, /order\.status === 'cancelled'/, '已取消订单不得标记打印；有效已核销部门订单保留补打兼容')
  assert.match(o2oRouteSource, /o2o\.preorder\.customer_order_print/, '首次标记打印必须留下审计记录')
  assert.match(o2oRouteSource, /printedNow/, '重复打印上报必须显式保持审计幂等')

  assert.match(reportServiceSource, /ReportExportLeasePool/, '报表导出必须通过进程内租约限制并发')
  assert.match(reportServiceSource, /finally[\s\S]*?lease\.release\(\)/, '报表导出流结束后必须在 finally 释放租约')
  assert.match(reportRouteSource, /authReq\.auth\.userId/, '报表导出必须使用真实管理端操作者身份分配租约')
  const { ReportExportLeasePool } = await import('../src/services/report.service.js')
  const leasePool = new ReportExportLeasePool()
  const primaryLease = leasePool.acquire('actor-1')
  assert.throws(() => leasePool.acquire('actor-1'), /已有报表导出/, '同一账号的第二个导出必须被拒绝')
  const secondLease = leasePool.acquire('actor-2')
  const thirdLease = leasePool.acquire('actor-3')
  const fourthLease = leasePool.acquire('actor-4')
  assert.throws(() => leasePool.acquire('actor-5'), /任务较多/, '单进程第五个导出必须被拒绝')
  primaryLease.release()
  const releasedCapacityLease = leasePool.acquire('actor-5')
  releasedCapacityLease.release()
  secondLease.release()
  thirdLease.release()
  fourthLease.release()
  assert.equal(leasePool.activeExports, 0, '全部导出结束后容量必须完全归还')

  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { inboundService } = await import('../src/services/inbound.service.js')
  const maxInt = 2_147_483_647
  const repeatedItems = Array.from({ length: 201 }, (_, index) => ({ productId: `product-${index}`, qty: 1 }))
  assert.throws(
    () => (o2oPreorderService as unknown as { normalizePreorderItems: (items: unknown[]) => unknown }).normalizePreorderItems(repeatedItems),
    /最多提交 200 条/,
    '绕过路由直调 O2O 服务时仍必须拒绝 201 条明细',
  )
  assert.throws(
    () => (o2oPreorderService as unknown as { normalizePreorderItems: (items: unknown[]) => unknown }).normalizePreorderItems([{ productId: 'first', qty: maxInt }, { productId: 'second', qty: 1 }]),
    /总数量超过系统可处理上限/,
    'O2O 合并重复明细后不得溢出数据库 INT',
  )
  assert.throws(
    () => (inboundService as unknown as { normalizeSupplierInboundItems: (items: unknown[]) => unknown }).normalizeSupplierInboundItems(repeatedItems),
    /最多提交 200 条/,
    '绕过路由直调入库服务时仍必须拒绝 201 条明细',
  )
  assert.throws(
    () => (inboundService as unknown as { normalizeSupplierInboundItems: (items: unknown[]) => unknown }).normalizeSupplierInboundItems([{ productId: 'first', qty: maxInt }, { productId: 'second', qty: 1 }]),
    /总数量超过系统可处理上限/,
    '供应方重复明细合并后不得溢出数据库 INT',
  )

  assert.match(routeContractSource, /from 'typescript'/, '路由契约必须使用 TypeScript compiler API')
  assert.match(routeContractSource, /createSourceFile/, '路由契约必须解析 AST，而非正则扫描装配')
  assert.match(routeContractSource, /databaseRescueRouter/, '路由契约必须识别 database rescue 路由')
  assert.match(routeContractSource, /requireDatabaseRescueCredential/, 'rescue API 必须有凭据守卫契约')

  assert.match(trendChartSource, /escapeTooltipHtml\(point\.label\)/, '趋势图 tooltip 必须转义动态标签')

  const { redirectToAdminLogin } = await import('../../src/utils/auth-navigation.js')
  const { redirectToClientLogin } = await import('../../src/utils/client-auth-navigation.js')
  for (const unsafePath of ['\\\\evil.example', '//evil.example', '/\\evil.example', '/ok\u0000next']) {
    assert.equal(redirectToAdminLogin({ redirect: unsafePath }), '/login', `管理端必须拒绝不安全回跳：${JSON.stringify(unsafePath)}`)
    assert.equal(redirectToClientLogin({ redirect: unsafePath }), '/client/login', `客户端必须拒绝不安全回跳：${JSON.stringify(unsafePath)}`)
  }
  assert.equal(redirectToAdminLogin({ redirect: '/orders?tab=mine' }), '/login?redirect=%2Forders%3Ftab%3Dmine')
  assert.equal(redirectToClientLogin({ redirect: '/client/orders' }), '/client/login?redirect=%2Fclient%2Forders')

  console.log('Web 业务边界安全契约验证通过')
}

main().catch((error) => {
  console.error('Web 业务边界安全契约验证失败', error)
  process.exitCode = 1
})
