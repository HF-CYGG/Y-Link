/**
 * 模块说明：backend/src/database/transaction-coordinator.ts
 * 文件职责：提供数据库无关的事务上下文复用，以及 SQLite 单写者的有界串行协调。
 * 实现逻辑：
 * - AsyncLocalStorage 记录当前事务 manager，嵌套 `DataSource.transaction` 复用同一 manager；
 * - SQLite 的显式事务、QueryRunner、Repository/QueryBuilder/SQL 读写共用一把有界连接锁；
 * - QueryRunner 在 start/commit/rollback/release 生命周期内持有同一租约，原始事务控制 SQL 被运行时拒绝；
 * - 队列满或等待超时返回可重试的 503，防止高峰期形成无界 Promise/内存堆积。
 * 维护说明：业务层仍应优先显式透传 manager；这里的自动委派是兼容旧调用的安全兜底，不替代清晰的事务边界。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { DataSource, EntityManager, QueryRunner } from 'typeorm'
import { DatabaseOverloadedError } from './database-errors.js'

type TransactionHandler = (manager: EntityManager) => Promise<unknown>
type IsolationLevel = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
type ReleaseLease = () => void

interface TransactionExecutionContext {
  dataSource: DataSource
  manager?: EntityManager
  ownsWriteLease: boolean
  writeLeaseToken?: symbol
}

interface QueryRunnerLeaseState {
  release?: ReleaseLease
  borrowedLeaseToken?: symbol
  allowedTransactionControlDepth: number
}

interface QueueEntry {
  enqueuedAt: number
  resolve: (release: ReleaseLease) => void
  reject: (error: Error) => void
  timeout?: NodeJS.Timeout
}

export interface TransactionCoordinatorOptions {
  serializeWrites: boolean
  maxPendingWrites: number
  writeQueueTimeoutMs: number
}

export interface TransactionCoordinatorSnapshot {
  serializeWrites: boolean
  activeWrites: number
  pendingWrites: number
  maxObservedPendingWrites: number
  completedWrites: number
  rejectedWrites: number
  timedOutWrites: number
  averageWaitMs: number
}

const transactionContextStorage = new AsyncLocalStorage<TransactionExecutionContext>()
const coordinators = new WeakMap<DataSource, TransactionCoordinator>()

const WRITE_MANAGER_METHODS = new Set([
  'save',
  'remove',
  'softRemove',
  'recover',
  'insert',
  'update',
  'updateAll',
  'upsert',
  'delete',
  'deleteAll',
  'softDelete',
  'restore',
  'clear',
  'increment',
  'decrement',
])

const DELEGATED_MANAGER_METHODS = [
  'getRepository',
  'getTreeRepository',
  'getMongoRepository',
  'createQueryBuilder',
  'query',
  'preload',
  'exists',
  'existsBy',
  'count',
  'countBy',
  'sum',
  'average',
  'minimum',
  'maximum',
  'find',
  'findBy',
  'findAndCount',
  'findAndCountBy',
  'findByIds',
  'findOne',
  'findOneBy',
  'findOneById',
  'findOneOrFail',
  'findOneByOrFail',
  ...WRITE_MANAGER_METHODS,
] as const

const QUERY_BUILDER_TRANSFORM_METHODS = [
  'clone',
  'subQuery',
  'insert',
  'update',
  'delete',
  'softDelete',
  'restore',
] as const

const QUERY_BUILDER_TERMINAL_METHODS = [
  'execute',
  'getRawMany',
  'getRawOne',
  'getRawAndEntities',
  'getMany',
  'getOne',
  'getOneOrFail',
  'getManyAndCount',
  'getCount',
  'getExists',
] as const

const SYNCHRONOUS_MANAGER_FACTORY_METHODS = new Set([
  'getRepository',
  'getTreeRepository',
  'getMongoRepository',
  'createQueryBuilder',
])

/**
 * 原始事务控制 SQL 无法在 DataSource.query 的多次调用之间可靠识别所有者：
 * BEGIN 返回后，调用方的 await 延续不会继承协调器内部创建的 AsyncLocalStorage 上下文。
 * 因此不能靠“遇到 BEGIN 后一直持锁”猜测后续 COMMIT 属于谁，只能要求使用具备对象身份的
 * DataSource.transaction 或 QueryRunner 生命周期 API。
 */
const TRANSACTION_CONTROL_SQL_PATTERN =
  /^(?:(?:\s+)|(?:;\s*)|(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/))*(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|END(?:\s+TRANSACTION)?\b|ROLLBACK\b|SAVEPOINT\b|RELEASE(?:\s+SAVEPOINT)?\b|SET\s+TRANSACTION\b)/i

const isTransactionControlSql = (query: string): boolean => {
  return TRANSACTION_CONTROL_SQL_PATTERN.test(query)
}

class BoundedSerialWriteQueue {
  private active = false
  private readonly pending: QueueEntry[] = []
  private readonly idleWaiters: Array<() => void> = []
  private completedWrites = 0
  private rejectedWrites = 0
  private timedOutWrites = 0
  private totalWaitMs = 0
  private maxObservedPendingWrites = 0

  constructor(
    private readonly maxPendingWrites: number,
    private readonly writeQueueTimeoutMs: number,
  ) {}

  async acquire(): Promise<ReleaseLease> {
    if (!this.active) {
      this.active = true
      return this.createReleaseLease()
    }

    if (this.pending.length >= this.maxPendingWrites) {
      this.rejectedWrites += 1
      throw new DatabaseOverloadedError('SQLite 写入队列已满，请稍后重试', 'queue_full')
    }

    return new Promise<ReleaseLease>((resolve, reject) => {
      const entry: QueueEntry = {
        enqueuedAt: performance.now(),
        resolve,
        reject,
      }
      entry.timeout = setTimeout(() => {
        const entryIndex = this.pending.indexOf(entry)
        if (entryIndex < 0) {
          return
        }
        this.pending.splice(entryIndex, 1)
        this.timedOutWrites += 1
        entry.reject(new DatabaseOverloadedError('等待 SQLite 写入超时，请稍后重试', 'queue_timeout'))
      }, this.writeQueueTimeoutMs)
      this.pending.push(entry)
      this.maxObservedPendingWrites = Math.max(this.maxObservedPendingWrites, this.pending.length)
    })
  }

  snapshot(): Omit<TransactionCoordinatorSnapshot, 'serializeWrites'> {
    return {
      activeWrites: this.active ? 1 : 0,
      pendingWrites: this.pending.length,
      maxObservedPendingWrites: this.maxObservedPendingWrites,
      completedWrites: this.completedWrites,
      rejectedWrites: this.rejectedWrites,
      timedOutWrites: this.timedOutWrites,
      averageWaitMs: this.completedWrites > 0
        ? Number((this.totalWaitMs / this.completedWrites).toFixed(2))
        : 0,
    }
  }

  async waitForIdle(): Promise<void> {
    if (!this.active && this.pending.length === 0) {
      return
    }
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  private createReleaseLease(waitMs = 0): ReleaseLease {
    let released = false
    this.totalWaitMs += waitMs
    return () => {
      if (released) {
        return
      }
      released = true
      this.completedWrites += 1
      this.activateNext()
    }
  }

  private activateNext(): void {
    const next = this.pending.shift()
    if (!next) {
      this.active = false
      this.idleWaiters.splice(0).forEach((resolve) => resolve())
      return
    }
    if (next.timeout) {
      clearTimeout(next.timeout)
    }
    const waitMs = Math.max(0, performance.now() - next.enqueuedAt)
    next.resolve(this.createReleaseLease(waitMs))
  }
}

export class TransactionCoordinator {
  private readonly writeQueue: BoundedSerialWriteQueue
  private installed = false
  private readonly wrappedQueryBuilders = new WeakSet<object>()
  private readonly wrappedQueryRunners = new WeakSet<object>()
  private readonly queryRunnerLeaseStates = new WeakMap<object, QueryRunnerLeaseState>()

  constructor(
    readonly dataSource: DataSource,
    readonly options: TransactionCoordinatorOptions,
  ) {
    this.writeQueue = new BoundedSerialWriteQueue(
      options.maxPendingWrites,
      options.writeQueueTimeoutMs,
    )
  }

  install(): void {
    if (this.installed) {
      return
    }
    this.patchDataSourceTransaction()
    this.patchDataSourceCreateQueryRunner()
    this.patchDataSourceQuery()
    this.patchDataSourceQueryBuilder()
    this.patchGlobalEntityManager()
    this.installed = true
  }

  getCurrentManager(): EntityManager | undefined {
    const context = transactionContextStorage.getStore()
    return context?.dataSource === this.dataSource ? context.manager : undefined
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    if (!this.options.serializeWrites) {
      return work()
    }
    const activeContext = transactionContextStorage.getStore()
    if (activeContext?.dataSource === this.dataSource && activeContext.ownsWriteLease) {
      return work()
    }

    const release = await this.writeQueue.acquire()
    const writeLeaseToken = Symbol('transaction-coordinator-write-lease')
    try {
      return await transactionContextStorage.run(
        {
          dataSource: this.dataSource,
          manager: activeContext?.dataSource === this.dataSource ? activeContext.manager : undefined,
          ownsWriteLease: true,
          writeLeaseToken,
        },
        work,
      )
    } finally {
      release()
    }
  }

  snapshot(): TransactionCoordinatorSnapshot {
    if (!this.options.serializeWrites) {
      return {
        serializeWrites: false,
        activeWrites: 0,
        pendingWrites: 0,
        maxObservedPendingWrites: 0,
        completedWrites: 0,
        rejectedWrites: 0,
        timedOutWrites: 0,
        averageWaitMs: 0,
      }
    }
    return {
      serializeWrites: true,
      ...this.writeQueue.snapshot(),
    }
  }

  async waitForIdle(): Promise<void> {
    if (!this.options.serializeWrites) {
      return
    }
    await this.writeQueue.waitForIdle()
  }

  private patchDataSourceTransaction(): void {
    const dataSource = this.dataSource
    const originalTransaction = dataSource.transaction.bind(dataSource) as (
      isolationOrHandler: IsolationLevel | TransactionHandler,
      maybeHandler?: TransactionHandler,
    ) => Promise<unknown>

    dataSource.transaction = (async (
      isolationOrHandler: IsolationLevel | TransactionHandler,
      maybeHandler?: TransactionHandler,
    ): Promise<unknown> => {
      const handler = typeof isolationOrHandler === 'function'
        ? isolationOrHandler
        : maybeHandler
      if (!handler) {
        throw new Error('事务回调缺失')
      }

      const activeContext = transactionContextStorage.getStore()
      if (activeContext?.dataSource === dataSource && activeContext.manager) {
        return handler(activeContext.manager)
      }

      return this.runExclusive(async () => {
        const writeLeaseContext = transactionContextStorage.getStore()
        const wrappedHandler: TransactionHandler = async (manager) => {
          return transactionContextStorage.run(
            {
              dataSource,
              manager,
              ownsWriteLease: Boolean(
                writeLeaseContext?.dataSource === dataSource
                && writeLeaseContext.ownsWriteLease,
              ),
              writeLeaseToken: writeLeaseContext?.dataSource === dataSource
                ? writeLeaseContext.writeLeaseToken
                : undefined,
            },
            () => handler(manager),
          )
        }
        return typeof isolationOrHandler === 'function'
          ? originalTransaction(wrappedHandler)
          : originalTransaction(isolationOrHandler, wrappedHandler)
      })
    }) as DataSource['transaction']
  }

  private createQueryRunnerFacade(queryRunner: QueryRunner): QueryRunner {
    // TypeORM sqlite 驱动会让每次 createQueryRunner() 返回同一个实例。若直接在该实例上
    // 记录租约，两个并发调用方会被误判成同一 QueryRunner 的嵌套事务。这里为每次调用
    // 创建一个轻量逻辑门面：底层仍复用唯一 SQLite 连接，但事务深度、manager、广播器和
    // 协调器租约均按调用方对象隔离，再由有界队列保证同一时刻只有一个门面进入事务。
    const facade = Object.create(Object.getPrototypeOf(queryRunner)) as QueryRunner
    const source = queryRunner as unknown as Record<string, unknown>
    const target = facade as unknown as Record<string, unknown>
    Object.assign(target, source, {
      isReleased: false,
      isTransactionActive: false,
      data: {},
      loadedTables: [],
      loadedViews: [],
      sqlMemoryMode: false,
      transactionDepth: 0,
      transactionPromise: null,
      cachedTablePaths: {},
    })

    const sqlInMemory = source.sqlInMemory
    if (sqlInMemory && typeof sqlInMemory === 'object') {
      const SqlInMemoryConstructor = (sqlInMemory as { constructor: new () => unknown }).constructor
      target.sqlInMemory = new SqlInMemoryConstructor()
    }

    const broadcaster = source.broadcaster
    if (broadcaster && typeof broadcaster === 'object') {
      const BroadcasterConstructor = (
        broadcaster as { constructor: new (owner: QueryRunner) => unknown }
      ).constructor
      target.broadcaster = new BroadcasterConstructor(facade)
    }

    target.manager = this.dataSource.createEntityManager(facade)
    return facade
  }

  private patchDataSourceCreateQueryRunner(): void {
    const dataSource = this.dataSource
    const originalCreateQueryRunner = dataSource.createQueryRunner.bind(dataSource) as DataSource['createQueryRunner']
    dataSource.createQueryRunner = ((
      ...args: Parameters<DataSource['createQueryRunner']>
    ): QueryRunner => {
      const queryRunner = originalCreateQueryRunner(...args)
      return this.options.serializeWrites
        ? this.wrapQueryRunner(this.createQueryRunnerFacade(queryRunner))
        : queryRunner
    }) as DataSource['createQueryRunner']
  }

  private async acquireQueryRunnerLease(state: QueryRunnerLeaseState): Promise<void> {
    if (state.release || state.borrowedLeaseToken) {
      return
    }

    const activeContext = transactionContextStorage.getStore()
    if (
      activeContext?.dataSource === this.dataSource
      && activeContext.ownsWriteLease
    ) {
      if (!activeContext.writeLeaseToken) {
        throw new Error('当前 SQLite 写租约缺少所有者标识，无法安全借给 QueryRunner')
      }
      state.borrowedLeaseToken = activeContext.writeLeaseToken
      return
    }

    state.release = await this.writeQueue.acquire()
  }

  private releaseQueryRunnerLease(state: QueryRunnerLeaseState): void {
    const release = state.release
    state.release = undefined
    state.borrowedLeaseToken = undefined
    release?.()
  }

  private assertQueryRunnerLeaseAccess(state: QueryRunnerLeaseState): void {
    if (!state.borrowedLeaseToken) {
      return
    }

    const activeContext = transactionContextStorage.getStore()
    if (
      activeContext?.dataSource !== this.dataSource
      || activeContext.writeLeaseToken !== state.borrowedLeaseToken
    ) {
      throw new Error(
        'QueryRunner 事务已逃逸其所属的 SQLite 写租约上下文；'
        + '请在同一个 transaction/runDatabaseExclusive 回调内完成提交、回滚或 release',
      )
    }
  }

  private async allowQueryRunnerTransactionControl<T>(
    state: QueryRunnerLeaseState,
    work: () => Promise<T>,
  ): Promise<T> {
    state.allowedTransactionControlDepth += 1
    try {
      return await work()
    } finally {
      state.allowedTransactionControlDepth -= 1
    }
  }

  private wrapQueryRunner(queryRunner: QueryRunner): QueryRunner {
    if (!this.options.serializeWrites || this.wrappedQueryRunners.has(queryRunner)) {
      return queryRunner
    }

    this.wrappedQueryRunners.add(queryRunner)
    const state: QueryRunnerLeaseState = {
      allowedTransactionControlDepth: 0,
    }
    this.queryRunnerLeaseStates.set(queryRunner, state)

    const originalStartTransaction = queryRunner.startTransaction.bind(queryRunner)
    const originalCommitTransaction = queryRunner.commitTransaction.bind(queryRunner)
    const originalRollbackTransaction = queryRunner.rollbackTransaction.bind(queryRunner)
    const originalRelease = queryRunner.release.bind(queryRunner)
    const originalQuery = queryRunner.query.bind(queryRunner) as (
      query: string,
      parameters?: unknown[],
      useStructuredResult?: boolean,
    ) => Promise<unknown>

    queryRunner.startTransaction = async (isolationLevel?: IsolationLevel): Promise<void> => {
      const isRootTransaction = !state.release && !state.borrowedLeaseToken
      if (isRootTransaction) {
        await this.acquireQueryRunnerLease(state)
      } else {
        this.assertQueryRunnerLeaseAccess(state)
      }

      try {
        await this.allowQueryRunnerTransactionControl(
          state,
          () => originalStartTransaction(isolationLevel),
        )
      } catch (error) {
        // BeforeTransactionStart 或参数校验失败时数据库尚未进入事务，可立即归还租约。
        // 若 BEGIN 已成功而后续广播失败，QueryRunner 仍处于活动态，保留租约并交给
        // rollback/release 清理，不能为了避免队列卡住而让其它请求进入未结束事务。
        if (isRootTransaction && !queryRunner.isTransactionActive) {
          this.releaseQueryRunnerLease(state)
        }
        throw error
      }
    }

    queryRunner.commitTransaction = async (): Promise<void> => {
      this.assertQueryRunnerLeaseAccess(state)
      try {
        await this.allowQueryRunnerTransactionControl(state, originalCommitTransaction)
      } finally {
        if (!queryRunner.isTransactionActive) {
          this.releaseQueryRunnerLease(state)
        }
      }
    }

    queryRunner.rollbackTransaction = async (): Promise<void> => {
      this.assertQueryRunnerLeaseAccess(state)
      try {
        await this.allowQueryRunnerTransactionControl(state, originalRollbackTransaction)
      } finally {
        if (!queryRunner.isTransactionActive) {
          this.releaseQueryRunnerLease(state)
        }
      }
    }

    queryRunner.release = async (): Promise<void> => {
      let rollbackError: unknown
      if (queryRunner.isTransactionActive && (state.release || state.borrowedLeaseToken)) {
        try {
          // release 是最后的异常清理边界。即使借入租约的回调已经逃逸，也必须优先
          // 在同一 QueryRunner 上回滚，而不是把仍有活动事务的连接交还给后续请求。
          await this.allowQueryRunnerTransactionControl(state, originalRollbackTransaction)
        } catch (error) {
          rollbackError = error
        }
        if (queryRunner.isTransactionActive) {
          throw new Error(
            'QueryRunner.release 无法回滚仍在活动的 SQLite 事务，写租约已保留以阻止数据交错',
            { cause: rollbackError },
          )
        }
      }

      try {
        await originalRelease()
      } finally {
        if (!queryRunner.isTransactionActive) {
          this.releaseQueryRunnerLease(state)
        }
      }

      if (rollbackError) {
        throw rollbackError
      }
    }

    queryRunner.query = (async (
      query: string,
      parameters?: unknown[],
      useStructuredResult?: boolean,
    ): Promise<unknown> => {
      if (
        state.allowedTransactionControlDepth === 0
        && isTransactionControlSql(query)
      ) {
        throw new Error(
          '禁止通过 QueryRunner.query 直接控制事务边界；'
          + '请使用 startTransaction/commitTransaction/rollbackTransaction，以便协调器跨语句持有写租约',
        )
      }

      const execute = () => originalQuery(query, parameters, useStructuredResult)
      if (state.release) {
        return execute()
      }
      if (state.borrowedLeaseToken) {
        // 生命周期方法内部会临时放行 TypeORM 自己发出的 BEGIN/COMMIT/ROLLBACK，
        // 普通调用则必须仍处在借出租约的同一异步上下文中。
        if (state.allowedTransactionControlDepth === 0) {
          this.assertQueryRunnerLeaseAccess(state)
        }
        return execute()
      }
      return this.runExclusive(execute)
    }) as QueryRunner['query']

    return queryRunner
  }

  private patchDataSourceQuery(): void {
    const dataSource = this.dataSource
    const originalQuery = dataSource.query.bind(dataSource) as (
      query: string,
      parameters?: unknown[],
      queryRunner?: unknown,
    ) => Promise<unknown>
    dataSource.query = (async (
      query: string,
      parameters?: unknown[],
      queryRunner?: unknown,
    ): Promise<unknown> => {
      if (this.options.serializeWrites && isTransactionControlSql(query)) {
        throw new Error(
          '禁止通过 DataSource.query 直接控制事务边界；'
          + '请使用 DataSource.transaction，或使用由 createQueryRunner 创建的 QueryRunner 生命周期 API',
        )
      }
      const activeContext = transactionContextStorage.getStore()
      if (
        !queryRunner
        && activeContext?.dataSource === dataSource
        && activeContext.manager
      ) {
        // MySQL 下全局 DataSource.query 会另取池连接；事务回调里若误用它，
        // 将看不到未提交写入并逃逸当前事务。统一委派给当前 manager，
        // 与 Repository/QueryBuilder 的兼容兜底保持同一隔离边界。
        return activeContext.manager.query(query, parameters)
      }
      if (queryRunner) {
        // EntityManager.query 会把自身 QueryRunner 作为第三参回传给 DataSource.query。
        // 该 QueryRunner 已按对象身份持有整段事务租约，不能再按单条语句入队，否则会等待自己而死锁。
        return originalQuery(
          query,
          parameters,
          this.wrapQueryRunner(queryRunner as QueryRunner),
        )
      }
      const execute = () => originalQuery(query, parameters, queryRunner)
      // TypeORM sqlite 驱动在一个 DataSource 内复用单 QueryRunner/连接。
      // 若只排队写语句，另一请求的全局 SELECT 可能在活动事务中交错，
      // 从而看到未提交数据。因此 SQLite 单连接模式下读写都经过同一有界协调器。
      return this.options.serializeWrites
        ? this.runExclusive(execute)
        : execute()
    }) as DataSource['query']
  }

  private patchDataSourceQueryBuilder(): void {
    const dataSource = this.dataSource
    const originalCreateQueryBuilder = dataSource.createQueryBuilder.bind(dataSource) as (
      ...args: unknown[]
    ) => unknown
    dataSource.createQueryBuilder = ((...args: unknown[]): unknown => {
      const activeContext = transactionContextStorage.getStore()
      if (activeContext?.dataSource === dataSource && activeContext.manager) {
        // EntityManager.createQueryBuilder 本身会回调 DataSource.createQueryBuilder。
        // 不能在这里再次调用 manager.createQueryBuilder，否则会无限递归；应直接把
        // 当前事务 QueryRunner 注入原始 DataSource 工厂。
        const transactionQueryRunner = activeContext.manager.queryRunner
        if (transactionQueryRunner) {
          const transactionArgs = [...args]
          if (transactionArgs.length >= 2 && transactionArgs[1]) {
            transactionArgs[2] = transactionQueryRunner
          } else {
            transactionArgs[0] = transactionQueryRunner
          }
          return this.wrapQueryBuilder(originalCreateQueryBuilder(...transactionArgs))
        }
      }
      return this.wrapQueryBuilder(originalCreateQueryBuilder(...args))
    }) as DataSource['createQueryBuilder']
  }

  private patchGlobalEntityManager(): void {
    const managerRecord = this.dataSource.manager as unknown as Record<string, unknown>
    for (const methodName of DELEGATED_MANAGER_METHODS) {
      const originalMethod = managerRecord[methodName]
      if (typeof originalMethod !== 'function') {
        continue
      }
      managerRecord[methodName] = (...args: unknown[]) => {
        const activeContext = transactionContextStorage.getStore()
        if (
          activeContext?.dataSource === this.dataSource
          && activeContext.manager
          && activeContext.manager !== this.dataSource.manager
        ) {
          const transactionManagerRecord = activeContext.manager as unknown as Record<string, unknown>
          const transactionMethod = transactionManagerRecord[methodName]
          if (typeof transactionMethod === 'function') {
            return transactionMethod.apply(activeContext.manager, args)
          }
        }

        const execute = () => {
          const result = originalMethod.apply(this.dataSource.manager, args)
          return methodName === 'createQueryBuilder'
            ? this.wrapQueryBuilder(result)
            : result
        }

        if (!this.options.serializeWrites) {
          return execute()
        }
        if (!SYNCHRONOUS_MANAGER_FACTORY_METHODS.has(methodName)) {
          return this.runExclusive(async () => execute())
        }
        return execute()
      }
    }
  }

  private wrapQueryBuilder(value: unknown): unknown {
    if (!this.options.serializeWrites || !value || typeof value !== 'object') {
      return value
    }
    if (this.wrappedQueryBuilders.has(value)) {
      return value
    }
    this.wrappedQueryBuilders.add(value)
    const queryBuilder = value as Record<string, unknown>

    for (const methodName of QUERY_BUILDER_TERMINAL_METHODS) {
      const originalTerminal = queryBuilder[methodName]
      if (typeof originalTerminal !== 'function') {
        continue
      }
      queryBuilder[methodName] = (...args: unknown[]) => {
        const execute = async () => originalTerminal.apply(value, args)
        // QueryRunner.manager.createQueryBuilder 会把已持有事务租约的 QueryRunner 注入 builder。
        // 若这里再按 terminal 单独排队，builder 会等待自己的长事务租约而死锁。
        const queryRunner = queryBuilder.queryRunner
        if (queryRunner && typeof queryRunner === 'object') {
          const state = this.queryRunnerLeaseStates.get(queryRunner)
          if (state?.release) {
            return execute()
          }
          if (state?.borrowedLeaseToken) {
            this.assertQueryRunnerLeaseAccess(state)
            return execute()
          }
        }
        return this.runExclusive(execute)
      }
    }

    for (const methodName of QUERY_BUILDER_TRANSFORM_METHODS) {
      const originalTransform = queryBuilder[methodName]
      if (typeof originalTransform !== 'function') {
        continue
      }
      queryBuilder[methodName] = (...args: unknown[]) => {
        return this.wrapQueryBuilder(originalTransform.apply(value, args))
      }
    }
    return value
  }
}

export function installTransactionCoordinator(
  dataSource: DataSource,
  options: TransactionCoordinatorOptions,
): TransactionCoordinator {
  const installed = coordinators.get(dataSource)
  if (installed) {
    return installed
  }
  const coordinator = new TransactionCoordinator(dataSource, options)
  coordinator.install()
  coordinators.set(dataSource, coordinator)
  return coordinator
}

export function getTransactionCoordinator(dataSource: DataSource): TransactionCoordinator | undefined {
  return coordinators.get(dataSource)
}

export function getCurrentTransactionManager(dataSource: DataSource): EntityManager | undefined {
  return coordinators.get(dataSource)?.getCurrentManager()
}

export async function runDatabaseExclusive<T>(
  dataSource: DataSource,
  work: () => Promise<T>,
): Promise<T> {
  const coordinator = coordinators.get(dataSource)
  return coordinator ? coordinator.runExclusive(work) : work()
}
