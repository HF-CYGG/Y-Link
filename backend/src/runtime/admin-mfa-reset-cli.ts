/**
 * 文件说明：管理端两步验证命令行应急重置工具，只能在服务器或容器本地执行。
 * 用法：生产环境 `node dist/runtime/admin-mfa-reset-cli.js <用户名>`；开发环境 `npm --prefix backend run admin-mfa:reset -- <用户名>`。
 * 实现逻辑：只接收一个用户名参数，按当前运行配置（含数据库运行时覆盖）连接数据库，删除该账号的两步验证记录并写审计；
 * 不接收 SQL、路径或连接参数。
 * 维护说明：用于唯一管理员丢失认证器且恢复码用尽、或数据加密密钥丢失导致两步验证无法校验的场景；
 * 能执行本工具即意味着已具备服务器本地权限，与直接操作数据库等价，因此不再额外校验密码。
 */
import 'reflect-metadata'
import fs from 'node:fs'

const [rawUsername, ...extra] = process.argv.slice(2)
const username = rawUsername?.trim() ?? ''

if (!username || extra.length || username.length > 64) {
  console.error('用法：admin-mfa-reset-cli <用户名>')
  process.exitCode = 2
} else {
  const { env } = await import('../config/env.js')
  const { AppDataSource } = await import('../config/data-source.js')
  const { prepareDatabaseRuntime, resolveSqliteDatabasePath } = await import('../config/database-bootstrap.js')
  const { adminMfaService } = await import('../services/admin-mfa.service.js')
  try {
    if (env.DB_TYPE !== 'mysql' && !fs.existsSync(resolveSqliteDatabasePath())) {
      throw new Error('未找到 SQLite 数据库文件，请在后端运行目录下执行并确认数据目录配置')
    }
    prepareDatabaseRuntime()
    await AppDataSource.initialize()
    const result = await adminMfaService.resetByUsernameFromCli(username)
    console.log(result.reset
      ? `已重置账号 ${result.username} 的两步验证，该账号下次登录只需账号密码，请尽快重新绑定。`
      : `账号 ${result.username} 未开启两步验证，无需重置。`)
  } catch (error) {
    console.error(`两步验证重置失败：${error instanceof Error ? error.message : '未知错误'}`)
    process.exitCode = 1
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}
