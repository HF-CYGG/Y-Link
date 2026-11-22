/**
 * 模块说明：Task6 自动化验证脚本
 * 文件职责：验证开单事务原子性、单号递增规则、检索条件与多端交互实现存在性
 * 维护说明：涉及开单事务、检索或多端交互改造时，需同步更新此脚本断言
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'
import { createVerificationIsolation } from './verification-isolation.js'

const backendRoot = process.cwd()
const isolation = createVerificationIsolation('task6')
process.env.NODE_ENV = 'test'
process.env.SQLITE_BUSY_TIMEOUT_MS = '5000'
isolation.seal({ type: 'sqlite', database: path.join(isolation.rootDir, 'unused.sqlite') })

const [
  { AppDataSource }, { BizOutboundOrder }, { BizOutboundOrderItem }, { BaseProduct }, { BaseProductSku },
  { BusinessSequence }, { InvSkuLocationStock }, { InventoryLog }, { O2oPreorder }, { SystemConfig },
  { SysAuditLog }, { SysUser }, { orderService }, { orderSerialService },
] = await Promise.all([
  import('../src/config/data-source.js'),
  import('../src/entities/biz-outbound-order.entity.js'),
  import('../src/entities/biz-outbound-order-item.entity.js'),
  import('../src/entities/base-product.entity.js'),
  import('../src/entities/base-product-sku.entity.js'),
  import('../src/entities/business-sequence.entity.js'),
  import('../src/entities/inv-sku-location-stock.entity.js'),
  import('../src/entities/inventory-log.entity.js'),
  import('../src/entities/o2o-preorder.entity.js'),
  import('../src/entities/system-config.entity.js'),
  import('../src/entities/sys-audit-log.entity.js'),
  import('../src/entities/sys-user.entity.js'),
  import('../src/services/order.service.js'),
  import('../src/services/order-serial.service.js'),
])
await isolation.assertTarget(AppDataSource)

/**
 * Task 6 自动化验证脚本（无需真实 MySQL）：
 * 1) 用内存仓储模拟 TypeORM 事务，验证“主子表原子提交 + 失败回滚 + 幂等防重”；
 * 2) 验证当前订单双流水规则（散客 `hyyz`、部门 `hyyzjd`）；
 * 3) 用源码静态断言验证“拼音检索 + 标签过滤 + PC键盘流 + 移动端共享抽屉”关键实现存在。
 *
 * 说明：
 * - 本脚本目标是解决 CI 或本地未启动 MySQL 时无法执行联调的问题；
 * - 一旦生产环境可连库，仍建议再跑一次真实 API 联调回归。
 */

interface OrderRecord {
  id: string
  orderUuid: string
  systemNo: string
  businessNo: string
  idempotencyKey: string
  creatorUserId: string
  submitRequestHash: string | null
  isDeleted: boolean
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

type ProductRecord = Pick<InstanceType<typeof BaseProduct>, 'id' | 'productName' | 'isActive' | 'currentStock' | 'preOrderedStock'>
type SkuRecord = Pick<InstanceType<typeof BaseProductSku>,
  'id' | 'productId' | 'skuCode' | 'specText' | 'currentStock' | 'preOrderedStock' | 'isActive' | 'isCurrent' | 'locationId'>
type InventoryLogRecord = Partial<InstanceType<typeof InventoryLog>>

/**
 * 统一断言输出，失败时抛错并让 npm script 直接退出非 0。
 */
function pass(title: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${title}`)
}

/**
 * 构建与当前 orderSerialService 兼容的最小 manager：
 * - 在内存中维护 system_configs 所需的起始值、当前值与位宽；
 * - 让 task6 脚本不连真实数据库也能覆盖当前双流水实现。
 */
function createSerialConfigState() {
  return new Map<string, string>([
    ['order.system.walkin.start', '1'],
    ['order.system.walkin.current', '0'],
    ['order.system.walkin.width', '6'],
    ['order.system.department.start', '1'],
    ['order.system.department.current', '0'],
    ['order.system.department.width', '6'],
    ['order.business.walkin.start', '1'],
    ['order.business.walkin.current', '0'],
    ['order.business.walkin.width', '6'],
    ['order.business.department.start', '1'],
    ['order.business.department.current', '0'],
    ['order.business.department.width', '6'],
    ['sequence:order.system.walkin', '0'],
    ['sequence:order.system.department', '0'],
    ['sequence:order.business.walkin', '0'],
    ['sequence:order.business.department', '0'],
  ])
}

function createSerialConfigRepository(serialConfigState: Map<string, string>) {
  return {
    async update(where: { configKey: string }, payload: { configValue: string }) {
      serialConfigState.set(where.configKey, payload.configValue)
      return { affected: 1 }
    },
    async findBy(where: Array<{ configKey: string }>) {
      return where.map(({ configKey }) => ({ configKey, configValue: serialConfigState.get(configKey) ?? '' }))
    },
  }
}

function createSequenceRepository(serialConfigState: Map<string, string>) {
  let sequenceKey = ''
  const read = () => ({
    sequenceKey,
    currentValue: Number(serialConfigState.get(`sequence:${sequenceKey}`) ?? 0),
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  return {
    createQueryBuilder() {
      return {
        where(_sql: string, params: { sequenceKey: string }) { sequenceKey = params.sequenceKey; return this },
        setLock() { return this },
        async getOne() { return serialConfigState.has(`sequence:${sequenceKey}`) ? read() : null },
      }
    },
    async save(sequence: { sequenceKey: string; currentValue: number }) {
      serialConfigState.set(`sequence:${sequence.sequenceKey}`, String(sequence.currentValue))
      return sequence
    },
    async findOneBy(where: { sequenceKey: string }) {
      sequenceKey = where.sequenceKey
      return serialConfigState.has(`sequence:${sequenceKey}`) ? read() : null
    },
    async existsBy(where: { sequenceKey: string }) {
      return serialConfigState.has(`sequence:${where.sequenceKey}`)
    },
  }
}

function createOrderSerialManager(serialConfigState: Map<string, string>) {
  return {
    connection: {
      options: {
        type: 'sqlite',
      },
    },
    async query(sql: string, params: unknown[]) {
      if (/SELECT 1 AS occupied/i.test(sql)) return []
      const keys = params.filter((item): item is string => typeof item === 'string')
      return keys.map((configKey) => ({
        configKey,
        configValue: serialConfigState.get(configKey) ?? '',
      }))
    },
    getRepository(entity: unknown) {
      if (entity === SystemConfig) {
        return createSerialConfigRepository(serialConfigState)
      }
      if (entity === BusinessSequence) {
        return createSequenceRepository(serialConfigState)
      }
      throw new Error('未处理的流水配置仓储类型')
    },
  }
}

function findOrderByWhere(
  orders: OrderRecord[],
  where: { idempotencyKey?: string; id?: string; systemNo?: string },
): OrderRecord | null {
  if (where.idempotencyKey) {
    return orders.find((item) => item.idempotencyKey === where.idempotencyKey) ?? null
  }
  if (where.id) {
    return orders.find((item) => item.id === where.id) ?? null
  }
  if (where.systemNo) {
    return orders.find((item) => item.systemNo === where.systemNo) ?? null
  }
  return null
}

function createOrderRepository(
  stagedOrders: OrderRecord[],
  stagedItems: ItemRecord[],
  getNextOrderId: () => string,
) {
  return {
    async findOne(args: { where?: { idempotencyKey?: string; id?: string; systemNo?: string } }) {
      return findOrderByWhere(stagedOrders, args.where ?? {})
    },
    create(args: Partial<OrderRecord>) {
      return { ...args } as OrderRecord
    },
    async save(args: OrderRecord) {
      const row = { ...args, id: getNextOrderId(), isDeleted: args.isDeleted ?? false }
      stagedOrders.push(row)
      return row
    },
    async find() {
      return []
    },
    createQueryBuilder(alias: string) {
      let businessNo = ''
      let orderUuid = ''
      let idempotencyKey: string | undefined
      let joinFilters: { actorId: string; isDeleted: boolean; submitRequestHash: string } | undefined
      let orderItemsByLineNo = false
      return {
        leftJoinAndSelect(relation: string, alias: string, condition: string, filters: NonNullable<typeof joinFilters>) {
          assert.equal(relation, 'outbound.items')
          assert.equal(alias, 'item')
          assert.match(condition, /outbound\.creatorUserId\s*=\s*:actorId/)
          assert.match(condition, /outbound\.isDeleted\s*=\s*:isDeleted/)
          assert.match(condition, /outbound\.submitRequestHash\s*=\s*:submitRequestHash/)
          joinFilters = filters
          return this
        },
        where(sql: string, params: { businessNo?: string; idempotencyKey?: string }) {
          if (alias === 'outbound') {
            assert.match(sql.trim(), /^outbound\.idempotencyKey\s*=\s*:idempotencyKey$/, '重放查询必须按幂等键列查找订单')
            idempotencyKey = params.idempotencyKey
          } else {
            businessNo = params.businessNo ?? ''
          }
          return this
        },
        andWhere(_sql: string, params: { orderUuid?: string }) {
          orderUuid = params.orderUuid ?? ''
          return this
        },
        setLock() { return this },
        orderBy(column: string, direction: 'ASC' | 'DESC') {
          assert.equal(column, 'item.lineNo')
          orderItemsByLineNo = direction === 'ASC'
          return this
        },
        async getOne() {
          const order = findOrderByWhere(stagedOrders, { idempotencyKey })
          if (!order) return null
          // 左连接条件只限制明细，仍返回命中幂等键的主单，由服务决定是否拒绝重放。
          const items = joinFilters && order.creatorUserId === joinFilters.actorId
            && order.isDeleted === joinFilters.isDeleted && order.submitRequestHash === joinFilters.submitRequestHash
            ? stagedItems.filter((item) => item.orderId === order.id)
            : []
          if (orderItemsByLineNo) items.sort((a, b) => a.lineNo - b.lineNo)
          return { ...order, items }
        },
        async getExists() {
          return stagedOrders.some((order) => order.businessNo === businessNo && order.orderUuid !== orderUuid)
        },
      }
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

function createProductRepository(products: ProductRecord[]) {
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
      orderBy() {
        return this
      },
      async getMany() {
        return filtered.map((product) => ({ ...product }))
      },
    }
  }

  return {
    async update({ id }: { id: string }, { currentStock }: { currentStock: number }) {
      const product = products.find((row) => row.id === id)
      assert.ok(product, '被更新的商品必须存在')
      product.currentStock = currentStock
      return { affected: 1 }
    },
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
  stagedInventoryLogs: InventoryLogRecord[],
  serialConfigState: Map<string, string>,
  products: ProductRecord[],
  skus: SkuRecord[],
  shouldFailOnItemSaveRef: { value: boolean },
  opts: {
    getNextOrderId: () => string
    getNextItemId: () => string
    getNextAuditLogId: () => string
  }
) {
  const { getNextOrderId, getNextItemId, getNextAuditLogId } = opts
  const orderSerialManager = createOrderSerialManager(serialConfigState)
  return {
    connection: orderSerialManager.connection,
    query: async (sql: string, params: unknown[]) => orderSerialManager.query(sql, params),
    getRepository: (entity: unknown) => {
      const getRepo = () => {
        if (entity === BizOutboundOrder) {
          return createOrderRepository(stagedOrders, stagedItems, getNextOrderId)
        }
        if (entity === BizOutboundOrderItem) {
          return createOrderItemRepository(stagedItems, shouldFailOnItemSaveRef, getNextItemId)
        }
        if (entity === BaseProduct) {
          return createProductRepository(products)
        }
        if (entity === BaseProductSku) {
          return {
            async update({ id }: { id: string }, { currentStock }: { currentStock: number }) {
              const sku = skus.find((row) => row.id === id)
              assert.ok(sku, '被更新的规格必须存在')
              sku.currentStock = currentStock
              return { affected: 1 }
            },
            async save(args: unknown) { return args },
            createQueryBuilder() {
              let productIds: string[] = []
              return {
                where(_sql: string, params: { productIds: string[] }) { productIds = params.productIds; return this },
                orderBy() { return this },
                addOrderBy() { return this },
                setLock() { return this },
                async getMany() {
                  return skus.filter((sku) => productIds.includes(sku.productId)).map((sku) => ({ ...sku }))
                },
              }
            },
          }
        }
        if (entity === SystemConfig) {
          return createSerialConfigRepository(serialConfigState)
        }
        if (entity === BusinessSequence) {
          return createSequenceRepository(serialConfigState)
        }
        // 本夹具没有预订单预留号或分库位库存行，保留生产查询的空结果语义。
        if (entity === O2oPreorder) {
          return {
            createQueryBuilder() {
              return { where() { return this }, async getExists() { return false } }
            },
          }
        }
        if (entity === InvSkuLocationStock) {
          return {
            createQueryBuilder() {
              return {
                where() { return this },
                orderBy() { return this },
                addOrderBy() { return this },
                async getMany() { return [] },
              }
            },
          }
        }
        if (entity === InventoryLog) {
          return {
            create(args: InventoryLogRecord) { return { ...args } },
            async save(args: InventoryLogRecord[]) {
              stagedInventoryLogs.push(...args)
              return args
            },
          }
        }
        if (entity === SysUser) {
          return {
            createQueryBuilder() {
              let userIds: string[] = []
              return {
                where(where: { id: { value: string[] } }) { userIds = where.id.value; return this },
                orderBy() { return this },
                setLock() { return this },
                async getMany() {
                  return ['9001', '9002'].filter((id) => userIds.includes(id)).map((id) => ({
                    id, username: `verifier-${id}`, displayName: '验证脚本', role: 'admin', status: 'enabled', deactivatedAt: null, restoredAt: null,
                  }))
                },
              }
            },
          }
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
  const committedInventoryLogs: InventoryLogRecord[] = []
  const committedSerialConfigState = createSerialConfigState()
  const products: ProductRecord[] = [
    { id: '1001', productName: '电缆', isActive: true, currentStock: 100, preOrderedStock: 0 },
    { id: '1002', productName: '开关', isActive: true, currentStock: 100, preOrderedStock: 0 },
  ]
  const skus: SkuRecord[] = products.map((product) => ({
    id: `sku-${product.id}`,
    productId: product.id,
    skuCode: `TASK6-${product.id}`,
    specText: '默认规格',
    currentStock: product.currentStock,
    preOrderedStock: product.preOrderedStock,
    isActive: true,
    isCurrent: true,
    locationId: null,
  }))
  const readCommittedState = () => ({
    orders: committedOrders,
    items: committedItems,
    auditLogs: committedAuditLogs,
    inventoryLogs: committedInventoryLogs,
    serialConfigs: committedSerialConfigState,
    products,
    skus,
  })
  /**
   * 构建固定的验证操作者上下文：
   * - 显式声明返回 AuthUserContext，避免编辑器在增量诊断时把对象字面量推断为不完整类型；
   * - 每次提交复用同一份结构，确保权限字段稳定存在。
   */
  const createMockActor = (): AuthUserContext => ({
    userId: '9001',
    username: 'verifier-9001',
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
  const originalQuery = AppDataSource.query.bind(AppDataSource)
  const originalIsInitialized = AppDataSource.isInitialized

  ;(AppDataSource as unknown as { isInitialized: boolean }).isInitialized = true
  ;(AppDataSource as unknown as { query: (sql: string) => Promise<unknown[]> }).query = async (sql: string) => {
    if (/journal_mode/i.test(sql)) return [{ journal_mode: 'wal' }]
    if (/PRAGMA foreign_keys$/i.test(sql.trim())) return [{ foreign_keys: 1 }]
    if (/PRAGMA busy_timeout$/i.test(sql.trim())) return [{ timeout: 5000 }]
    return []
  }

  ;(AppDataSource as unknown as { transaction: unknown }).transaction = async (
    cb: (manager: {
      query: (sql: string, params: unknown[]) => Promise<Array<Record<string, string>>>
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
    const stagedInventoryLogs = [...committedInventoryLogs]
    const stagedSerialConfigState = new Map(committedSerialConfigState)
    const stagedProducts = products.map((product) => ({ ...product }))
    const stagedSkus = skus.map((sku) => ({ ...sku }))
    const manager = createMockManager(
      stagedOrders,
      stagedItems,
      stagedAuditLogs,
      stagedInventoryLogs,
      stagedSerialConfigState,
      stagedProducts,
      stagedSkus,
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
    committedInventoryLogs.splice(0, committedInventoryLogs.length, ...stagedInventoryLogs)
    products.splice(0, products.length, ...stagedProducts)
    skus.splice(0, skus.length, ...stagedSkus)
    committedSerialConfigState.clear()
    stagedSerialConfigState.forEach((value, key) => {
      committedSerialConfigState.set(key, value)
    })
    return result
  }

  try {
    const firstInput = {
      idempotencyKey: 'task6-idem-0001',
      customerName: '客户A',
      remark: '首单',
      items: [
        { productId: '1002', qty: 1, unitPrice: 8 },
        { productId: '1001', qty: 2, unitPrice: 12.5 },
      ],
    }
    const first = await orderService.submit(firstInput, mockActor)

    assert.equal(committedOrders.length, 1)
    assert.equal(committedItems.length, 2)
    assert.equal(first.order.systemNo, 'OUT-W-000001')
    assert.equal(first.order.businessNo, 'hyyz000001')
    assert.equal(first.idempotentReplay, false)
    assert.equal(first.inventory.deductedQty, 3)
    assert.equal(committedAuditLogs.length, 1)
    assert.equal(committedInventoryLogs.length, 2)
    assert.deepEqual(products.map((product) => product.currentStock), [98, 99])
    assert.deepEqual(skus.map((sku) => sku.currentStock), [98, 99])
    pass('整单提交成功：主子表均写入且 systemNo/businessNo 独立生成首号')

    committedItems.reverse()
    const firstCommit = structuredClone(readCommittedState())
    const duplicated = await orderService.submit(firstInput, mockActor)
    assert.equal(duplicated.idempotentReplay, true)
    assert.deepEqual(duplicated.order, first.order)
    assert.deepEqual(duplicated.items, first.items, '重放明细必须按行号返回')
    assert.deepEqual(duplicated.inventory, { deductedQty: 0, lines: [] })
    assert.deepEqual(readCommittedState(), firstCommit, '重放不得再次写入订单、库存、审计或流水')

    const idempotencyConflict = { statusCode: 409, message: '订单处理中，请稍后重试' }
    await assert.rejects(orderService.submit({ ...firstInput, remark: '不同的请求内容' }, mockActor), idempotencyConflict)
    await assert.rejects(orderService.submit(firstInput, { ...mockActor, userId: '9002', username: 'verifier-9002' }), idempotencyConflict)
    committedOrders[0].isDeleted = true
    try {
      await assert.rejects(orderService.submit(firstInput, mockActor), idempotencyConflict)
    } finally {
      committedOrders[0].isDeleted = false
    }
    assert.deepEqual(readCommittedState(), firstCommit, '幂等冲突不得写入订单、库存、审计或流水')
    pass('幂等防重生效：相同请求按行号重放；不同请求、不同账号和已删除订单统一返回冲突')

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
      { message: '模拟明细写入失败' },
    )
    assert.deepEqual(readCommittedState(), firstCommit, '明细写入失败后必须回滚事务中的全部写入')
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
    assert.equal(second.order.systemNo, 'OUT-W-000002')
    assert.equal(second.order.businessNo, 'hyyz000002')
    pass('编号规则生效：散客 systemNo/businessNo 均按各自配置递增')
  } finally {
    ;(AppDataSource as unknown as { transaction: unknown }).transaction = originalTransaction
    ;(AppDataSource as unknown as { query: unknown }).query = originalQuery
    ;(AppDataSource as unknown as { isInitialized: boolean }).isInitialized = originalIsInitialized
  }
}

/**
 * 单独验证当前订单流水服务在初始配置状态下能正确生成双流水编号。
 */
async function verifyOrderSerialStartsFromConfigStart() {
  const walkinSystemNo = await orderSerialService.generateSystemNo('walkin', createOrderSerialManager(createSerialConfigState()) as never)
  const departmentSystemNo = await orderSerialService.generateSystemNo('department', createOrderSerialManager(createSerialConfigState()) as never)
  assert.equal(walkinSystemNo, 'OUT-W-000001')
  assert.equal(departmentSystemNo, 'OUT-D-000001')
  pass('订单流水服务可在初始配置下按散客/部门 systemNo 前缀生成首号')
}

/**
 * 前端/检索能力的自动化静态检查：
 * - 检索：后端产品列表支持名称+拼音 keyword，且支持 tagId 关联过滤；
 * - 多端：开单页存在 PC/移动端分支、键盘流入口、共享抽屉编辑组件。
 */
function verifySearchAndMultiDeviceByStaticChecks() {
  const productServiceFile = path.resolve(backendRoot, 'src/services/product.service.ts')
  const orderEntryFile = path.resolve(backendRoot, '../src/views/order-entry/OrderEntryView.vue')
  const orderEntryItemsEditorFile = path.resolve(backendRoot, '../src/views/order-entry/components/OrderEntryItemsEditor.vue')

  const productServiceSource = fs.readFileSync(productServiceFile, 'utf8')
  const orderEntrySource = fs.readFileSync(orderEntryFile, 'utf8')
  const orderEntryItemsEditorSource = fs.readFileSync(orderEntryItemsEditorFile, 'utf8')

  assert.match(productServiceSource, /p\.product_name LIKE :keyword ESCAPE '!'\s+OR\s+p\.pinyin_abbr LIKE :keyword ESCAPE '!'/)
  assert.match(productServiceSource, /innerJoin\('rel_product_tag'/)
  pass('检索能力存在：后端已实现拼音模糊检索与标签过滤 SQL 条件')

  assert.match(orderEntrySource, /OrderEntryItemsEditor/)
  assert.match(orderEntrySource, /handleGridKeydown/)
  assert.match(orderEntryItemsEditorSource, /v-else-if="isDesktop"/)
  assert.match(orderEntryItemsEditorSource, /v-else class="space-y-3"/)
  assert.match(orderEntryItemsEditorSource, /<BizResponsiveDrawerShell/)
  pass('多端交互能力存在：PC 键盘流与移动端共享抽屉编辑分支齐全')
}

async function main() {
  await verifyOrderSerialStartsFromConfigStart()
  await verifyOrderTransactionAndNumbering()
  verifySearchAndMultiDeviceByStaticChecks()
  assert.equal(AppDataSource.isInitialized, false, 'Task6 不得初始化真实数据连接')
  assert.equal(fs.existsSync(path.join(isolation.rootDir, 'unused.sqlite')), false, 'Task6 不得创建真实 SQLite 文件')
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
