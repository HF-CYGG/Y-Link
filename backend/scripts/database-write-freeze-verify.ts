/**
 * 模块说明：backend/scripts/database-write-freeze-verify.ts
 * 文件职责：验证数据库写入冻结的 operation identity、TypeORM 全入口门禁与排空语义。
 * 实现逻辑：
 * - 用隔离内存 SQLite 验证 Repository、QueryBuilder、raw SQL、QueryRunner 与事务入口；
 * - 用独立 gate 验证冻结等待完整 Promise、失效 ALS 上下文、治理闭包和超时；
 * - 以 serializeWrites=false 模拟 MySQL 连接池路径，确认 gate 不会把并发写串行化。
 * 维护说明：脚本只使用内存数据库，不读取 DB_*，不得改成连接业务库或生产数据库。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DataSource, EntitySchema } from 'typeorm'
import type { NextFunction, Request, Response } from 'express'
import {
  DatabaseOperationGate,
  DatabaseWriteFrozenError,
  databaseOperationGate,
} from '../src/database/operation-gate.js'
import {
  installTransactionCoordinator,
  runDatabaseExclusive,
} from '../src/database/transaction-coordinator.js'
import { DatabaseMaintenanceModeService } from '../src/services/database-maintenance-mode.service.js'
import { databaseMaintenanceWriteBarrier } from '../src/middleware/database-maintenance.middleware.js'
import { asyncHandler } from '../src/utils/async-handler.js'

interface FreezeProbe {
  id: number
  label: string
}

const FreezeProbeEntity = new EntitySchema<FreezeProbe>({
  name: 'FreezeProbe',
  tableName: 'database_write_freeze_probe',
  columns: {
    id: { type: Number, primary: true },
    label: { type: String },
  },
})

const delay = (durationMs: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, durationMs)
})

const createDeferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const pass = (message: string) => console.log(`✅ ${message}`)

const assertFrozen = async (operation: () => Promise<unknown>, message: string) => {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof DatabaseWriteFrozenError, message)
    assert.equal(error.statusCode, 503, message)
    return true
  })
}

const createDataSource = async (gate: DatabaseOperationGate, serializeWrites: boolean) => {
  const dataSource = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [FreezeProbeEntity],
    synchronize: true,
    logging: false,
  })
  await dataSource.initialize()
  installTransactionCoordinator(dataSource, {
    serializeWrites,
    maxPendingWrites: 8,
    writeQueueTimeoutMs: 1_000,
    operationGate: gate,
  })
  return dataSource
}

const verifyAcceptedPromiseSurvivesFreeze = async () => {
  const gate = new DatabaseOperationGate()
  const operationStarted = createDeferred()
  const allowLateWrite = createDeferred()
  let lateWriteCompleted = false
  let staleWrite: (() => Promise<void>) | undefined

  const acceptedOperation = gate.runOperation(async () => {
    staleWrite = () => gate.runWrite(async () => undefined)
    operationStarted.resolve()
    await allowLateWrite.promise
    await gate.runWrite(async () => {
      lateWriteCompleted = true
    })
  })

  await operationStarted.promise
  const freeze = gate.freeze({ excludeCurrentOperation: false })
  let drained = false
  const drainPromise = freeze.drain(500).then(() => {
    drained = true
  })

  await delay(20)
  assert.equal(drained, false, 'freeze 必须等待已准入操作的完整 Promise')
  allowLateWrite.resolve()
  await acceptedOperation
  await drainPromise
  assert.equal(lateWriteCompleted, true, '冻结前已准入操作应允许在冻结后完成晚到写入')
  await assertFrozen(() => staleWrite!(), '已结束 operation 的 ALS 上下文不得在冻结后继续写入')
  freeze.release()
  pass('freeze 等待完整 Promise，已准入晚写可完成，失效 ALS 上下文被拒绝')
}

const verifyDisconnectedHandlerPromiseIsDrained = async () => {
  const handlerStarted = createDeferred()
  const allowLateWrite = createDeferred()
  const handlerFinished = createDeferred()
  let lateWriteCompleted = false
  let forwardedError: unknown

  const request = {
    method: 'POST',
    originalUrl: '/api/write-freeze-probe',
    path: '/api/write-freeze-probe',
  } as Request
  const responseEmitter = new EventEmitter()
  const response = Object.assign(responseEmitter, {
    setHeader: () => response,
    status: () => response,
    json: () => response,
  }) as unknown as Response
  const wrappedHandler = asyncHandler(async () => {
    handlerStarted.resolve()
    try {
      await allowLateWrite.promise
      await databaseOperationGate.runWrite(async () => {
        lateWriteCompleted = true
      })
    } finally {
      handlerFinished.resolve()
    }
  })

  databaseMaintenanceWriteBarrier(request, response, (() => {
    wrappedHandler(request, response, ((error?: unknown) => {
      forwardedError = error
    }) as NextFunction)
  }) as NextFunction)
  await handlerStarted.promise
  responseEmitter.emit('close')

  const freeze = databaseOperationGate.freeze({ excludeCurrentOperation: false })
  let drained = false
  const drainPromise = freeze.drain(500).then(() => {
    drained = true
  })
  await delay(20)
  assert.equal(drained, false, '客户端断线不得提前释放仍在执行的 async handler 租约')
  allowLateWrite.resolve()
  await handlerFinished.promise
  await drainPromise
  assert.equal(forwardedError, undefined, '断线后的已准入 handler 晚写不应被 gate 误拒绝')
  assert.equal(lateWriteCompleted, true, '断线后的已准入 handler 应允许完成晚写')
  freeze.release()
  pass('响应 close 后 async handler 的完整 Promise 仍持有 operation 租约')
}

const verifyTypeOrmWriteEntrypoints = async () => {
  const gate = new DatabaseOperationGate()
  const dataSource = await createDataSource(gate, true)
  try {
    await gate.runOperation(() => dataSource.getRepository(FreezeProbeEntity).insert({ id: 1, label: 'seed' }))
    const freeze = gate.freeze({ excludeCurrentOperation: false })
    await freeze.drain(500)

    const rows = await dataSource.getRepository(FreezeProbeEntity).find()
    assert.equal(rows.length, 1, '冻结期间数据库读取必须保持可用')

    await assertFrozen(
      () => dataSource.getRepository(FreezeProbeEntity).insert({ id: 2, label: 'repository' }),
      'Repository 写入必须经过 gate',
    )
    await assertFrozen(
      () => dataSource.createQueryBuilder().insert().into(FreezeProbeEntity).values({ id: 3, label: 'qb' }).execute(),
      'QueryBuilder 写入必须经过 gate',
    )
    await assertFrozen(
      () => dataSource.query('INSERT INTO database_write_freeze_probe (id, label) VALUES (?, ?)', [4, 'raw']),
      'raw SQL 写入必须经过 gate',
    )

    const queryRunner = dataSource.createQueryRunner()
    try {
      await assertFrozen(
        () => queryRunner.query('INSERT INTO database_write_freeze_probe (id, label) VALUES (?, ?)', [5, 'runner']),
        'QueryRunner 写入必须经过 gate',
      )
      await assertFrozen(
        () => queryRunner.startTransaction(),
        'QueryRunner 显式事务必须在 startTransaction 时取得 operation 租约',
      )
    } finally {
      await queryRunner.release().catch(() => undefined)
    }

    await assertFrozen(
      () => dataSource.transaction((manager) => manager.insert(FreezeProbeEntity, { id: 6, label: 'transaction' })),
      'DataSource.transaction 必须在事务回调前取得 operation 租约',
    )

    await freeze.runGovernance(() => dataSource.query(
      'INSERT INTO database_write_freeze_probe (id, label) VALUES (?, ?)',
      [7, 'governance'],
    ))
    const governedRows = await dataSource.query(
      'SELECT id FROM database_write_freeze_probe WHERE id = ?',
      [7],
    ) as Array<{ id: number }>
    assert.equal(governedRows.length, 1, '冻结治理 callback 应具备瞬时窄写能力')

    let escapedGovernanceWrite: (() => Promise<unknown>) | undefined
    await freeze.runGovernance(async () => {
      escapedGovernanceWrite = () => dataSource.query(
        'INSERT INTO database_write_freeze_probe (id, label) VALUES (?, ?)',
        [8, 'escaped-governance'],
      )
    })
    await assertFrozen(
      () => escapedGovernanceWrite!(),
      '治理 callback 结束后继承其 ALS 的 detached 写不得继续使用治理能力',
    )

    let escapedGovernanceRunner: ReturnType<DataSource['createQueryRunner']> | undefined
    await assert.rejects(
      () => freeze.runGovernance(async () => {
        escapedGovernanceRunner = dataSource.createQueryRunner()
        await escapedGovernanceRunner.startTransaction()
      }),
      /治理 callback 结束时仍有 1 个显式事务未结束/,
      '治理 callback 不得携带活动 QueryRunner 事务逃逸',
    )
    await escapedGovernanceRunner?.release()
    freeze.release()
  } finally {
    await dataSource.destroy()
  }
  pass('冻结期间 TypeORM 全写入口拒绝、读取可用且治理闭包不可逃逸')
}

const verifyExplicitTransactionDrains = async () => {
  const gate = new DatabaseOperationGate()
  const dataSource = await createDataSource(gate, true)
  const queryRunner = dataSource.createQueryRunner()
  try {
    await queryRunner.startTransaction()
    await queryRunner.query(
      'INSERT INTO database_write_freeze_probe (id, label) VALUES (?, ?)',
      [20, 'active transaction'],
    )
    const freeze = gate.freeze({ excludeCurrentOperation: false })
    let drained = false
    const drainPromise = freeze.drain(500).then(() => {
      drained = true
    })
    await delay(20)
    assert.equal(drained, false, '显式事务提交前 freeze 不得结束排空')
    await queryRunner.commitTransaction()
    await drainPromise
    assert.equal(drained, true, '显式事务提交后 freeze 应完成排空')
    freeze.release()
  } finally {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction().catch(() => undefined)
    }
    await queryRunner.release().catch(() => undefined)
    await dataSource.destroy()
  }
  pass('QueryRunner 显式事务持有独立 operation 租约直到提交')
}

const verifyAcceptedMysqlQueryRunnerBuilderSurvivesFreeze = async () => {
  const gate = new DatabaseOperationGate()
  const dataSource = await createDataSource(gate, false)
  const queryRunner = dataSource.createQueryRunner()
  try {
    await queryRunner.startTransaction()
    const freeze = gate.freeze({ excludeCurrentOperation: false })
    const drainPromise = freeze.drain(500)
    await queryRunner.manager
      .createQueryBuilder()
      .insert()
      .into(FreezeProbeEntity)
      .values({ id: 25, label: 'accepted mysql query runner builder' })
      .execute()
    await queryRunner.manager
      .getRepository(FreezeProbeEntity)
      .insert({ id: 26, label: 'accepted mysql query runner repository' })
    await queryRunner.commitTransaction()
    await drainPromise
    freeze.release()
  } finally {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction().catch(() => undefined)
    }
    await queryRunner.release().catch(() => undefined)
    await dataSource.destroy()
  }
  pass('MySQL QueryRunner 事务的 QueryBuilder 晚写复用已准入 operation 租约')
}

const verifyMysqlPathStaysConcurrent = async () => {
  const gate = new DatabaseOperationGate()
  const dataSource = await createDataSource(gate, false)
  const firstEntered = createDeferred()
  const secondEntered = createDeferred()
  const releaseBoth = createDeferred()
  try {
    const first = runDatabaseExclusive(dataSource, async () => {
      firstEntered.resolve()
      await releaseBoth.promise
    })
    const second = runDatabaseExclusive(dataSource, async () => {
      secondEntered.resolve()
      await releaseBoth.promise
    })
    await Promise.race([
      Promise.all([firstEntered.promise, secondEntered.promise]),
      delay(100).then(() => assert.fail('serializeWrites=false 路径不应把两个操作串行化')),
    ])
    releaseBoth.resolve()
    await Promise.all([first, second])

    const freeze = gate.freeze({ excludeCurrentOperation: false })
    await freeze.drain(200)
    await assertFrozen(
      () => dataSource.getRepository(FreezeProbeEntity).insert({ id: 30, label: 'mysql-path' }),
      'serializeWrites=false 的 MySQL 路径也必须执行统一写准入检查',
    )
    assert.deepEqual(
      await dataSource.getRepository(FreezeProbeEntity).find(),
      [],
      'MySQL 路径冻结期间仍应允许读取',
    )
    freeze.release()
  } finally {
    await dataSource.destroy()
  }
  pass('MySQL 模式保留连接池并发，不因 operation gate 退化为单写串行')
}

const verifyDrainTimeout = async () => {
  const gate = new DatabaseOperationGate()
  const releaseOperation = createDeferred()
  const running = gate.runOperation(() => releaseOperation.promise)
  const freeze = gate.freeze({ excludeCurrentOperation: false })
  await assert.rejects(
    () => freeze.drain(20),
    /等待数据库操作排空超时/,
  )
  releaseOperation.resolve()
  await running
  await freeze.drain(200)
  freeze.release()
  pass('排空超时会失败，未完成操作不被误判为已排空')
}

const verifyWorkerPauseDrainResume = async () => {
  const gate = new DatabaseOperationGate()
  const allowWorkerDrain = createDeferred()
  let pauseCount = 0
  let resumeCount = 0
  gate.registerWorker({
    name: 'verify-worker',
    pause: () => {
      pauseCount += 1
    },
    drain: () => allowWorkerDrain.promise,
    resume: () => {
      resumeCount += 1
    },
  })

  const freeze = gate.freeze({ excludeCurrentOperation: false })
  assert.equal(pauseCount, 1, 'freeze 必须同步暂停 worker 接新任务')
  let drained = false
  const drainPromise = freeze.drain(500).then(() => {
    drained = true
  })
  await delay(20)
  assert.equal(drained, false, 'freeze 必须等待 worker drain 完成')
  allowWorkerDrain.resolve()
  await drainPromise
  freeze.release()
  assert.equal(resumeCount, 1, '显式解除维护后应恢复此前注册的 worker')
  pass('worker 会在关闭准入后同步暂停，并纳入 drain 与显式恢复')
}

const verifyShutdownDrainsGovernance = async () => {
  const gate = new DatabaseOperationGate()
  const freeze = gate.freeze({ excludeCurrentOperation: false })
  const governanceStarted = createDeferred()
  const allowGovernanceFinish = createDeferred()
  let lateGovernanceWriteCompleted = false
  const governance = freeze.runGovernance(async () => {
    governanceStarted.resolve()
    await allowGovernanceFinish.promise
    await gate.runWrite(async () => {
      lateGovernanceWriteCompleted = true
    })
  })
  await governanceStarted.promise

  let shutdownFinished = false
  const shutdown = gate.shutdownAndDrain(500, false).then(() => {
    shutdownFinished = true
  })
  await delay(20)
  assert.equal(shutdownFinished, false, 'shutdown 必须等待已准入治理 callback 的完整 Promise')
  allowGovernanceFinish.resolve()
  await governance
  await shutdown
  assert.equal(lateGovernanceWriteCompleted, true, 'shutdown 后已准入治理 callback 仍应完成晚写')
  await assertFrozen(
    () => gate.runWrite(async () => undefined),
    'shutdown 完成后不得重新开放普通写准入',
  )
  pass('shutdown 会停止新准入并等待治理 callback，且不会隐式恢复 gate')
}

const verifyMaintenanceControlLifecycle = async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-write-freeze-'))
  try {
    const stateFilePath = path.join(tempDirectory, 'maintenance-state.json')
    const gate = new DatabaseOperationGate()
    const service = new DatabaseMaintenanceModeService({
      stateFilePath,
      drainTimeoutMs: 200,
      operationGate: gate,
    })

    await gate.runOperation(() => service.beginReadOnly({ taskId: 'task-a', phase: 'snapshot' }))
    assert.equal(service.isReadOnly(), true, 'beginReadOnly 后必须持有冻结，不能在 callback 结束时自动恢复')
    assert.equal(gate.snapshot().mode, 'frozen', '维护状态应与 operation gate 冻结保持一致')
    await assert.rejects(
      () => service.runGovernance('task-b', async () => undefined),
      /任务与当前只读维护锁不匹配/,
    )
    await service.finishReadOnly('task-b')
    assert.equal(gate.snapshot().mode, 'frozen', '不匹配 taskId 的 finishReadOnly 不得解除冻结')
    assert.equal(fs.existsSync(stateFilePath), true, '不匹配 taskId 的 finishReadOnly 不得删除 marker')
    let governed = false
    await service.runGovernance('task-a', async () => {
      const nestedLease = service.registerInFlightWrite()
      assert.ok(nestedLease, '治理 callback 内的旧短租约 API 应复用治理 identity')
      nestedLease()
      governed = true
    })
    assert.equal(governed, true, '匹配 taskId 的治理 callback 应可运行')
    await service.finishReadOnly('task-a')
    assert.equal(gate.snapshot().mode, 'open', 'finishReadOnly 成功删除 marker 后才可恢复准入')
    assert.equal(fs.existsSync(stateFilePath), false, 'finishReadOnly 应删除持久维护 marker')

    const timeoutStateFilePath = path.join(tempDirectory, 'timeout-maintenance-state.json')
    const timeoutGate = new DatabaseOperationGate()
    const timeoutService = new DatabaseMaintenanceModeService({
      stateFilePath: timeoutStateFilePath,
      drainTimeoutMs: 20,
      operationGate: timeoutGate,
    })
    const releaseBusyOperation = createDeferred()
    const busyOperation = timeoutGate.runOperation(() => releaseBusyOperation.promise)
    const keepProcessAlive = globalThis.setTimeout(() => undefined, 100)
    try {
      await assert.rejects(
        () => timeoutService.beginReadOnly({ taskId: 'timeout-task', phase: 'snapshot' }),
        /等待数据库操作排空超时/,
      )
    } finally {
      globalThis.clearTimeout(keepProcessAlive)
    }
    assert.equal(timeoutService.isReadOnly(), false, '排空超时必须回滚新建维护状态')
    assert.equal(timeoutGate.snapshot().mode, 'open', '排空超时回滚后应恢复原有准入状态')
    assert.equal(fs.existsSync(timeoutStateFilePath), false, '排空超时不得保留新建 marker')
    releaseBusyOperation.resolve()
    await busyOperation

    fs.writeFileSync(stateFilePath, '{broken json', 'utf8')
    const corruptedGate = new DatabaseOperationGate()
    const corruptedService = new DatabaseMaintenanceModeService({
      stateFilePath,
      operationGate: corruptedGate,
    })
    assert.equal(corruptedService.isReadOnly(), true, '损坏的维护 marker 必须 fail closed')
    assert.equal(corruptedGate.snapshot().mode, 'frozen', '损坏 marker 启动时必须同步冻结 DB gate')
    await assertFrozen(
      () => corruptedGate.runWrite(async () => undefined),
      '损坏 marker 不得被当作不存在并放行写入',
    )

    const shutdownStateFilePath = path.join(tempDirectory, 'shutdown-maintenance-state.json')
    const shutdownGate = new DatabaseOperationGate()
    const shutdownService = new DatabaseMaintenanceModeService({
      stateFilePath: shutdownStateFilePath,
      operationGate: shutdownGate,
    })
    await shutdownService.beginReadOnly({ taskId: 'shutdown-task', phase: 'restart_pending' })
    await shutdownService.shutdownAndDrain()
    assert.equal(shutdownGate.snapshot().mode, 'shutdown', 'shutdown 必须永久关闭本进程的新准入')
    assert.equal(fs.existsSync(shutdownStateFilePath), true, 'shutdown 不得删除或覆盖维护 marker')
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true })
  }
  pass('维护 marker 持有显式冻结生命周期，taskId 治理能力窄化且损坏时 fail closed')
}

const main = async () => {
  await verifyAcceptedPromiseSurvivesFreeze()
  await verifyDisconnectedHandlerPromiseIsDrained()
  await verifyTypeOrmWriteEntrypoints()
  await verifyExplicitTransactionDrains()
  await verifyAcceptedMysqlQueryRunnerBuilderSurvivesFreeze()
  await verifyMysqlPathStaysConcurrent()
  await verifyDrainTimeout()
  await verifyWorkerPauseDrainResume()
  await verifyShutdownDrainsGovernance()
  await verifyMaintenanceControlLifecycle()
  console.log('数据库写入冻结专项回归通过')
}

main().catch((error) => {
  console.error('数据库写入冻结专项回归失败：', error)
  process.exitCode = 1
})
