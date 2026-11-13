/** 真实 MySQL 1MiB 包长边界：执行生产迁移方法，确认估算/官方转义/拒绝及回滚。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import {createRequire} from 'node:module'
import {DataSource,EntitySchema,type EntityMetadata} from 'typeorm'
import {readOwnedMysqlContext} from './owned-mysql-fixture.mjs'
const config=readOwnedMysqlContext()
assert.ok(process.env.Y_LINK_DATA_DIR)
const require=createRequire(import.meta.url)
const mysql=require('mysql2') as typeof import('mysql2')
const originalFormat=mysql.format
let formatCalls=0
mysql.format=((...args:Parameters<typeof originalFormat>)=>{formatCalls++;return originalFormat(...args)}) as typeof originalFormat
const fixture=new EntitySchema({name:'PacketFixture',tableName:'packet_fixture',columns:{id:{type:Number,primary:true},payload:{type:'text'}}})
const source=new DataSource({type:'sqlite',database:path.join(process.env.Y_LINK_DATA_DIR!,'packet-source.sqlite'),entities:[fixture],synchronize:true})
// mysql2连接使用user，TypeORM的公开配置字段为username，不能直接展开前者的连接参数。
const target=new DataSource({type:'mysql',host:config.host,port:config.port,username:config.user,password:config.password,database:config.database,entities:[],synchronize:false,charset:'utf8mb4'})
try{
 await source.initialize();await target.initialize()
 await target.query('CREATE TABLE packet_fixture (id INTEGER PRIMARY KEY, payload LONGTEXT NOT NULL) CHARACTER SET utf8mb4')
 const rows=await target.query('SELECT @@max_allowed_packet AS packet');assert.equal(Number(rows[0].packet),1048576)
 const {DatabaseMigrationService}=await import('../src/services/database-migration.service.js')
 const service=new DatabaseMigrationService() as unknown as {migrateSingleTableByPrimaryKey(source:DataSource,target:DataSource,metadata:EntityMetadata):Promise<{rowCount:number}>}
 const migrate=()=>service.migrateSingleTableByPrimaryKey(source,target,source.getMetadata('PacketFixture'))
 const plain='a'.repeat(600_000)
 await source.getRepository('PacketFixture').save({id:1,payload:plain})
 assert.equal((await migrate()).rowCount,1);assert.ok(formatCalls>0,'高估包长分支必须实际调用官方format')
 assert.equal((await target.query('SELECT payload FROM packet_fixture WHERE id=1'))[0].payload,plain,'估算超限但实际可发的文本不得误拒')
 const before=formatCalls
 await source.getRepository('PacketFixture').save({id:1,payload:"'".repeat(600_000)})
 await assert.rejects(migrate(),/max_allowed_packet/)
 assert.ok(formatCalls>before,'实际超限必须经官方格式化判断')
 assert.equal((await target.query('SELECT payload FROM packet_fixture WHERE id=1'))[0].payload,plain,'拒绝路径必须保留既有目标数据')
 await source.getRepository('PacketFixture').delete({id:1})
 const escaped="中文\\'😀".repeat(20_000)
 await source.getRepository('PacketFixture').save({id:2,payload:escaped})
 assert.equal((await migrate()).rowCount,1)
 assert.equal((await target.query('SELECT payload FROM packet_fixture WHERE id=2'))[0].payload,escaped,'真实SQL驱动必须保留多字节、反斜杠与引号')
 console.log('[mysql-packet] 官方format、估算高估、真实超限、回滚和转义大字段通过')
}finally{mysql.format=originalFormat;if(target.isInitialized)await target.destroy();if(source.isInitialized)await source.destroy()}
