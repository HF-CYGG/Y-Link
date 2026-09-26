/**
 * 模块说明：Issue #110 业务号历史占用表清退自动备份专项验证。
 * 文件职责：验证 SQLite 正式 bootstrap 在 056 语义清退旧表前，会先生成可校验的双表 JSON 备份。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const verifyRoot = path.resolve(process.cwd(), 'data', 'local-dev', `order-business-no-retirement-backup-${verifySeed}`)
const sqlitePath = path.join(verifyRoot, 'verify.sqlite')

process.env.APP_PROFILE = `order-business-no-retirement-backup-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = verifyRoot

async function main() {
  fs.mkdirSync(verifyRoot, { recursive: true })
  const [
    { AppDataSource },
    { initializeDatabaseSchemaIfNeeded },
    { appDataPaths },
    {
      backupOrderBusinessNoRetirementTables,
      calculateOrderBusinessNoRetirementPayloadSha256,
      compareRetirementBackupCodeUnits,
      encodeRetirementBackupValue,
      parseAndVerifyOrderBusinessNoRetirementBundle,
    },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/config/app-data-paths.js'),
    import('../src/config/order-business-no-retirement-backup.js'),
  ])

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await AppDataSource.query(`CREATE TABLE "order_business_no_occupancy" (
      "id" integer PRIMARY KEY AUTOINCREMENT,
      "business_namespace" varchar(16) NOT NULL,
      "serial_value" integer NOT NULL,
      "business_no" varchar(32) NOT NULL,
      "order_uuid" varchar(36) NOT NULL,
      "created_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await AppDataSource.query(`CREATE TABLE "order_business_no_reuse_event" (
      "id" integer PRIMARY KEY AUTOINCREMENT,
      "business_no" varchar(32) NOT NULL,
      "reason" varchar(500),
      "created_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await AppDataSource.query(
      `INSERT INTO "order_business_no_occupancy"
       ("business_namespace", "serial_value", "business_no", "order_uuid")
       VALUES ('hyyzjd', 29, 'hyyzjd000029', '00000000-0000-4000-8000-000000000029')`,
    )
    await AppDataSource.query(
      `INSERT INTO "order_business_no_reuse_event" ("business_no", "reason")
       VALUES ('hyyzjd000029', '历史复用原因')`,
    )

    await initializeDatabaseSchemaIfNeeded(AppDataSource)

    const backupNames = fs.existsSync(appDataPaths.migrationBackupDir)
      ? fs.readdirSync(appDataPaths.migrationBackupDir).filter((name) => name.endsWith('.json'))
      : []
    assert.equal(backupNames.length, 1, '056 清退前必须生成一个双表 JSON 备份')
    const firstBackupPath = path.join(appDataPaths.migrationBackupDir, backupNames[0]!)
    const firstBackupRaw = fs.readFileSync(firstBackupPath, 'utf8')
    const raw = parseAndVerifyOrderBusinessNoRetirementBundle(firstBackupRaw)
    assert.equal(raw.dialect, 'sqlite')
    assert.equal(raw.migration, '056_disable_order_business_no_permanent_occupancy.sql')
    assert.equal(typeof raw.payloadSha256, 'string')
    assert.deepEqual(raw.tables?.map((table) => table.name), [
      'order_business_no_occupancy',
      'order_business_no_reuse_event',
    ])
    for (const table of raw.tables ?? []) {
      assert.match(String(table.createSql), /^CREATE TABLE/i)
      assert.equal(table.rowCount, 1)
      assert.equal(table.rows?.length, 1)
    }
    assert.equal(
      JSON.stringify(raw).includes('hyyzjd000029'),
      true,
      '备份必须保留表内原始敏感字段，且只能存于受限备份文件',
    )
    const corrupted = JSON.parse(firstBackupRaw) as Record<string, unknown>
    corrupted.createdAt = '2026-09-22T00:00:00.000Z'
    assert.throws(
      () => parseAndVerifyOrderBusinessNoRetirementBundle(JSON.stringify(corrupted)),
      /SHA-256 校验失败/,
      'payload 意外损坏必须被 checksum 拒绝',
    )
    assert.deepEqual(encodeRetirementBackupValue(9007199254740993n), {
      $ylinkType: 'bigint',
      value: '9007199254740993',
    })
    assert.deepEqual(encodeRetirementBackupValue(new Date('2026-09-22T00:00:00.000Z')), {
      $ylinkType: 'date',
      value: '2026-09-22T00:00:00.000Z',
    })
    assert.deepEqual(encodeRetirementBackupValue(Buffer.from([0, 1, 255])), {
      $ylinkType: 'buffer',
      encoding: 'base64',
      value: 'AAH/',
    })
    assert.deepEqual(encodeRetirementBackupValue(new Uint8Array([0, 1, 255])), {
      $ylinkType: 'buffer',
      encoding: 'base64',
      value: 'AAH/',
    })
    assert.equal(compareRetirementBackupCodeUnits('z', 'ä') < 0, true, '排序必须按代码单元而不是 ICU locale')

    const refreshChecksum = (bundle: typeof raw) => {
      const { payloadSha256: _ignored, ...payload } = bundle
      bundle.payloadSha256 = calculateOrderBusinessNoRetirementPayloadSha256(payload)
      return bundle
    }
    const wrongTableSql = structuredClone(raw)
    wrongTableSql.tables[0]!.createSql = 'CREATE TABLE "wrong_table" ("id" integer)'
    assert.throws(
      () => parseAndVerifyOrderBusinessNoRetirementBundle(JSON.stringify(refreshChecksum(wrongTableSql))),
      /CREATE SQL.*表名|CREATE SQL.*不合法/,
    )
    const appendedSql = structuredClone(raw)
    appendedSql.tables[0]!.createSql += '; DROP TABLE "biz_outbound_order"'
    assert.throws(
      () => parseAndVerifyOrderBusinessNoRetirementBundle(JSON.stringify(refreshChecksum(appendedSql))),
      /CREATE SQL.*单条|CREATE SQL.*不合法/,
    )
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(appDataPaths.migrationBackupDir).mode & 0o777, 0o700)
      assert.equal(fs.statSync(firstBackupPath).mode & 0o777, 0o600)
    }

    // 仅一张空表存在时也必须保留 schema；清退完成后再次启动不得新增空备份。
    await AppDataSource.query(`CREATE TABLE "order_business_no_reuse_event" (
      "id" integer PRIMARY KEY AUTOINCREMENT,
      "business_no" varchar(32) NOT NULL
    )`)
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const partialBackupNames = fs.readdirSync(appDataPaths.migrationBackupDir).filter((name) => name.endsWith('.json'))
    assert.equal(partialBackupNames.length, 2)
    const partialBackupName = partialBackupNames.find((name) => name !== backupNames[0])
    assert.ok(partialBackupName)
    const partialBundle = parseAndVerifyOrderBusinessNoRetirementBundle(
      fs.readFileSync(path.join(appDataPaths.migrationBackupDir, partialBackupName), 'utf8'),
    )
    assert.deepEqual(partialBundle.tables.map((table) => ({ name: table.name, rowCount: table.rowCount })), [
      { name: 'order_business_no_reuse_event', rowCount: 0 },
    ])
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    assert.equal(
      fs.readdirSync(appDataPaths.migrationBackupDir).filter((name) => name.endsWith('.json')).length,
      2,
      '两表均不存在时不得生成备份',
    )

    // 发布后的 chmod、finalPath 回读和目录 fsync 任一步失败，都必须先清理/隔离正式文件且不能改变数据库；
    // 若清理与隔离同时失败，则必须返回可检索且不泄露绝对路径的人工处置标记。
    await AppDataSource.query(`CREATE TABLE "order_business_no_occupancy" (
      "id" integer PRIMARY KEY AUTOINCREMENT,
      "business_no" varchar(32) NOT NULL
    )`)
    await AppDataSource.query(`CREATE TABLE "order_business_no_reuse_event" (
      "id" integer PRIMARY KEY AUTOINCREMENT,
      "business_no" varchar(32) NOT NULL
    )`)
    await AppDataSource.query(`
      CREATE TRIGGER "trg_order_business_no_reuse_event_no_update"
      BEFORE UPDATE ON "order_business_no_reuse_event"
      BEGIN SELECT RAISE(ABORT, 'VERIFY_APPEND_ONLY'); END
    `)
    await AppDataSource.query(`
      CREATE TRIGGER "trg_order_business_no_reuse_event_no_delete"
      BEFORE DELETE ON "order_business_no_reuse_event"
      BEGIN SELECT RAISE(ABORT, 'VERIFY_APPEND_ONLY'); END
    `)

    const assertDatabaseUntouched = async (label: string) => {
      const tableRows = await AppDataSource.query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('order_business_no_occupancy', 'order_business_no_reuse_event')
         ORDER BY name`,
      ) as Array<{ name: string }>
      assert.deepEqual(tableRows.map((row) => row.name), [
        'order_business_no_occupancy',
        'order_business_no_reuse_event',
      ], `${label}不得删除旧表`)
      const triggerRows = await AppDataSource.query(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name IN (
           'trg_order_business_no_reuse_event_no_update',
           'trg_order_business_no_reuse_event_no_delete'
         ) ORDER BY name`,
      ) as Array<{ name: string }>
      assert.equal(triggerRows.length, 2, `${label}不得删除旧触发器`)
    }

    const chmodFailureDir = path.join(verifyRoot, 'chmod-failure')
    await assert.rejects(() => backupOrderBusinessNoRetirementTables({
      dialect: 'sqlite',
      query: AppDataSource.query.bind(AppDataSource),
      backupDir: chmodFailureDir,
      fileSystem: {
        ...fsPromises,
        chmod: async (target, mode) => {
          if (String(target).endsWith('.json')) {
            const error = new Error('injected chmod failure') as NodeJS.ErrnoException
            error.code = 'EIO'
            throw error
          }
          await fsPromises.chmod(target, mode)
        },
      },
    }))
    await assertDatabaseUntouched('final chmod 失败')
    assert.deepEqual(fs.readdirSync(chmodFailureDir).filter((name) => name.endsWith('.json')), [])

    const finalReadFailureDir = path.join(verifyRoot, 'final-read-failure')
    let readCount = 0
    await assert.rejects(() => backupOrderBusinessNoRetirementTables({
      dialect: 'sqlite',
      query: AppDataSource.query.bind(AppDataSource),
      backupDir: finalReadFailureDir,
      fileSystem: {
        ...fsPromises,
        readFile: (async (...args: Parameters<typeof fsPromises.readFile>) => {
          readCount += 1
          if (readCount === 2) return '{}'
          return fsPromises.readFile(...args)
        }) as typeof fsPromises.readFile,
      },
    }))
    await assertDatabaseUntouched('finalPath 回读失败')
    assert.deepEqual(fs.readdirSync(finalReadFailureDir).filter((name) => name.endsWith('.json')), [])

    const directorySyncFailureDir = path.join(verifyRoot, 'directory-sync-failure')
    await assert.rejects(() => backupOrderBusinessNoRetirementTables({
      dialect: 'sqlite',
      query: AppDataSource.query.bind(AppDataSource),
      backupDir: directorySyncFailureDir,
      fileSystem: {
        ...fsPromises,
        open: (async (target: Parameters<typeof fsPromises.open>[0], flags: Parameters<typeof fsPromises.open>[1], mode?: number) => {
          if (path.resolve(String(target)) === path.resolve(directorySyncFailureDir) && flags === 'r') {
            return {
              sync: async () => {
                const error = new Error('injected directory fsync failure') as NodeJS.ErrnoException
                error.code = 'EIO'
                throw error
              },
              close: async () => undefined,
            } as Awaited<ReturnType<typeof fsPromises.open>>
          }
          return fsPromises.open(target, flags, mode)
        }) as typeof fsPromises.open,
      },
    }))
    await assertDatabaseUntouched('目录 fsync 失败')
    assert.deepEqual(fs.readdirSync(directorySyncFailureDir).filter((name) => name.endsWith('.json')), [])

    const cleanupDoubleFailureDir = path.join(verifyRoot, 'cleanup-double-failure')
    await assert.rejects(
      () => backupOrderBusinessNoRetirementTables({
        dialect: 'sqlite',
        query: AppDataSource.query.bind(AppDataSource),
        backupDir: cleanupDoubleFailureDir,
        fileSystem: {
          ...fsPromises,
          chmod: async (target, mode) => {
            if (String(target).endsWith('.json')) {
              const error = new Error('injected chmod failure') as NodeJS.ErrnoException
              error.code = 'EIO'
              throw error
            }
            await fsPromises.chmod(target, mode)
          },
          rm: async (target, options) => {
            if (String(target).endsWith('.json')) {
              const error = new Error('injected final rm failure') as NodeJS.ErrnoException
              error.code = 'EBUSY'
              throw error
            }
            await fsPromises.rm(target, options)
          },
          rename: async (oldPath, newPath) => {
            if (String(oldPath).endsWith('.json')) {
              const error = new Error('injected quarantine rename failure') as NodeJS.ErrnoException
              error.code = 'EACCES'
              throw error
            }
            await fsPromises.rename(oldPath, newPath)
          },
        },
      }),
      (error: unknown) => {
        const message = String(error)
        assert.match(message, /YLINK_RETIREMENT_BACKUP_CLEANUP_REQUIRED/)
        assert.match(message, /removeCode=EBUSY/)
        assert.match(message, /quarantineCode=EACCES/)
        assert.equal(message.includes(cleanupDoubleFailureDir), false, '人工处置错误不得泄露备份绝对路径')
        return true
      },
    )
    await assertDatabaseUntouched('正式文件清理/隔离双失败')
    assert.equal(
      fs.readdirSync(cleanupDoubleFailureDir).filter((name) => name.endsWith('.json')).length,
      1,
      '正式文件无法清理或隔离时必须保留并通过人工处置标记明确指认',
    )

    const renameCollisionDir = path.join(verifyRoot, 'rename-collision')
    fs.mkdirSync(renameCollisionDir, { recursive: true })
    const collisionTimestamp = new Date('2026-09-23T00:00:00.000Z')
    const collisionId = 'fixed-collision-id'
    const collisionFileName = 'order-business-no-retirement-056-sqlite-2026-09-23T00-00-00-000Z-fixed-collision-id.json'
    const collisionFinalPath = path.join(renameCollisionDir, collisionFileName)
    fs.writeFileSync(collisionFinalPath, 'existing-valid-backup', 'utf8')
    await assert.rejects(() => backupOrderBusinessNoRetirementTables({
      dialect: 'sqlite',
      query: AppDataSource.query.bind(AppDataSource),
      backupDir: renameCollisionDir,
      now: () => collisionTimestamp,
      createId: () => collisionId,
    }))
    assert.equal(
      fs.readFileSync(collisionFinalPath, 'utf8'),
      'existing-valid-backup',
      '真实文件系统同名冲突时不得覆盖并非本次发布创建的正式文件',
    )
    assert.deepEqual(
      fs.readdirSync(renameCollisionDir).filter((name) => name.endsWith('.tmp')),
      [],
      '真实文件系统同名冲突时仍须清理本次临时文件',
    )

    // 正式 bootstrap 无法创建备份目录时必须失败，并且不得先 DROP 表。
    fs.rmSync(appDataPaths.migrationBackupDir, { recursive: true, force: true })
    fs.writeFileSync(appDataPaths.migrationBackupDir, 'blocked', 'utf8')
    await assert.rejects(
      () => initializeDatabaseSchemaIfNeeded(AppDataSource),
      (error: unknown) => {
        assert.equal(
          String(error).includes(appDataPaths.migrationBackupDir),
          false,
          '启动错误不得泄露迁移备份目录的完整绝对路径',
        )
        return true
      },
    )
    assert.equal(
      (await AppDataSource.query(
        `SELECT COUNT(1) AS "total" FROM sqlite_master
         WHERE type = 'table' AND name = 'order_business_no_occupancy'`,
      ) as Array<{ total: number }>)[0]?.total,
      1,
      '备份写入失败时 056 不得 DROP 旧表',
    )
    console.log('✅ 业务号历史占用表清退自动备份专项验证通过')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    fs.rmSync(verifyRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('❌ 业务号历史占用表清退自动备份专项验证失败', error)
  process.exitCode = 1
})
