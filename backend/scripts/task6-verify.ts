/**
 * 模块说明：Task6 自动化验证脚本
 * 文件职责：验证开单事务原子性、单号递增规则、检索条件与多端交互实现存在性
 * 维护说明：涉及开单事务、检索或多端交互改造时，需同步更新此脚本断言
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { AppDataSource } from '../src/config/data-source.js'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../src/entities/biz-outbound-order-item.entity.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { SysAuditLog } from '../src/entities/sys-audit-log.entity.js'
import { orderService } from '../src/services/order.service.js'
import type { AuthUserContext } from '../src/types/auth.js'
import { generateShowNo } from '../src/utils/id-generator.js'

/**
 * Task 6 自动化验证脚本（无需真实 MySQL）：
 * 1) 用内存仓储模拟 TypeORM 事务，验证“主子表原子提交 + 失败回滚 + 幂等防重”；
 * 2) 验证 show_no 当日流水规则（CK-YYYYMMDD-4位）；
 * 3) 用源码静态断言验证“拼音检索 + 标签过滤 + PC键盘流 + 移动端 Drawer”关键实现存在。
 *
 * 说明：
 * - 本脚本目标是解决 CI 或本地未启动 MySQL 时无法执行联调的问题；
 * - 一旦生产环境可连库，仍建议再跑一次真实 API 联调回归。
 */

interface OrderRecord {
  id: string
  orderUuid: string
  showNo: string
  idempotencyKey: string
  customerName: string | null
  remark: string | null
  totalQty: string
  totalAmount: string
}

interface ItemRecord {
  id: string
  orderId: string
  lineNo: number
  productId: string
  productNameSnapshot: string
  qty: string
  unitPrice: string
  lineAmount: string
  remark: string | null
}

interface AuditLogRecord {
  id: string
  actionType: string
  actionLabel: string
  actorUserId: string | null
  actorUsername: string | null
  actorDisplayName: string | null
  targetType: string
  targetId: string | null
  targetCode: string | null
  resultStatus: string
  detailJson: string | null
  ipAddress: string | null
  userAgent: string | null
}

/**
 * 统一断言输出，失败时抛错并让 npm script 直接退出非 0。
 */
function pass(title: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${title}`)
}

/**
 * 构建与 generateShowNo 兼容的最小 manager：
 * - 仅实现 query()；
 * - 通过内存 order 列表返回“今日最后一单”。
 */
function createShowNoManager(orders: OrderRecord[]) {
  return {
    connection: {
      options: {
        type: 'sqlite',
      },
    },
    async query(_sql: string, params: unknown[]) {
      const rawPrefix = typeof params[0] === 'string' ? params[0] : ''
      const prefix = rawPrefix.replace('%', '')
      const matched = orders
        .filter((order) => order.showNo.startsWith(prefix))
        .sort((a, b) => b.showNo.localeCompare(a.showNo))
      if (!matched.length) {
        return []
      }
      return [{ show_no: matched[0].showNo }]
    },
  }
}

function findOrderByWhere(
  orders: OrderRecord[],
  where: { idempotencyKey?: string; id?: string; showNo?: string },
): OrderRecord | null {
  if (where.idempotencyKey) {
    return orders.find((item) => item.idempotencyKey === where.idempotencyKey) ?? null
  }
  if (where.id) {
    return orders.find((item) => item.id === where.id) ?? null
  }
  if (where.showNo) {
    return orders.find((item) => item.showNo === where.showNo) ?? null
  }
  return null
}

function createOrderRepository(
  stagedOrders: OrderRecord[],
  getNextOrderId: () => string,
) {
  return {
    async findOne(args: { where?: { idempotencyKey?: string; id?: string; showNo?: string } }) {
      return findOrderByWhere(stagedOrders, args.where ?? {})
    },
    create(args: Partial<OrderRecord>) {
      return { ...args } as OrderRecord
    },
    async save(args: OrderRecord) {
      const row = { ...args, id: getNextOrderId() }
      stagedOrders.push(row)
      return row
    },
    async find() {
      return []
    },
  }
}

function createOrderItemRepository(
  stagedItems: ItemRecord[],
  shouldFailOnItemSaveRef: { value: boolean },
  getNextItemId: () => string,
) {
  return {
    async find(args: { where?: { orderId?: string } }) {
      const orderId = args.where?.orderId
      const rows = orderId ? stagedItems.filter((item) => item.orderId === orderId) : stagedItems
      return rows.sort((a, b) => a.lineNo - b.lineNo)
    },
    create(args: Partial<ItemRecord>) {
      return { ...args } as ItemRecord
    },
    async save(args: ItemRecord[]) {
      if (shouldFailOnItemSaveRef.value) {
        throw new Error('模拟明细写入失败')
      }
      const rows = args.map((item) => {
        const row = { ...item, id: getNextItemId() }
        stagedItems.push(row)
        return row
      })
      return rows
    },
    async findOne() {
      return null
    },
  }
}

function createProductRepository(products: Array<{ id: string; productName: string; isActive: boolean }>) {
  /**
   * 模拟 TypeORM QueryBuilder：
   * - orderService 当前通过 createQueryBuilder + IN 条件查询启用产品；
   * - 这里仅实现脚本验证所需的最小 where/andWhere/getMany 子集，保持与真实调用链兼容。
   */
  const createMockQueryBuilder = () => {
    let filtered = [...products]

    return {
      where(_sql: string, params: { productIds?: string[] }) {
        const productIds = new Set((params.productIds ?? []).map(String))
        filtered = filtered.filter((item) => productIds.has(String(item.id)))
        return this
      },
      andWhere(_sql: string, params: { isActive?: boolean }) {
        if (typeof params.isActive === 'boolean') {
          filtered = filtered.filter((item) => item.isActive === params.isActive)
        }
        return this
      },
      async getMany() {
        return filtered
      },
    }
  }

  return {
    async find(args: { where: Array<{ id: string; isActive: boolean }> }) {
      const ids = new Set(args.where.map((item) => item.id))
      return products.filter((item) => ids.has(item.id) && item.isActive)
    },
    async findOne() {
      return null
    },
    create(args: unknown) {
      return args
    },
    async save(args: unknown) {
      return args
    },
    createQueryBuilder() {
      return createMockQueryBuilder()
    },
  }
}

function createAuditLogRepository(stagedLogs: AuditLogRecord[], getNextAuditLogId: () => string) {
  return {
    create(args: Partial<AuditLogRecord>) {
      return { ...args } as AuditLogRecord
    },
    async save(args: AuditLogRecord) {
      const row = { ...args, id: getNextAuditLogId() }
      stagedLogs.push(row)
      return row
    },
  }
}

function createMockManager(
  stagedOrders: OrderRecord[],
  stagedItems: ItemRecord[],
  stagedAuditLogs: AuditLogRecord[],
  products: Array<{ id: string; productName: string; isActive: boolean }>,
  shouldFailOnItemSaveRef: { value: boolean },
  opts: {
    getNextOrderId: () => string
    getNextItemId: () => string
    getNextAuditLogId: () => string
  }
) {
  const { getNextOrderId, getNextItemId, getNextAuditLogId } = opts
  const showNoManager = createShowNoManager(stagedOrders)
  return {
    connection: showNoManager.connection,
    query: async (sql: string, params: unknown[]) => showNoManager.query(sql, params),
    getRepository: (entity: unknown) => {
      const getRepo = () => {
        if (entity === BizOutboundOrder) {
          return createOrderRepository(stagedOrders, getNextOrderId)
        }
        if (entity === BizOutboundOrderItem) {
          return createOrderItemRepository(stagedItems, shouldFailOnItemSaveRef, getNextItemId)
        }
        if (entity === BaseProduct) {
          return createProductRepository(products)
        }
        if (entity === SysAuditLog) {
          return createAuditLogRepository(stagedAuditLogs, getNextAuditLogId)
        }
        throw new Error('未处理的仓储类型')
      }
      return getRepo() as any
    },
  }
}

/**
 * 事务验证主流程：
 * - 用闭包保存“已提交数据”；
 * - transaction 内先复制快照，成功才提交，失败则丢弃快照实现回滚语义。
 */
async function verifyOrderTransactionAndNumbering() {
  const committedOrders: OrderRecord[] = []
  const committedItems: ItemRecord[] = []
  const committedAuditLogs: AuditLogRecord[] = []
  const products = [{ id: '1001', productName: '电缆', isActive: true }]
  /**
   * 构建固定的验证操作者上下文：
   * - 显式声明返回 AuthUserContext，避免编辑器在增量诊断时把对象字面量推断为不完整类型；
   * - 每次提交复用同一份结构，确保权限字段稳定存在。
   */
  const createMockActor = (): AuthUserContext => ({
    userId: '9001',
    username: 'verifier',
    displayName: '验证脚本',
    role: 'admin',
    status: 'enabled',
    sessionToken: 'task6-verify-session',
    permissions: [],
  })
  const mockActor = createMockActor()

  const shouldFailOnItemSaveRef = { value: false }
  let orderSeq = 0
  let itemSeq = 0
  let auditLogSeq = 0

  const originalTransaction = AppDataSource.transaction.bind(AppDataSource)

  ;(AppDataSource as unknown as { transaction: unknown }).transaction = async (
    cb: (manager: {
      query: (sql: string, params: unknown[]) => Promise<Array<{ show_no: string }>>
      getRepository: (entity: unknown) => {
        findOne: (args: unknown) => Promise<unknown>
        find: (args?: unknown) => Promise<unknown[]>
        create: (args: unknown) => unknown
        save: (args: unknown) => Promise<unknown>
      }
    }) => Promise<unknown>,
  ) => {
    const stagedOrders = committedOrders.map((item) => ({ ...item }))
    const stagedItems = committedItems.map((item) => ({ ...item }))
    const stagedAuditLogs = committedAuditLogs.map((item) => ({ ...item }))
    const manager = createMockManager(
      stagedOrders,
      stagedItems,
      stagedAuditLogs,
      products,
      shouldFailOnItemSaveRef,
      {
        getNextOrderId: () => String(++orderSeq),
        getNextItemId: () => String(++itemSeq),
        getNextAuditLogId: () => String(++auditLogSeq),
      }
    )
    const result = await cb(manager)
    committedOrders.length = 0
    committedOrders.push(...stagedOrders)
    committedItems.length = 0
    committedItems.push(...stagedItems)
    committedAuditLogs.length = 0
    committedAuditLogs.push(...stagedAuditLogs)
    return result
  }

  try {
    const first = await orderService.submit(
      {
        idempotencyKey: 'task6-idem-0001',
        customerName: '客户A',
        remark: '首单',
        items: [{ productId: '1001', qty: 2, unitPrice: 12.5 }],
      },
      mockActor,
    )

    assert.equal(committedOrders.length, 1)
    assert.equal(committedItems.length, 1)
    assert.match(first.order.showNo, /^CK-\d{8}-0001$/)
    pass('整单提交成功：主子表均写入且 show_no 首单流水为 0001')

    const duplicated = await orderService.submit(
      {
        idempotencyKey: 'task6-idem-0001',
        customerName: '客户A',
        items: [{ productId: '1001', qty: 9, unitPrice: 99 }],
      },
      mockActor,
    )
    assert.equal(committedOrders.length, 1)
    assert.equal(duplicated.order.id, first.order.id)
    pass('幂等防重生效：重复 idempotencyKey 不重复落库')

    shouldFailOnItemSaveRef.value = true
    await assert.rejects(
      orderService.submit(
        {
          idempotencyKey: 'task6-idem-rollback',
          customerName: '客户B',
          items: [{ productId: '1001', qty: 1, unitPrice: 10 }],
        },
        mockActor,
      ),
    )
    assert.equal(committedOrders.length, 1)
    assert.equal(committedItems.length, 1)
    pass('事务回滚生效：明细写入失败时主表未脏写')
    shouldFailOnItemSaveRef.value = false

    const second = await orderService.submit(
      {
        idempotencyKey: 'task6-idem-0002',
        customerName: '客户C',
        items: [{ productId: '1001', qty: 3, unitPrice: 8 }],
      },
      mockActor,
    )
    assert.match(second.order.showNo, /^CK-\d{8}-0002$/)
    pass('编号规则生效：同日第二张单据流水递增到 0002')
  } finally {
    ;(AppDataSource as unknown as { transaction: unknown }).transaction = originalTransaction
  }
}

/**
 * 单独验证 generateShowNo 在“空数据集”时从 0001 起算。
 */
async function verifyShowNoStartsFrom0001() {
  const showNo = await generateShowNo(createShowNoManager([]) as never)
  assert.match(showNo, /^CK-\d{8}-0001$/)
  pass('编号生成器在无历史单据时从 0001 开始')
}

/**
 * 前端/检索能力的自动化静态检查：
 * - 检索：后端产品列表支持名称+拼音 keyword，且支持 tagId 关联过滤；
 * - 多端：开单页存在 PC/移动端分支、键盘流入口、Drawer 编辑组件。
 */
function verifySearchAndMultiDeviceByStaticChecks() {
  const productServiceFile = path.resolve(process.cwd(), 'src/services/product.service.ts')
  const orderEntryFile = path.resolve(process.cwd(), 'src/views/order-entry/OrderEntryView.vue')
  const orderEntryItemsEditorFile = path.resolve(process.cwd(), 'src/views/order-entry/components/OrderEntryItemsEditor.vue')

  const productServiceSource = fs.readFileSync(productServiceFile, 'utf8')
  const orderEntrySource = fs.readFileSync(orderEntryFile, 'utf8')
  const orderEntryItemsEditorSource = fs.readFileSync(orderEntryItemsEditorFile, 'utf8')

  assert.match(productServiceSource, /p\.product_name LIKE :keyword OR p\.pinyin_abbr LIKE :keyword/)
  assert.match(productServiceSource, /innerJoin\('rel_product_tag'/)
  pass('检索能力存在：后端已实现拼音模糊检索与标签过滤 SQL 条件')

  assert.match(orderEntrySource, /OrderEntryItemsEditor/)
  assert.match(orderEntrySource, /handleGridKeydown/)
  assert.match(orderEntryItemsEditorSource, /v-else-if="isDesktop"/)
  assert.match(orderEntryItemsEditorSource, /v-else class="space-y-3"/)
  assert.match(orderEntryItemsEditorSource, /<el-drawer/)
  pass('多端交互能力存在：PC 键盘流与移动端 Drawer 编辑分支齐全')
}

async function main() {
  await verifyShowNoStartsFrom0001()
  await verifyOrderTransactionAndNumbering()
  verifySearchAndMultiDeviceByStaticChecks()
  // eslint-disable-next-line no-console
  console.log('\nTask6 自动化验证全部通过。')
}

try {
  await main()
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\nTask6 自动化验证失败：', error)
  process.exit(1)
}
