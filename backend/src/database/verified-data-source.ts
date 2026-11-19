/**
 * 最小TypeORM初始化边界：构造时不读SQLite文件；initialize连接文件前先验内存引擎。
 * 不修改第三方原型/全局构造器，保留原DataSource类型与初始化、事务、销毁生命周期。
 */
import { DataSource } from 'typeorm'
import { ensureVerifiedSqliteDriver } from './verified-sqlite-driver.js'

export class VerifiedDataSource extends DataSource {
  override async initialize(): Promise<this> {
    if (this.options.type === 'sqlite') {
      // 当前固定TypeORM的SqliteDriver将实际模块保存在sqlite，含options.driver自定义模块。
      // 不能另require默认包代验其它实际驱动。
      const actualDriver = (this.driver as unknown as { sqlite: unknown }).sqlite
      await ensureVerifiedSqliteDriver(actualDriver)
    }
    return super.initialize()
  }
}
