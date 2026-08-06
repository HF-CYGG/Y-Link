/**
 * 模块说明：backend/src/database/transaction-coordinator.ts
 * 文件职责：提供数据库无关的事务上下文复用，以及 SQLite 单写者的有界串行协调。
 * 实现逻辑：
 * - AsyncLocalStorage 记录当前事务 manager，嵌套 `DataSource.transaction` 复用同一 manager；
 * - SQLite 的显式事务、Repository/QueryBuilder/SQL 读写共用一把有界连接锁；
 * - 队列满或等待超时返回可重试的 503，防止高峰期形成无界 Promise/内存堆积。
 * 维护说明：业务层仍应优先显式透传 manager；这里的自动委派是兼容旧调用的安全兜底，不替代清晰的事务边界。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { DataSource, EntityManager } from 'typeorm'
import { DatabaseOverloadedError } from './database-errors.js'

type TransactionHandler = (manager: EntityManager) => Promise<unknown>
type IsolationLevel = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
type ReleaseLease = () => void

interface TransactionExecutionContext {
  dataSource: DataSource
  manager?: EntityManager
  ownsWriteLease: boolean
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

class BoundedSerialWriteQueue {
  private active = false
  private readonly pending: QueueEntry[] = []
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
    try {
      return await transactionContextStorage.run(
        {
          dataSource: this.dataSource,
          manager: activeContext?.dataSource === this.dataSource ? activeContext.manager : undefined,
          ownsWriteLease: true,
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
        const wrappedHandler: TransactionHandler = async (manager) => {
          return transactionContextStorage.run(
            {
              dataSource,
              manager,
              ownsWriteLease: this.options.serializeWrites,
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
        return this.runExclusive(async () => originalTerminal.apply(value, args))
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
