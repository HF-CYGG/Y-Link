/** 真实隔离SQLite查询验证LIKE字面量，不连接AppDataSource或业务库。 */
import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { buildSqlLikeContains, buildSqlLikePrefix } from '../src/utils/sql-like.js'
const db = new sqlite3.Database(':memory:')
const run = (sql: string, params: unknown[] = []) => new Promise<void>((resolve,reject) => db.run(sql,params,(error) => error ? reject(error) : resolve()))
const all = (sql: string, params: unknown[]) => new Promise<{ value: string }[]>((resolve,reject) => db.all(sql,params,(error,rows) => error ? reject(error) : resolve(rows as {value:string}[])))
try {
  await run('CREATE TABLE sample(value TEXT NOT NULL)')
  const values=['a%b','a_b','a!b','a\\b','axb','aXXb','prefix%end','prefix_end','prefix!end','prefix\\end','xxa%bxx']
  assert.equal(values[3], 'a' + String.fromCharCode(92) + 'b')
  assert.equal(values[9], 'prefix' + String.fromCharCode(92) + 'end')
  for(const value of values) await run('INSERT INTO sample(value) VALUES (?)',[value])
  for(const needle of ['%','_','!','\\']) {
    const contains=await all("SELECT value FROM sample WHERE value LIKE ? ESCAPE '!' ORDER BY value",[buildSqlLikeContains(needle)])
    assert.deepEqual(contains.map(row=>row.value),values.filter(value=>value.includes(needle)).sort(),`SQLite contains字面量 ${needle}`)
    const prefix='prefix'+needle
    const prefixed=await all("SELECT value FROM sample WHERE value LIKE ? ESCAPE '!' ORDER BY value",[buildSqlLikePrefix(prefix)])
    assert.deepEqual(prefixed.map(row=>row.value),values.filter(value=>value.startsWith(prefix)).sort(),`SQLite prefix字面量 ${needle}`)
  }
  // 与盘点调用方同形的多列OR，避免只证明单一表达式。
  const rows=await all("SELECT value FROM sample WHERE (value LIKE ? ESCAPE '!' OR value LIKE ? ESCAPE '!') ORDER BY value",[buildSqlLikeContains('a%b'),buildSqlLikeContains('a_b')])
  assert.deepEqual(rows.map(row=>row.value),['a%b','a_b','xxa%bxx'].sort())
  console.log('通过：真实SQLite :memory: LIKE contains/prefix/OR 的百分号、下划线、感叹号与反斜杠字面量；未验证MySQL')
} finally { await new Promise<void>((resolve,reject)=>db.close(error=>error?reject(error):resolve())) }
