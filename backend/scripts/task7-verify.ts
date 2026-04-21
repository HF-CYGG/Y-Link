/**
 * 模块说明：Task7 自动化验证脚本
 * 文件职责：验证登录退出、角色限制、用户管理与开单审计链路
 * 维护说明：认证守卫、用户管理或审计行为发生变更时需同步维护本脚本断言
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppDataSource } from '../src/config/data-source.js'
import { authService } from '../src/services/auth.service.js'
import { auditService } from '../src/services/audit.service.js'
import { orderService } from '../src/services/order.service.js'
import { userService } from '../src/services/user.service.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { BizError } from '../src/utils/errors.js'

/**
 * Task 7 自动化验证脚本：
 * 1) 使用独立 SQLite 文件验证登录、退出、角色限制源码守卫；
 * 2) 验证用户管理的新增、编辑、启停与相关审计日志；
 * 3) 验证开单后主单留痕、详情字段与审计记录链路。
 *
 * 说明：
 * - 脚本依赖运行前注入 APP_PROFILE=task7-verify、DB_SYNC=true；
 * - 数据库文件会在执行前清理，避免历史数据污染断言；
 * - 前端“未登录拦截/角色限制”通过源码静态断言验证，保持与 Task 6 的校验方式一致。
 */

function pass(title: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${title}`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const frontendRoot = path.resolve(backendRoot, '..')
const verifyDatabasePath = path.resolve(backendRoot, 'data/local-dev/y-link.task7-verify.sqlite')
const defaultAdminPassword = ['Admin', '@', '123456'].join('')
const defaultOperatorPasswordV1 = ['Task71', '@', '123'].join('')
const defaultOperatorPasswordV2 = ['Task72', '@', '123'].join('')

/**
 * 清理独立验证数据库：
 * - 每次执行前删除旧库，确保断言基于干净数据；
 * - 若文件不存在则跳过，不影响首跑。
 */
function resetVerifyDatabase() {
  fs.mkdirSync(path.dirname(verifyDatabasePath), { recursive: true })
  if (fs.existsSync(verifyDatabasePath)) {
    fs.rmSync(verifyDatabasePath, { force: true })
  }
}

/**
 * 静态断言前端鉴权与角色限制源码：
 * - 验证未登录进入业务页会跳转 /login 并带 redirect；
 * - 验证登录页回跳与管理员路由限制仍然存在；
 * - 该部分聚焦路由守卫契约，不依赖浏览器环境。
 */
function verifyFrontendAuthGuards() {
  const routerSource = fs.readFileSync(path.resolve(frontendRoot, 'src/router/index.ts'), 'utf8')
  const routesSource = fs.readFileSync(path.resolve(frontendRoot, 'src/router/routes.ts'), 'utf8')

  assert.match(routerSource, /path:\s*'\/login'/)
  assert.match(routerSource, /redirect:\s*to\.fullPath/)
  assert.match(routerSource, /resolveSafeRedirect\(to\.query\.redirect\)/)
  assert.match(routerSource, /当前账号无权访问该页面/)
  assert.match(routesSource, /allowedRoles:\s*\['admin'\]/)
  assert.match(routesSource, /export const canRoleAccessRoute/)

  pass('前端未登录拦截、登录回跳与管理员角色限制源码存在')
}

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
  resetVerifyDatabase()
  verifyFrontendAuthGuards()

  await AppDataSource.initialize()

  try {
    /**
     * 初始化管理员并验证登录态：
     * - ensureDefaultAdmin 验证 7.4 初始化能力仍可用；
     * - login / me / logout / resolveAuthUserByToken 覆盖 7.1 核心认证链路。
     */
    const bootstrap = await authService.ensureDefaultAdmin()
    assert.equal(bootstrap.username, 'admin')
    pass('默认管理员初始化能力可用')

    const adminLogin = await authService.login({
      username: 'admin',
      password: defaultAdminPassword,
    })
    assert.equal(adminLogin.user.role, 'admin')

    const adminAuth = await authService.resolveAuthUserByToken(adminLogin.token)
    const adminProfile = await authService.me(adminAuth)
    assert.equal(adminProfile.username, 'admin')
    pass('管理员可登录并读取当前用户信息')

    /**
     * 验证用户管理增改启停：
     * - 管理员创建操作员；
     * - 编辑姓名与密码；
     * - 停用后禁止登录，启用后可再次登录。
     */
    const createdOperator = await userService.create(
      {
        username: 'task71op',
        password: defaultOperatorPasswordV1,
        displayName: 'Task7.1操作员',
        role: 'operator',
      },
      adminAuth,
    )
    assert.equal(createdOperator.role, 'operator')

    const updatedOperator = await userService.update(
      createdOperator.id,
      {
        displayName: 'Task7.2操作员',
        password: defaultOperatorPasswordV2,
      },
      adminAuth,
    )
    assert.equal(updatedOperator.displayName, 'Task7.2操作员')

    const disabledOperator = await userService.updateStatus(createdOperator.id, 'disabled', adminAuth)
    assert.equal(disabledOperator.status, 'disabled')

    await expectBizError(
      '停用账号登录拦截',
      () =>
        authService.login({
          username: 'task71op',
          password: defaultOperatorPasswordV2,
        }),
      403,
      '停用',
    )

    const enabledOperator = await userService.updateStatus(createdOperator.id, 'enabled', adminAuth)
    assert.equal(enabledOperator.status, 'enabled')
    pass('用户管理新增、编辑、启停流程可用')

    /**
     * 验证操作员登录、退出与出库留痕：
     * - 操作员登录后提交一张测试出库单；
     * - 详情中需带回开单人快照与已归一化的明细字段；
     * - 退出后原 token 不再可用。
     */
    const operatorLogin = await authService.login({
      username: 'task71op',
      password: defaultOperatorPasswordV2,
    })
    const operatorAuth = await authService.resolveAuthUserByToken(operatorLogin.token)
    assert.equal(operatorAuth.role, 'operator')

    const productRepo = AppDataSource.getRepository(BaseProduct)
    const product = await productRepo.save(
      productRepo.create({
        productCode: 'TASK7P01',
        productName: 'Task7测试产品',
        pinyinAbbr: 'TSCP',
        defaultPrice: '12.50',
        isActive: true,
      }),
    )

    const submitResult = await orderService.submit(
      {
        idempotencyKey: `web-auto-${Date.now()}`,
        customerName: 'Task7验证客户',
        remark: 'Task7.1 自动化验证订单',
        items: [
          {
            productId: String(product.id),
            qty: 2,
            unitPrice: 12.5,
            remark: '测试行备注',
          },
        ],
      },
      operatorAuth,
    )

    const orderDetail = await orderService.detailById(String(submitResult.order.id))
    assert.equal(orderDetail.order.creatorUsername, 'task71op')
    assert.equal(orderDetail.order.creatorDisplayName, 'Task7.2操作员')
    assert.equal(orderDetail.items.length, 1)
    assert.equal(orderDetail.items[0].productCode, 'TASK7P01')
    assert.equal(orderDetail.items[0].productName, 'Task7测试产品')
    assert.equal(String(orderDetail.items[0].subTotal), '25')
    pass('开单详情可展示开单人信息与正确明细字段')

    const orderList = await orderService.list({
      page: 1,
      pageSize: 10,
    })
    assert.equal(orderList.list[0]?.creatorUsername, 'task71op')
    assert.equal(orderList.list[0]?.creatorDisplayName, 'Task7.2操作员')
    pass('单据列表可展示开单用户信息')

    await authService.logout(operatorAuth)
    await expectBizError(
      '退出登录后 token 失效',
      () => authService.resolveAuthUserByToken(operatorLogin.token),
      401,
      '失效|无效',
    )
    pass('登录成功跳转前置能力与退出登录令牌失效链路可用')

    /**
     * 验证审计日志查询：
     * - 用户管理动作、登录/退出动作、开单动作均应留痕；
     * - 审计列表接口需可按分页读取关键日志。
     */
    const auditPage = await auditService.list({
      page: 1,
      pageSize: 50,
    })
    const actionTypes = new Set(auditPage.list.map((item) => item.actionType))

    assert.ok(actionTypes.has('auth.login'))
    assert.ok(actionTypes.has('auth.logout'))
    assert.ok(actionTypes.has('user.create'))
    assert.ok(actionTypes.has('user.update'))
    assert.ok(actionTypes.has('user.update_status'))
    assert.ok(actionTypes.has('order.create'))

    const orderAudit = auditPage.list.find((item) => item.actionType === 'order.create')
    assert.equal(orderAudit?.targetCode, submitResult.order.showNo)
    pass('审计日志可查看登录、用户管理与开单关键操作记录')

    const storedOrder = await AppDataSource.getRepository(BizOutboundOrder).findOne({
      where: { id: submitResult.order.id },
    })
    assert.equal(storedOrder?.creatorUsername, 'task71op')
    pass('出库单成功创建后会记录开单用户快照')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
