/** 发布回归专用worker：保留父进程配置隔离，实际目标核对后才执行正式建表命令。 */
import { assertInheritedVerificationTarget } from './verification-isolation.js'

const { AppDataSource } = await import('../src/config/data-source.js')
await assertInheritedVerificationTarget(AppDataSource)
await import('../src/commands/prepare-mysql-migration-schema.js')
