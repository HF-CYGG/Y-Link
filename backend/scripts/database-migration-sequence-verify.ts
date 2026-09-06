/** 自增状态不能只检查 MAX(id)：删除过的高位 ID 也不能在迁移后重新使用。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DataSource } from 'typeorm'

const database = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-migration-sequence-')), 'fixture.sqlite')
const source = new DataSource({ type: 'sqlite', database, entities: [] })
await source.initialize()
try {
  await source.query('CREATE TABLE fixture (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)')
  await source.query("INSERT INTO fixture(id, value) VALUES (1, '保留'), (9007199254740993, '删除的历史高位')")
  await source.query('DELETE FROM fixture WHERE id > 1')
  const { readSqliteGeneratedNextId } = await import('../src/utils/migration-autoincrement.js')
  assert.equal(await readSqliteGeneratedNextId(source, 'fixture', 'id'), 9007199254740994n)
  console.log('[migration-sequence] 删除高位 ID 及超过 Number 精度的自增状态通过')
} finally {
  await source.destroy()
}
