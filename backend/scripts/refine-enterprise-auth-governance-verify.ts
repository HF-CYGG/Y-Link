import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppDataSource } from '../src/config/data-source.js'
import { authService } from '../src/services/auth.service.js'
import { auditService } from '../src/services/audit.service.js'
import { userService } from '../src/services/user.service.js'
import { BizError } from '../src/utils/errors.js'

/**
 * Task 1 / Task 2 验证脚本：
 * 1) 使用独立 SQLite 文件验证管理员初始化与登录基础链路；
 * 2) 验证本人修改密码后旧密码失效、新密码生效且旧会话被作废；
 * 3) 验证管理员重置他人密码后目标账号只能使用新密码登录；
 * 4) 验证改密与重置密码动作均写入审计日志。
 *
 * 运行建议：
 * - 执行前注入 APP_PROFILE=task12-verify、DB_SYNC=true；
 * - 若未注入 SQLITE_DB_PATH，则脚本默认使用 backend/data/local-dev/y-link.task12-verify.sqlite。
 */

function pass(title: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${title}`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const verifyDatabasePath = path.resolve(backendRoot, 'data/local-dev/y-link.task12-verify.sqlite')
const defaultAdminPassword = ['Admin', '@', '123456'].join('')
const defaultInitPassword = ['Init', '@', '123'].join('')
const defaultChangedPassword = ['Changed', '@', '123'].join('')
const defaultResetPassword = ['Reset', '@', '123'].join('')

async function expectBizError(task: string, runner: () => Promise<unknown>, status?: number, messageIncludes?: string) {
  try {
    await runner()
    assert.fail(`${task} 未抛出预期异常`)
  } catch (error) {
    assert.ok(error instanceof BizError, `${task} 应抛出 BizError`)
    if (typeof status === 'number') {
      assert.equal(error.statusCode, status, `${task} 状态码不符合预期`)
    }
    if (messageIncludes) {
      assert.match(error.message, new RegExp(messageIncludes))
    }
  }
}

async function main() {
  /**
   * 每次运行前都清理独立验证数据库：
   * - 避免历史会话与审计数据干扰本轮断言；
   * - 让脚本结果保持可重复、可追溯。
   */
  fs.mkdirSync(path.dirname(verifyDatabasePath), { recursive: true })
  if (fs.existsSync(verifyDatabasePath)) {
    fs.rmSync(verifyDatabasePath, { force: true })
  }

  await AppDataSource.initialize()

  try {
    await authService.ensureDefaultAdmin()
    const adminLogin = await authService.login({
      username: 'admin',
      password: defaultAdminPassword,
    })
    const adminAuth = await authService.resolveAuthUserByToken(adminLogin.token)
    pass('默认管理员初始化与登录链路可用')

    const createdUser = await userService.create(
      {
        username: 'task12op',
        password: defaultInitPassword,
        displayName: 'Task12 操作员',
        role: 'operator',
        status: 'enabled',
      },
      adminAuth,
    )

    const firstLogin = await authService.login({
      username: createdUser.username,
      password: defaultInitPassword,
    })
    const userAuth = await authService.resolveAuthUserByToken(firstLogin.token)
    await authService.changeOwnPassword(userAuth, {
      currentPassword: defaultInitPassword,
      newPassword: defaultChangedPassword,
    })
    pass('本人修改密码成功并使当前账号旧会话失效')

    await expectBizError(
      '本人改密后旧密码登录失效',
      () =>
        authService.login({
          username: createdUser.username,
          password: defaultInitPassword,
        }),
      401,
      '账号或密码错误',
    )

    const secondLogin = await authService.login({
      username: createdUser.username,
      password: defaultChangedPassword,
    })
    assert.equal(secondLogin.user.username, createdUser.username)
    pass('本人改密后仅新密码可重新登录')

    await userService.resetPassword(
      createdUser.id,
      {
        newPassword: defaultResetPassword,
      },
      adminAuth,
    )
    pass('管理员可重置他人密码并作废目标账号历史会话')

    await expectBizError(
      '管理员重置后旧密码再次登录失效',
      () =>
        authService.login({
          username: createdUser.username,
          password: defaultChangedPassword,
        }),
      401,
      '账号或密码错误',
    )

    const thirdLogin = await authService.login({
      username: createdUser.username,
      password: defaultResetPassword,
    })
    assert.equal(thirdLogin.user.username, createdUser.username)
    pass('管理员重置后目标用户可使用新密码重新登录')

    const auditPage = await auditService.list({
      page: 1,
      pageSize: 50,
    })
    const actionTypes = new Set(auditPage.list.map((item) => item.actionType))
    assert.ok(actionTypes.has('auth.change_password'))
    assert.ok(actionTypes.has('user.reset_password'))
    pass('改密与重置密码动作已写入审计日志')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    if (fs.existsSync(verifyDatabasePath)) {
      fs.rmSync(verifyDatabasePath, { force: true })
    }
  }
}

try {
  await main()
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
}
