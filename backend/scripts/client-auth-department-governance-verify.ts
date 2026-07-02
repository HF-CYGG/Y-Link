import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `client-auth-department-governance-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Aa1`
const clientPassword = `Client_${verifySeed}_Bb2`

process.env.APP_PROFILE = `client-auth-department-governance-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

type CapturedVerification = {
  channel: 'mobile' | 'email'
  target: string
  code: string
}

type ClientProfileKind = 'personal' | 'teacher' | 'department'

type ClientManageProfile = {
  id: string
  accountType: 'personal' | 'department'
  profileKind: ClientProfileKind
  username: string
  mobile: string
  email: string
  departmentName: string
  staffNo: string | null
  staffVerified: boolean
}

const pass = (message: string) => {
  console.log(`OK ${message}`)
}

const cleanupSqliteFile = () => {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(
      `[client-auth-department-governance] 临时 SQLite 清理失败，已忽略: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function expectBizError(action: () => Promise<unknown>, scene: string, messageIncludes: string) {
  try {
    await action()
  } catch (error) {
    assert.ok(error instanceof Error, `${scene} 应抛出 Error`)
    assert.ok(
      error.message.includes(messageIncludes),
      `${scene} 错误信息应包含“${messageIncludes}”，实际为: ${error.message}`,
    )
    return error.message
  }
  assert.fail(`${scene} 应失败但实际成功`)
}

function installVerificationFetchStub(captured: CapturedVerification[]) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = String(init?.body ?? '{}')
    const payload = JSON.parse(bodyText) as Partial<CapturedVerification>
    assert.equal(typeof payload.code, 'string', '验证码平台请求体应包含 code')
    assert.equal(typeof payload.target, 'string', '验证码平台请求体应包含 target')
    captured.push({
      channel: String(payload.target).includes('@') ? 'email' : 'mobile',
      target: String(payload.target),
      code: String(payload.code),
    })
    return new Response('ok', { status: 200 })
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const {
    initializeDatabaseSchemaIfNeeded,
    migrateLegacyDepartmentAccountsToTeacherProfiles,
    prepareDatabaseRuntime,
  } = await import('../src/config/database-bootstrap.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { clientStaffDirectoryService } = await import('../src/services/client-staff-directory.service.js')
  const { clientUserManageService } = await import('../src/services/client-user-manage.service.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { hashPassword } = await import('../src/utils/password.js')
  const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()

  const capturedVerifications: CapturedVerification[] = []
  const restoreFetch = installVerificationFetchStub(capturedVerifications)

  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()

    const adminLogin = await authService.login({ username: 'admin', password: adminPassword })
    const adminAuth = await authService.resolveAuthUserByToken(adminLogin.token)

    await systemConfigService.updateClientDepartmentConfigs(
      {
        tree: [
          { id: 'dept_assets', label: '资产处', children: [] },
          { id: 'dept_it', label: '信息中心', children: [] },
        ],
      },
      adminAuth,
    )
    await systemConfigService.updateVerificationProviderConfigs(
      {
        mobile: {
          enabled: true,
          httpMethod: 'POST',
          apiUrl: 'https://verification.example.com/mobile',
          headersTemplate: '{}',
          bodyTemplate: '{"target":"{{target}}","code":"{{code}}"}',
          successMatch: 'ok',
        },
        email: {
          enabled: true,
          httpMethod: 'POST',
          apiUrl: 'https://verification.example.com/email',
          headersTemplate: '{}',
          bodyTemplate: '{"target":"{{target}}","code":"{{code}}"}',
          successMatch: 'ok',
        },
      },
      adminAuth,
    )

    await clientStaffDirectoryService.create(
      { staffNo: 'T1001', realName: '张老师', departmentName: '资产处', status: 'active' },
      adminAuth,
    )
    await clientStaffDirectoryService.create(
      { staffNo: 'T1002', realName: '李老师', departmentName: '信息中心', status: 'active' },
      adminAuth,
    )

    const publicDepartmentCaptcha = await clientAuthService.createCaptcha()
    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'department',
          staffNo: 'T1001',
          account: '13800001001',
          password: clientPassword,
          captchaId: publicDepartmentCaptcha.captchaId,
          captchaCode: publicDepartmentCaptcha.captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6),
        }),
      '公开部门账号注册',
      '部门账号请联系管理员创建',
    )
    assert.equal(await AppDataSource.getRepository(ClientUser).count(), 0, '公开部门账号注册失败后不应写入客户端用户')
    pass('公开注册接口拒绝创建部门共享账号且不落库')

    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T1001',
          username: '张老师',
          account: '',
          password: clientPassword,
          captchaId: publicDepartmentCaptcha.captchaId,
          captchaCode: '000000',
        }),
      '教师注册缺少手机号或邮箱',
      '教师注册必须填写手机号或邮箱',
    )
    pass('教师注册缺少手机号或邮箱会失败')

    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T1001',
          username: '张老师',
          account: '13800001001',
          password: clientPassword,
          captchaId: publicDepartmentCaptcha.captchaId,
          captchaCode: '000000',
        }),
      '教师注册缺少短信验证码',
      '验证码',
    )
    pass('教师注册必须走短信或邮箱验证码')

    const sendResult = await clientAuthService.createCaptcha()
    await clientAuthService.verifyCaptchaBeforeVerificationSend({
      channel: 'mobile',
      target: '13800001001',
      scene: 'register',
      captchaId: sendResult.captchaId,
      captchaCode: sendResult.captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6),
    })
    const { verificationCodeService } = await import('../src/services/verification-code.service.js')
    const issueRegisterVerificationCode = async (target: string, channel: 'mobile' | 'email' = 'mobile') => {
      await verificationCodeService.sendCode({
        channel,
        target,
        scene: 'register',
      })
      const capturedCode = [...capturedVerifications].reverse().find((item) => item.target === target)?.code
      assert.ok(capturedCode, `应捕获 ${target} 的注册验证码`)
      return capturedCode
    }
    await verificationCodeService.sendCode({
      channel: 'mobile',
      target: '13800001001',
      scene: 'register',
    })
    const capturedMobileCode = capturedVerifications.find((item) => item.target === '13800001001')?.code
    assert.ok(capturedMobileCode, '应捕获教师注册短信验证码')

    const teacherRegisterResult = await clientAuthService.register({
      accountType: 'personal',
      staffNo: 'T1001',
      account: '13800001001',
      password: clientPassword,
      verificationCode: capturedMobileCode,
    })
    assert.equal(teacherRegisterResult.user.accountType, 'personal')
    assert.equal(teacherRegisterResult.user.username, '张老师')
    assert.equal(teacherRegisterResult.user.departmentName, '资产处')
    assert.equal(teacherRegisterResult.user.staffNo, 'T1001')
    assert.equal(teacherRegisterResult.user.staffVerified, true)
    pass('教师注册成功后以个人账号口径落库并绑定教工目录信息')

    await expectBizError(
      async () =>
        clientAuthService.register({
          accountType: 'personal',
          username: '张老师',
          account: '13800001011',
          password: clientPassword,
          verificationCode: await issueRegisterVerificationCode('13800001011'),
        }),
      '个人注册姓名占用',
      '该姓名已被占用',
    )
    pass('个人注册姓名被占用时返回明确提示')

    await expectBizError(
      async () =>
        clientAuthService.register({
          accountType: 'personal',
          username: '手机号占用',
          account: '13800001001',
          password: clientPassword,
          verificationCode: await issueRegisterVerificationCode('13800001001'),
        }),
      '个人注册手机号占用',
      '该手机号已被占用',
    )
    pass('个人注册手机号被占用时返回明确提示')

    const occupiedEmailCode = await issueRegisterVerificationCode('occupied@example.com', 'email')
    await clientAuthService.register({
      accountType: 'personal',
      username: '邮箱用户',
      account: 'occupied@example.com',
      password: clientPassword,
      verificationCode: occupiedEmailCode,
    })
    await expectBizError(
      async () =>
        clientAuthService.register({
          accountType: 'personal',
          username: '邮箱占用',
          account: 'occupied@example.com',
          password: clientPassword,
          verificationCode: await issueRegisterVerificationCode('occupied@example.com', 'email'),
        }),
      '个人注册邮箱占用',
      '该邮箱已被占用',
    )
    pass('个人注册邮箱被占用时返回明确提示')

    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T9999',
          account: '13800001999',
          password: clientPassword,
          verificationCode: capturedMobileCode,
        }),
      '教师注册工号不存在',
      '教职工号未在学校目录中登记',
    )
    pass('教师注册工号不存在会失败')

    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T1001',
          account: '13800001002',
          password: clientPassword,
          verificationCode: capturedMobileCode,
        }),
      '教师注册工号重复绑定',
      '该教职工号已被占用',
    )
    pass('教师注册工号已绑定会失败')

    await clientStaffDirectoryService.create(
      { staffNo: 'T1003', realName: '张老师', departmentName: '资产处', status: 'active' },
      adminAuth,
    )
    await expectBizError(
      async () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T1003',
          account: '13800001012',
          password: clientPassword,
          verificationCode: await issueRegisterVerificationCode('13800001012'),
        }),
      '教师注册目录姓名占用',
      '该姓名已被占用',
    )
    pass('教师注册目录姓名被占用时返回明确提示')

    const sessionCountBeforeFailedLogin = await AppDataSource.getRepository(ClientUserSession).count()
    const missingLoginCases = [
      { account: '不存在姓名', ipAddress: '192.0.2.11' },
      { account: '13900009999', ipAddress: '192.0.2.12' },
      { account: 'missing@example.com', ipAddress: '192.0.2.13' },
      { account: 'T4040', ipAddress: '192.0.2.14' },
    ]
    for (const missingLoginCase of missingLoginCases) {
      const missingLoginMessage = await expectBizError(
        () =>
          clientAuthService.login(
            {
              account: missingLoginCase.account,
              password: clientPassword,
            },
            {
              ipAddress: missingLoginCase.ipAddress,
              userAgent: 'client-auth-department-governance-verify',
              clientRiskBrowserId: null,
              clientRiskSessionId: null,
            },
          ),
        `不存在账号登录 ${missingLoginCase.account}`,
        '用户名或密码错误',
      )
      assert.doesNotMatch(missingLoginMessage, /用户名不存在/, '登录查无用户不应向公开入口暴露账号不存在')
    }

    const wrongPasswordMessage = await expectBizError(
      () =>
        clientAuthService.login(
          {
            account: '13800001001',
            password: `${clientPassword}_wrong`,
          },
          {
            ipAddress: '192.0.2.15',
            userAgent: 'client-auth-department-governance-verify',
            clientRiskBrowserId: null,
            clientRiskSessionId: null,
          },
        ),
      '已存在账号密码错误登录',
      '用户名或密码错误',
    )
    assert.doesNotMatch(wrongPasswordMessage, /用户名不存在/, '密码错误分支不应出现账号不存在提示')
    assert.equal(
      await AppDataSource.getRepository(ClientUserSession).count(),
      sessionCountBeforeFailedLogin,
      '查无用户或密码错误登录失败不应新增客户端会话',
    )
    pass('登录输入不存在账号或错误密码时返回统一公开错误且不创建会话')

    const product = await productService.create({
      productName: `治理验证商品${verifySeed}`,
      pinyinAbbr: `GOV${verifySeed.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-6)}`,
      defaultPrice: 8.5,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 100,
      limitPerUser: 10,
    })
    const teacherAuth = await clientAuthService.resolveClientByToken(teacherRegisterResult.token)
    const teacherPreorder = await o2oPreorderService.submit(teacherAuth, {
      isSystemApplied: false,
      pickupContact: '教师账号领取',
      items: [{ productId: product.id, qty: 1 }],
    })
    assert.equal(teacherPreorder.order.clientOrderType, 'walkin')
    assert.equal(teacherPreorder.order.staffNoSnapshot, null)
    pass('教师账号提交 O2O 预订单仍按散客订单处理')

    const departmentProfile = await clientUserManageService.createProfile(
      {
        profileKind: 'department',
        username: '资产处共享账号',
        departmentName: '资产处',
        password: clientPassword,
        status: 'enabled',
      },
      adminAuth,
    ) as ClientManageProfile
    assert.equal(departmentProfile.profileKind, 'department')
    assert.equal(departmentProfile.accountType, 'department')
    assert.match(departmentProfile.staffNo ?? '', /^DEPT-[A-Z0-9]{10}$/)
    assert.equal(departmentProfile.staffVerified, true)
    pass('管理端可创建自动生成编号的部门共享账号')

    const departmentLogin = await clientAuthService.login({
      account: departmentProfile.staffNo ?? '',
      password: clientPassword,
    })
    const departmentAuth = await clientAuthService.resolveClientByToken(departmentLogin.token)
    const departmentPreorder = await o2oPreorderService.submit(departmentAuth, {
      isSystemApplied: false,
      pickupContact: '部门共享账号领取',
      items: [{ productId: product.id, qty: 1 }],
    })
    assert.equal(departmentPreorder.order.clientOrderType, 'department')
    assert.equal(departmentPreorder.order.departmentNameSnapshot, '资产处')
    assert.equal(departmentPreorder.order.staffNoSnapshot, departmentProfile.staffNo)
    pass('管理端创建的部门共享账号可按部门订单下单')

    const adminTeacherProfile = await clientUserManageService.createProfile(
      {
        profileKind: 'teacher',
        username: '会被目录覆盖',
        staffNo: 'T1002',
        mobile: '13800001003',
        password: clientPassword,
        status: 'enabled',
      },
      adminAuth,
    ) as ClientManageProfile
    assert.equal(adminTeacherProfile.profileKind, 'teacher')
    assert.equal(adminTeacherProfile.accountType, 'personal')
    assert.equal(adminTeacherProfile.username, '李老师')
    assert.equal(adminTeacherProfile.departmentName, '信息中心')
    assert.equal(adminTeacherProfile.staffNo, 'T1002')
    pass('管理端可创建教师账号并按目录回填身份信息')

    const listResult = await clientUserManageService.list({ page: 1, pageSize: 20 })
    const profileKinds = new Set(listResult.list.map((item) => item.profileKind))
    assert.ok(profileKinds.has('teacher'), '客户端用户列表应包含教师账号类型')
    assert.ok(profileKinds.has('department'), '客户端用户列表应包含部门共享账号类型')
    pass('管理端列表返回三类身份派生字段')

    const legacyUser = await AppDataSource.getRepository(ClientUser).save(
      AppDataSource.getRepository(ClientUser).create({
        realName: '旧部门账号',
        mobile: '13800001004',
        departmentName: '资产处',
        accountType: 'department',
        staffNo: 'T1002-LEGACY',
        staffVerified: true,
        passwordHash: await hashPassword(clientPassword),
        status: 'enabled',
      }),
    )
    await clientStaffDirectoryService.create(
      { staffNo: 'T1002-LEGACY', realName: '王老师', departmentName: '信息中心', status: 'active' },
      adminAuth,
    )
    const migrationResult = await migrateLegacyDepartmentAccountsToTeacherProfiles(AppDataSource)
    assert.equal(migrationResult.migratedCount >= 1, true)
    const migratedLegacyUser = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: legacyUser.id })
    assert.equal(migratedLegacyUser.accountType, 'personal')
    assert.equal(migratedLegacyUser.realName, '王老师')
    assert.equal(migratedLegacyUser.departmentName, '信息中心')
    assert.equal(Boolean(migratedLegacyUser.staffVerified), true)
    assert.equal(
      await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: product.id }).then((item) => Number(item.preOrderedStock) > 0),
      true,
      '迁移旧账号不应影响已创建订单与库存占用',
    )
    pass('旧部门账号命中教职工目录后可迁移为教师账号，历史订单不回改')
  } finally {
    restoreFetch()
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

try {
  await main()
} catch (error) {
  console.error('[client-auth-department-governance] 验证失败:', error)
  cleanupSqliteFile()
  process.exitCode = 1
}
