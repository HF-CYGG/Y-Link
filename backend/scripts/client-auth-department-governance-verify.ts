import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCaptchaServiceForTesting } from '../src/services/captcha.service.js'

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
process.env.INVITE_CODE_PEPPER ||= `governance-pepper-${verifySeed}-minimum-32-bytes`

const TEST_CAPTCHA_CODE = 'ABC123'
installCaptchaServiceForTesting({ createCode: () => TEST_CAPTCHA_CODE })

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

function createVerificationRequestStub(captured: CapturedVerification[]) {
  return async (_input: string | URL, init?: { body?: string | Buffer }) => {
    const bodyText = String(init?.body ?? '{}')
    const payload = JSON.parse(bodyText) as Partial<CapturedVerification>
    assert.equal(typeof payload.code, 'string', '验证码平台请求体应包含 code')
    assert.equal(typeof payload.target, 'string', '验证码平台请求体应包含 target')
    captured.push({
      channel: String(payload.target).includes('@') ? 'email' : 'mobile',
      target: String(payload.target),
      code: String(payload.code),
    })
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from('ok'),
    }
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
  const { SystemConfig } = await import('../src/entities/system-config.entity.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { clientStaffDirectoryService } = await import('../src/services/client-staff-directory.service.js')
  const { clientFeedbackService } = await import('../src/services/client-feedback.service.js')
  const { clientUserManageService } = await import('../src/services/client-user-manage.service.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { hashPassword } = await import('../src/utils/password.js')
  const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()

  const capturedVerifications: CapturedVerification[] = []

  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()

    const adminLogin = await authService.login({ username: 'admin', password: adminPassword })
    const adminAuth = await authService.resolveAuthUserByToken(adminLogin.token)
    const longDepartmentLabels = [
      '第一级部门路径容量验证节点甲乙丙丁戊',
      '第二级部门路径容量验证节点甲乙丙丁戊',
      '第三级部门路径容量验证节点甲乙丙丁戊',
      '第四级部门路径容量验证节点甲乙丙丁戊',
      '第五级部门路径容量验证节点甲乙丙丁戊',
      '第六级部门路径容量验证节点甲乙丙丁戊',
      '第七级部门路径容量验证节点甲乙丙丁戊',
    ] as const
    const longDepartmentPath = longDepartmentLabels.join('-')
    assert.ok(longDepartmentPath.length > 128 && longDepartmentPath.length <= 271, '验证用部门路径应覆盖 128 到 271 字符容量')

    await systemConfigService.updateClientDepartmentConfigs(
      {
        tree: [
          { id: 'dept_assets', label: '资产处', children: [] },
          { id: 'dept_it', label: '信息中心', children: [] },
          { id: 'dept_logistics', label: '后勤处', children: [] },
          { id: 'dept_finance', label: '财务处', children: [] },
          { id: 'dept_hr', label: '人事处', children: [] },
          {
            id: 'dept_long_1',
            label: longDepartmentLabels[0],
            children: [{
              id: 'dept_long_2',
              label: longDepartmentLabels[1],
              children: [{
                id: 'dept_long_3',
                label: longDepartmentLabels[2],
                children: [{
                  id: 'dept_long_4',
                  label: longDepartmentLabels[3],
                  children: [{
                    id: 'dept_long_5',
                    label: longDepartmentLabels[4],
                    children: [{
                      id: 'dept_long_6',
                      label: longDepartmentLabels[5],
                      children: [{ id: 'dept_long_7', label: longDepartmentLabels[6], children: [] }],
                    }],
                  }],
                }],
              }],
            }],
          },
        ],
      },
      adminAuth,
    )

    type DepartmentAccountBatchService = typeof clientUserManageService & {
      previewDepartmentAccounts: (input: { departmentNodeIds: string[] }) => Promise<{
        creatable: Array<{ departmentNodeId: string; departmentName: string }>
        skipped: Array<{ departmentNodeId: string; departmentName: string; account: string; status: string }>
      }>
      createDepartmentAccountsBatch: (
        input: {
          status: 'enabled' | 'disabled'
          items: Array<{ departmentNodeId: string; account: string; initialPassword: string }>
        },
        actor: typeof adminAuth,
      ) => Promise<{
        created: Array<{ departmentNodeId: string; account: string; departmentName: string }>
        skipped: Array<{ departmentNodeId: string; departmentName: string; account: string; status: string }>
      }>
    }
    const departmentAccountBatchService = clientUserManageService as DepartmentAccountBatchService
    const departmentConfigRepo = AppDataSource.getRepository(SystemConfig)
    const persistedDepartmentConfig = await departmentConfigRepo.findOneByOrFail({ configKey: 'client.department.options' })
    const persistedDepartmentConfigValue = persistedDepartmentConfig.configValue
    await systemConfigService.updateClientDepartmentConfigs(
      {
        tree: [{ id: 'dept_flat_hyphen', label: '研发-平台', children: [] }],
      },
      adminAuth,
    )
    const flatModernTreeWithHyphen = await systemConfigService.getClientDepartmentConfigs()
    assert.deepEqual(
      flatModernTreeWithHyphen.tree,
      [{ id: 'dept_flat_hyphen', label: '研发-平台', children: [] }],
      '携带稳定 ID 的现代平级 tree 不得被当成旧扁平路径拆分',
    )
    await expectBizError(
      () => systemConfigService.updateClientDepartmentConfigs(
        { options: flatModernTreeWithHyphen.options },
        adminAuth,
      ),
      '旧 options 保存仅含平级连字符标签的现代部门树',
      '旧 options',
    )
    await departmentConfigRepo.update({ id: persistedDepartmentConfig.id }, { configValue: persistedDepartmentConfigValue })
    await departmentConfigRepo.update(
      { id: persistedDepartmentConfig.id },
      { configValue: JSON.stringify(['旧机构-旧部门']) },
    )
    const legacyOptionsFirstRead = await systemConfigService.getClientDepartmentConfigs()
    const legacyOptionsSecondRead = await systemConfigService.getClientDepartmentConfigs()
    const legacyOptionNodeId = legacyOptionsFirstRead.tree[0]?.children[0]?.id
    assert.equal(legacyOptionNodeId, legacyOptionsSecondRead.tree[0]?.children[0]?.id, '旧 options 配置连续读取必须保持稳定节点ID')
    await departmentConfigRepo.update(
      { id: persistedDepartmentConfig.id },
      { configValue: JSON.stringify(['前置部门', '旧机构-旧部门', '其他机构-其他部门']) },
    )
    const reorderedLegacyOptions = await systemConfigService.resolveClientDepartmentReference({ departmentName: '旧机构-旧部门' })
    assert.equal(reorderedLegacyOptions.departmentNodeId, legacyOptionNodeId, '旧 options 重排或前插其他项不得改变同一路径节点ID')
    await departmentConfigRepo.update(
      { id: persistedDepartmentConfig.id },
      {
        configValue: JSON.stringify({
          tree: [{ label: '旧机构', children: [{ label: '旧部门', children: [] }] }],
        }),
      },
    )
    const missingIdLegacyTree = await systemConfigService.resolveClientDepartmentReference({ departmentName: '旧机构-旧部门' })
    assert.equal(missingIdLegacyTree.departmentNodeId, legacyOptionNodeId, '旧 options 与无ID树相同完整路径必须得到相同节点ID')
    await departmentConfigRepo.update(
      { id: persistedDepartmentConfig.id },
      { configValue: JSON.stringify(['旧机构-旧部门']) },
    )
    const legacyOptionsPreview = await departmentAccountBatchService.previewDepartmentAccounts({
      departmentNodeIds: [legacyOptionNodeId ?? ''],
    })
    const legacyOptionsBatch = await departmentAccountBatchService.createDepartmentAccountsBatch(
      {
        status: 'enabled',
        items: [{ departmentNodeId: legacyOptionNodeId ?? '', account: 'DEPT-0A0B0C0D0E', initialPassword: clientPassword }],
      },
      adminAuth,
    )
    assert.equal(legacyOptionsPreview.creatable.length, 1)
    assert.equal(legacyOptionsBatch.created[0]?.departmentNodeId, legacyOptionNodeId, 'preview 返回的旧配置节点ID必须可用于 batch')
    await departmentConfigRepo.update({ id: persistedDepartmentConfig.id }, { configValue: persistedDepartmentConfigValue })
    await AppDataSource.getRepository(ClientUser).delete({ id: legacyOptionsBatch.created[0]!.id })

    await departmentConfigRepo.update(
      { id: persistedDepartmentConfig.id },
      { configValue: JSON.stringify({ tree: [{ label: '旧无ID部门', children: [] }] }) },
    )
    const legacyTreeFirstRead = await systemConfigService.getClientDepartmentConfigs()
    const legacyTreeSecondRead = await systemConfigService.getClientDepartmentConfigs()
    assert.equal(legacyTreeFirstRead.tree[0]?.id, legacyTreeSecondRead.tree[0]?.id, '无ID旧树连续读取必须保持稳定节点ID')
    await departmentConfigRepo.update({ id: persistedDepartmentConfig.id }, { configValue: persistedDepartmentConfigValue })

    const databaseBootstrapSource = fs.readFileSync(path.join(backendRoot, 'src', 'config', 'database-bootstrap.ts'), 'utf8')
    const governanceStart = databaseBootstrapSource.indexOf('export async function migrateClientUserDepartmentGovernance')
    const governanceEnd = databaseBootstrapSource.indexOf('async function shouldSynchronizeSqliteSchema', governanceStart)
    const governanceFunctionSource = databaseBootstrapSource.slice(governanceStart, governanceEnd)
    assert.ok(governanceStart >= 0 && governanceEnd > governanceStart, '启动迁移函数必须存在以校验事务边界')
    assert.match(governanceFunctionSource, /return runInTransaction\(async \(manager\) => \{/, '启动迁移必须以统一事务作为计划与写入边界')
    assert.match(governanceFunctionSource, /getClientDepartmentConfigs\(manager, \{ lockForUpdate: true \}\)/, '部门配置必须由同一事务 manager 加锁读取')
    assert.doesNotMatch(governanceFunctionSource, /dataSource\.getRepository/, '启动迁移不得在事务外读取账号或教师计划')

    const bootstrapModule = await import('../src/config/database-bootstrap.js')
    const departmentGovernanceBootstrap = bootstrapModule as typeof bootstrapModule & {
      migrateClientUserDepartmentGovernance: (dataSource: typeof AppDataSource) => Promise<{ migratedCount: number }>
    }
    await clientStaffDirectoryService.create(
      { staffNo: 'T9000', realName: '迁移教师', departmentName: '财务处', status: 'active' },
      adminAuth,
    )
    const legacyConvertibleUser = await AppDataSource.getRepository(ClientUser).save(
      AppDataSource.getRepository(ClientUser).create({
        realName: '原部门教师账号',
        mobile: null,
        email: null,
        departmentName: '财务处',
        departmentNodeId: null,
        accountType: 'department',
        staffNo: 'T9000',
        staffVerified: true,
        passwordHash: await hashPassword(clientPassword),
        status: 'enabled',
      }),
    )
    const unmappedDepartmentUser = await AppDataSource.getRepository(ClientUser).save(
      AppDataSource.getRepository(ClientUser).create({
        realName: '无法映射部门账号',
        mobile: null,
        email: null,
        departmentName: '不存在部门',
        departmentNodeId: null,
        accountType: 'department',
        staffNo: 'DEPT-FFEEDDCCAA',
        staffVerified: true,
        passwordHash: await hashPassword(clientPassword),
        status: 'enabled',
      }),
    )
    await expectBizError(
      () => departmentGovernanceBootstrap.migrateClientUserDepartmentGovernance(AppDataSource),
      '存量回填预检失败',
      '无法映射',
    )
    const unchangedConvertibleUser = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: legacyConvertibleUser.id })
    assert.equal(unchangedConvertibleUser.accountType, 'department', '回填预检失败时不得先将可迁移账号改写为教师')
    await AppDataSource.getRepository(ClientUser).delete({ id: unmappedDepartmentUser.id })
    await departmentGovernanceBootstrap.migrateClientUserDepartmentGovernance(AppDataSource)
    const convertedAfterSuccessfulPlan = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: legacyConvertibleUser.id })
    assert.equal(convertedAfterSuccessfulPlan.accountType, 'personal')
    assert.equal(convertedAfterSuccessfulPlan.departmentNodeId, null, '统一迁移成功后教师账号必须释放部门节点')
    const initialDepartmentBatchPreview = await departmentAccountBatchService.previewDepartmentAccounts({
      departmentNodeIds: ['dept_assets', 'dept_it'],
    })
    assert.deepEqual(
      initialDepartmentBatchPreview.creatable.map((item) => item.departmentNodeId),
      ['dept_assets', 'dept_it'],
      '部门节点预检应按 nodeId 精确返回待创建项',
    )
    assert.deepEqual(initialDepartmentBatchPreview.skipped, [], '首次预检不应跳过任何部门账号')
    const firstDepartmentBatch = await departmentAccountBatchService.createDepartmentAccountsBatch(
      {
        status: 'enabled',
        items: [
          { departmentNodeId: 'dept_assets', account: 'DEPT-AAAABBBBCC', initialPassword: clientPassword },
          { departmentNodeId: 'dept_it', account: 'DEPT-1122334455', initialPassword: clientPassword },
        ],
      },
      adminAuth,
    )
    assert.deepEqual(
      firstDepartmentBatch.created.map((item) => item.departmentNodeId),
      ['dept_assets', 'dept_it'],
      '批量开户应创建全部预检可创建项',
    )
    assert.equal(firstDepartmentBatch.skipped.length, 0)
    const configBeforeLegacyOptionsSave = await systemConfigService.getClientDepartmentConfigs()
    const legacyOptionsSaveResult = await systemConfigService.updateClientDepartmentConfigs(
      { options: configBeforeLegacyOptionsSave.options },
      adminAuth,
    )
    assert.equal(legacyOptionsSaveResult.changed, false, '旧 options 入口原样保存不应改变部门节点身份')
    assert.deepEqual(
      legacyOptionsSaveResult.config.tree,
      configBeforeLegacyOptionsSave.tree,
      '旧 options 入口必须按完整路径保留已有节点 ID',
    )
    await systemConfigService.updateClientDepartmentConfigs(
      {
        tree: [
          ...configBeforeLegacyOptionsSave.tree,
          { id: 'dept_hyphen_literal', label: '研发-平台', children: [] },
          {
            id: 'dept_hyphen_parent',
            label: '研发',
            children: [{ id: 'dept_hyphen_child', label: '平台', children: [] }],
          },
        ],
      },
      adminAuth,
    )
    const ambiguousDepartmentProfile = await clientUserManageService.createProfile(
      {
        profileKind: 'department',
        username: '含连字符部门共享账号',
        departmentNodeId: 'dept_hyphen_literal',
        password: clientPassword,
        status: 'disabled',
      },
      adminAuth,
    ) as ClientManageProfile
    const ambiguousDepartmentConfig = await systemConfigService.getClientDepartmentConfigs()
    await expectBizError(
      () => systemConfigService.updateClientDepartmentConfigs(
        { options: ambiguousDepartmentConfig.options },
        adminAuth,
      ),
      '旧 options 保存含连字符的歧义部门树',
      '旧 options',
    )
    const configAfterAmbiguousOptionsBlocked = await systemConfigService.getClientDepartmentConfigs()
    assert.deepEqual(
      configAfterAmbiguousOptionsBlocked.tree,
      ambiguousDepartmentConfig.tree,
      '旧 options 无法无歧义表示部门树时必须在改写前阻断',
    )
    const ambiguousDepartmentAccountAfterBlocked = await AppDataSource.getRepository(ClientUser).findOneByOrFail({
      id: ambiguousDepartmentProfile.id,
    })
    assert.equal(ambiguousDepartmentAccountAfterBlocked.departmentNodeId, 'dept_hyphen_literal')
    assert.equal(ambiguousDepartmentAccountAfterBlocked.status, 'disabled')
    await systemConfigService.updateClientDepartmentConfigs(
      { tree: configBeforeLegacyOptionsSave.tree },
      adminAuth,
    )
    await AppDataSource.getRepository(ClientUser).delete({ id: ambiguousDepartmentProfile.id })
    const departmentAccountHashBeforeSkip = await AppDataSource.getRepository(ClientUser)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.departmentNodeId = :departmentNodeId', { departmentNodeId: 'dept_assets' })
      .getOneOrFail()
      .then((user) => user.passwordHash)
    await clientUserManageService.updateStatus(firstDepartmentBatch.created[0]!.id, 'disabled', adminAuth)
    const existingDepartmentBatchPreview = await departmentAccountBatchService.previewDepartmentAccounts({
      departmentNodeIds: ['dept_assets', 'dept_it'],
    })
    assert.equal(existingDepartmentBatchPreview.creatable.length, 0)
    assert.deepEqual(
      existingDepartmentBatchPreview.skipped.map((item) => item.account),
      ['DEPT-AAAABBBBCC', 'DEPT-1122334455'],
      '已有部门账号必须无论状态均被跳过且不重置密码',
    )
    assert.equal(existingDepartmentBatchPreview.skipped[0]?.status, 'disabled', '已停用账号仍必须被跳过')
    const allSkippedDepartmentBatch = await departmentAccountBatchService.createDepartmentAccountsBatch(
      {
        status: 'enabled',
        items: [
          { departmentNodeId: 'dept_assets', account: 'DEPT-AAAABBBBCC', initialPassword: `Skip_${verifySeed}_Cc3` },
          { departmentNodeId: 'dept_it', account: 'DEPT-1122334455', initialPassword: `Skip_${verifySeed}_Dd4` },
        ],
      },
      adminAuth,
    )
    assert.equal(allSkippedDepartmentBatch.created.length, 0, '全部已存在时不应重置或创建账号')
    assert.equal(allSkippedDepartmentBatch.skipped.length, 2)
    const departmentAccountHashAfterSkip = await AppDataSource.getRepository(ClientUser)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.departmentNodeId = :departmentNodeId', { departmentNodeId: 'dept_assets' })
      .getOneOrFail()
      .then((user) => user.passwordHash)
    assert.equal(departmentAccountHashAfterSkip, departmentAccountHashBeforeSkip, '跳过已有账号不得改变密码哈希')
    await expectBizError(
      () => departmentAccountBatchService.createDepartmentAccountsBatch(
        {
          status: 'enabled',
          items: [
            { departmentNodeId: 'dept_finance', account: 'DEPT-FFEEDDCCBB', initialPassword: clientPassword },
            { departmentNodeId: 'dept_hr', account: 'DEPT-AAAABBBBCC', initialPassword: clientPassword },
          ],
        },
        adminAuth,
      ),
      '批量开户中账号编号冲突',
      '账号编号已被其他客户端用户使用',
    )
    const rollbackPreview = await departmentAccountBatchService.previewDepartmentAccounts({
      departmentNodeIds: ['dept_finance', 'dept_hr'],
    })
    assert.equal(rollbackPreview.creatable.length, 2, '任一待创建项失败时批量写入必须整体回滚')
    await expectBizError(
      () => departmentAccountBatchService.previewDepartmentAccounts({
        departmentNodeIds: Array.from({ length: 101 }, (_, index) => `dept_limit_${index}`),
      }),
      '部门节点数量超过上限',
      '一次最多可处理 100 个部门节点',
    )
    pass('部门共享账号批量预检与创建按稳定部门节点治理')
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

    const teacherOneDirectory = await clientStaffDirectoryService.create(
      { staffNo: 'T1001', realName: '张老师', departmentName: '资产处', status: 'active' },
      adminAuth,
    )
    const teacherTwoDirectory = await clientStaffDirectoryService.create(
      { staffNo: 'T1002', realName: '李老师', departmentName: '信息中心', status: 'active' },
      adminAuth,
    )
    await clientStaffDirectoryService.setInviteCode(teacherOneDirectory.record.id, '12345678', adminAuth)
    await clientStaffDirectoryService.setInviteCode(teacherTwoDirectory.record.id, '87654321', adminAuth)

    const publicDepartmentCaptcha = await clientAuthService.createCaptcha()
    const clientUserCountBeforePublicDepartmentRegister = await AppDataSource.getRepository(ClientUser).count()
    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'department',
          staffNo: 'T1001',
          account: '13800001001',
          password: clientPassword,
          captchaId: publicDepartmentCaptcha.captchaId,
          captchaCode: TEST_CAPTCHA_CODE,
        }),
      '公开部门账号注册',
      '部门账号请联系管理员创建',
    )
    assert.equal(
      await AppDataSource.getRepository(ClientUser).count(),
      clientUserCountBeforePublicDepartmentRegister,
      '公开部门账号注册失败后不应写入客户端用户',
    )
    pass('公开注册接口拒绝创建部门共享账号且不落库')

    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T1001',
          username: '张老师',
          account: '',
          inviteCode: '',
          password: clientPassword,
          captchaId: publicDepartmentCaptcha.captchaId,
          captchaCode: '000000',
        }),
      '教师注册缺少邀请码',
      '工号或邀请码无效',
    )
    pass('教师注册缺少邀请码会失败')

    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T1001',
          username: '张老师',
          account: '',
          inviteCode: '00000000',
          password: clientPassword,
          captchaId: publicDepartmentCaptcha.captchaId,
          captchaCode: '000000',
        }),
      '教师注册邀请码错误',
      '工号或邀请码无效',
    )
    pass('教师注册错误邀请码会失败')

    const sendResult = await clientAuthService.createCaptcha()
    await clientAuthService.verifyCaptchaBeforeVerificationSend({
      channel: 'mobile',
      target: '13800001001',
      scene: 'register',
      captchaId: sendResult.captchaId,
      captchaCode: TEST_CAPTCHA_CODE,
    })
    const { VerificationCodeService } = await import('../src/services/verification-code.service.js')
    const verificationCodeService = new VerificationCodeService(createVerificationRequestStub(capturedVerifications))
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
      inviteCode: '12345678',
      password: clientPassword,
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
      '当前注册信息无法使用',
    )
    pass('个人注册姓名被占用时返回泛化提示')

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
      '当前注册信息无法使用',
    )
    pass('个人注册手机号被占用时返回泛化提示')

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
      '当前注册信息无法使用',
    )
    pass('个人注册邮箱被占用时返回泛化提示')

    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T9999',
          inviteCode: '11112222',
          account: '13800001999',
          password: clientPassword,
          verificationCode: capturedMobileCode,
        }),
      '教师注册工号不存在',
      '工号或邀请码无效',
    )
    pass('教师注册工号不存在会失败')

    await expectBizError(
      () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T1001',
          inviteCode: '12345678',
          account: '13800001002',
          password: clientPassword,
          verificationCode: capturedMobileCode,
        }),
      '教师注册工号重复绑定',
      '工号或邀请码无效',
    )
    pass('教师注册工号已绑定会失败')

    const duplicateNameDirectory = await clientStaffDirectoryService.create(
      { staffNo: 'T1003', realName: '张老师', departmentName: '资产处', status: 'active' },
      adminAuth,
    )
    await clientStaffDirectoryService.setInviteCode(duplicateNameDirectory.record.id, '11223344', adminAuth)
    await expectBizError(
      async () =>
        clientAuthService.register({
          accountType: 'personal',
          staffNo: 'T1003',
          inviteCode: '11223344',
          account: '13800001012',
          password: clientPassword,
          verificationCode: await issueRegisterVerificationCode('13800001012'),
        }),
      '教师注册目录姓名占用',
      '当前注册信息无法使用',
    )
    pass('教师注册目录姓名被占用时返回泛化提示')

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
      clientRequestId: 'department-govern-teacher-001',
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
        username: '后勤处共享账号',
        departmentNodeId: 'dept_logistics',
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
      clientRequestId: 'department-govern-shared-0001',
      isSystemApplied: false,
      pickupContact: '部门共享账号领取',
      items: [{ productId: product.id, qty: 1 }],
    })
    assert.equal(departmentPreorder.order.clientOrderType, 'department')
    assert.equal(departmentPreorder.order.departmentNameSnapshot, '后勤处')
    assert.equal(departmentPreorder.order.staffNoSnapshot, departmentProfile.staffNo)
    pass('管理端创建的部门共享账号可按部门订单下单')

    const longDepartmentProfile = await clientUserManageService.createProfile(
      {
        profileKind: 'department',
        username: '长路径部门共享账号',
        departmentNodeId: 'dept_long_7',
        password: clientPassword,
        status: 'enabled',
      },
      adminAuth,
    ) as ClientManageProfile
    assert.equal(longDepartmentProfile.departmentName, longDepartmentPath)
    const longDepartmentLogin = await clientAuthService.login({
      account: longDepartmentProfile.staffNo ?? '',
      password: clientPassword,
    })
    const longDepartmentAuth = await clientAuthService.resolveClientByToken(longDepartmentLogin.token)
    const longDepartmentPreorder = await o2oPreorderService.submit(longDepartmentAuth, {
      clientRequestId: 'department-govern-long-path-0001',
      isSystemApplied: false,
      pickupContact: '长路径部门共享账号领取',
      items: [{ productId: product.id, qty: 1 }],
    })
    assert.equal(longDepartmentPreorder.order.departmentNameSnapshot, longDepartmentPath)
    const longDepartmentFeedback = await clientFeedbackService.createConversation(
      {
        subject: '长路径部门快照容量验证',
        content: '验证客服会话完整保留部门路径。',
      },
      longDepartmentAuth,
    )
    assert.equal(longDepartmentFeedback.conversation.departmentNameSnapshot, longDepartmentPath)
    await o2oPreorderService.verifyByCode(longDepartmentPreorder.order.verifyCode, adminAuth)
    const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
    const longDepartmentOutboundOrder = await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({
      idempotencyKey: `o2o-preorder-verify:${longDepartmentPreorder.order.id}`,
    })
    assert.equal(longDepartmentOutboundOrder.customerDepartmentName, longDepartmentPath)
    await clientUserManageService.updateStatus(longDepartmentProfile.id, 'disabled', adminAuth)
    pass('超过 128 字符的部门完整路径可贯穿账号、预订单、客服快照与正式出库单')

    const disabledFinanceDepartmentProfile = await clientUserManageService.createProfile(
      {
        profileKind: 'department',
        username: '财务处共享账号',
        departmentNodeId: 'dept_finance',
        password: clientPassword,
        status: 'disabled',
      },
      adminAuth,
    ) as ClientManageProfile

    await expectBizError(
      () => systemConfigService.updateClientDepartmentConfigs(
        {
          tree: [
            { id: 'dept_assets', label: '资产处', children: [] },
            { id: 'dept_logistics', label: '后勤处', children: [] },
            { id: 'dept_finance', label: '财务处', children: [] },
            { id: 'dept_hr', label: '人事处', children: [] },
          ],
        },
        adminAuth,
      ),
      '删除仍绑定启用部门共享账号的部门节点',
      '已启用部门共享账号',
    )
    const configAfterBlockedDepartmentDeletion = await systemConfigService.getClientDepartmentConfigs()
    assert.ok(
      configAfterBlockedDepartmentDeletion.tree.some((node) => node.id === 'dept_it'),
      '删除被启用账号阻断时不得写入半成品部门配置',
    )

    await systemConfigService.updateClientDepartmentConfigs(
      {
        tree: [
          {
            id: 'dept_it',
            label: '信息中心',
            children: [{ id: 'dept_assets', label: '资产中心', children: [] }],
          },
          { id: 'dept_logistics', label: '后勤服务处', children: [] },
          { id: 'dept_hr', label: '人事处', children: [] },
        ],
      },
      adminAuth,
    )
    const renamedAndMovedAssetsAccount = await AppDataSource.getRepository(ClientUser).findOneByOrFail({
      id: firstDepartmentBatch.created[0]!.id,
    })
    assert.equal(renamedAndMovedAssetsAccount.departmentName, '信息中心-资产中心', '部门改名或移动必须按稳定节点ID同步当前共享账号路径')
    const renamedLogisticsAccount = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: departmentProfile.id })
    assert.equal(renamedLogisticsAccount.departmentName, '后勤服务处', '部门改名必须同步当前共享账号路径')
    const orphanedFinanceAccount = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: disabledFinanceDepartmentProfile.id })
    assert.equal(orphanedFinanceAccount.departmentNodeId, 'dept_finance', '停用账号删除所属部门后必须保留历史节点绑定')
    assert.equal(orphanedFinanceAccount.departmentName, '财务处', '停用账号删除所属部门后必须保留历史部门路径')
    assert.equal(orphanedFinanceAccount.status, 'disabled', '停用账号删除所属部门后不得改变状态')
    const persistedDepartmentPreorder = await AppDataSource.getRepository((await import('../src/entities/o2o-preorder.entity.js')).O2oPreorder)
      .findOneByOrFail({ id: departmentPreorder.order.id })
    assert.equal(persistedDepartmentPreorder.departmentNameSnapshot, '后勤处', '部门改名或移动不得改写历史订单部门快照')

    await expectBizError(
      () => clientUserManageService.updateStatus(disabledFinanceDepartmentProfile.id, 'enabled', adminAuth),
      '启用孤立部门共享账号',
      '所属部门已不存在',
    )

    await systemConfigService.updateClientDepartmentConfigs(
      {
        tree: [
          {
            id: 'dept_it',
            label: '信息中心',
            children: [{ id: 'dept_assets', label: '资产中心', children: [] }],
          },
          {
            id: 'dept_hr',
            label: '人事处',
            children: [{ id: 'dept_logistics', label: '后勤服务处', children: [] }],
          },
        ],
      },
      adminAuth,
    )
    const logisticsAccountAfterParentMove = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: departmentProfile.id })
    assert.equal(logisticsAccountAfterParentMove.departmentName, '人事处-后勤服务处', '部门移动到无绑定父节点下时必须同步启用子账号路径')
    await expectBizError(
      () => systemConfigService.updateClientDepartmentConfigs(
        {
          tree: [
            {
              id: 'dept_it',
              label: '信息中心',
              children: [{ id: 'dept_assets', label: '资产中心', children: [] }],
            },
          ],
        },
        adminAuth,
      ),
      '删除无绑定父节点但包含启用共享账号后代',
      '已启用部门共享账号',
    )
    const configAfterBlockedParentDeletion = await systemConfigService.getClientDepartmentConfigs()
    assert.ok(
      configAfterBlockedParentDeletion.tree.some((node) => node.id === 'dept_hr'),
      '父节点删除被启用后代阻断时不得写入半成品部门配置',
    )

    await systemConfigService.updateClientDepartmentConfigs(
      {
        tree: [
          {
            id: 'dept_it',
            label: '信息中心',
            children: [{ id: 'dept_assets', label: '资产中心', children: [] }],
          },
          {
            id: 'dept_hr',
            label: '人事处',
            children: [
              { id: 'dept_logistics', label: '后勤服务处', children: [] },
              { id: 'dept_finance', label: '财务室', children: [] },
            ],
          },
        ],
      },
      adminAuth,
    )
    const rebuiltFinanceAccount = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: disabledFinanceDepartmentProfile.id })
    assert.equal(rebuiltFinanceAccount.departmentName, '人事处-财务室', '孤立部门节点以相同ID重建到新路径后必须同步当前账号路径')
    const enabledRebuiltFinanceAccount = await clientUserManageService.updateStatus(disabledFinanceDepartmentProfile.id, 'enabled', adminAuth)
    assert.equal(enabledRebuiltFinanceAccount.departmentName, '人事处-财务室', '重建节点同步完成后启用账号必须使用当前部门路径')
    const unchangedDepartmentPreorderAfterRebuild = await AppDataSource.getRepository((await import('../src/entities/o2o-preorder.entity.js')).O2oPreorder)
      .findOneByOrFail({ id: departmentPreorder.order.id })
    assert.equal(unchangedDepartmentPreorderAfterRebuild.departmentNameSnapshot, '后勤处', '孤立节点重建或路径同步不得改写历史订单快照')

    await clientUserManageService.updateStatus(disabledFinanceDepartmentProfile.id, 'disabled', adminAuth)
    await systemConfigService.updateClientDepartmentConfigs(
      {
        tree: [
          {
            id: 'dept_it',
            label: '信息中心',
            children: [{ id: 'dept_assets', label: '资产中心', children: [] }],
          },
          {
            id: 'dept_hr',
            label: '人事处',
            children: [{ id: 'dept_logistics', label: '后勤服务处', children: [] }],
          },
        ],
      },
      adminAuth,
    )
    await AppDataSource.getRepository(ClientUserSession).save(
      AppDataSource.getRepository(ClientUserSession).create({
        sessionToken: `session-before-department-rebind-${verifySeed}`,
        userId: disabledFinanceDepartmentProfile.id,
        expiresAt: new Date(Date.now() + 60_000),
        lastAccessAt: new Date(),
      }),
    )
    const reboundFinanceDepartmentProfile = await clientUserManageService.updateProfile(
      disabledFinanceDepartmentProfile.id,
      {
        username: disabledFinanceDepartmentProfile.username,
        departmentNodeId: 'dept_hr',
        status: 'enabled',
      },
      adminAuth,
    )
    assert.equal(
      await AppDataSource.getRepository(ClientUserSession).count({ where: { userId: disabledFinanceDepartmentProfile.id } }),
      0,
      '部门账号归属变更必须在同一事务撤销全部客户端会话',
    )
    assert.equal(reboundFinanceDepartmentProfile.departmentNodeId, 'dept_hr', '重新绑定到有效部门后应允许原子启用')
    assert.equal(reboundFinanceDepartmentProfile.status, 'enabled', '重新绑定到有效部门后应允许原子启用')
    await expectBizError(
      () => clientUserManageService.createProfile(
        {
          profileKind: 'department',
          username: '重复资产处共享账号',
          departmentNodeId: 'dept_assets',
          password: clientPassword,
          status: 'enabled',
        },
        adminAuth,
      ),
      '单个创建重复部门共享账号',
      '该部门已存在共享账号',
    )
    await expectBizError(
      () => clientUserManageService.updateProfile(
        reboundFinanceDepartmentProfile.id,
        {
          username: reboundFinanceDepartmentProfile.username,
          departmentNodeId: 'dept_assets',
          status: 'enabled',
        },
        adminAuth,
      ),
      '编辑改绑已占用部门节点',
      '该部门已存在共享账号',
    )

    const clientUserManageSource = fs.readFileSync(path.join(backendRoot, 'src', 'services', 'client-user-manage.service.ts'), 'utf8')
    const batchStart = clientUserManageSource.indexOf('async createDepartmentAccountsBatch(')
    const batchEnd = clientUserManageSource.indexOf('private async findActiveStaffDirectory', batchStart)
    const batchSource = clientUserManageSource.slice(batchStart, batchEnd)
    assert.match(batchSource, /getClientDepartmentConfigs\(manager, \{ lockForUpdate: true \}\)/, '批量开户写入前必须在同一事务内锁定并重读部门配置')
    assert.match(batchSource, /resolveClientDepartmentNode\(item\.departmentNodeId, manager, latestDepartmentConfig\)/, '批量开户写入必须使用事务内最新部门路径')
    const createProfileStart = clientUserManageSource.indexOf('async createProfile(')
    const createProfileEnd = clientUserManageSource.indexOf('async list(', createProfileStart)
    const createProfileSource = clientUserManageSource.slice(createProfileStart, createProfileEnd)
    const passwordHashBeforeTransaction = createProfileSource.indexOf('const passwordHash = await hashPassword(password)')
    const createProfileTransaction = createProfileSource.indexOf('return await runInTransaction(')
    assert.ok(passwordHashBeforeTransaction >= 0 && passwordHashBeforeTransaction < createProfileTransaction, '单个创建必须在进入事务前预生成密码哈希')
    assert.match(createProfileSource.slice(createProfileTransaction), /passwordHash,/, '单个创建事务内必须复用预生成密码哈希')
    pass('部门共享账号生命周期治理覆盖改名移动、删除门禁、孤立重绑与订单快照边界')

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
        departmentNodeId: null,
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
    const boundDepartmentUser = await AppDataSource.getRepository(ClientUser).save(
      AppDataSource.getRepository(ClientUser).create({
        realName: '已绑定部门共享账号',
        mobile: '13800001005',
        departmentName: '资产处',
        departmentNodeId: 'dept_legacy_bound_to_teacher',
        accountType: 'department',
        staffNo: 'T1002-BOUND',
        staffVerified: true,
        passwordHash: await hashPassword(clientPassword),
        status: 'enabled',
      }),
    )
    await clientStaffDirectoryService.create(
      { staffNo: 'T1002-BOUND', realName: '不应覆盖的教师', departmentName: '信息中心', status: 'active' },
      adminAuth,
    )
    const migrationResult = await migrateLegacyDepartmentAccountsToTeacherProfiles(AppDataSource)
    assert.equal(migrationResult.migratedCount, 1, '只有未绑定的旧部门账号可转为教师账号')
    const migratedLegacyUser = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: legacyUser.id })
    assert.equal(migratedLegacyUser.accountType, 'personal')
    assert.equal(migratedLegacyUser.realName, '王老师')
    assert.equal(migratedLegacyUser.departmentName, '信息中心')
    assert.equal(migratedLegacyUser.departmentNodeId, null, '旧部门账号迁移为教师时必须释放部门节点唯一绑定')
    assert.equal(Boolean(migratedLegacyUser.staffVerified), true)
    const unchangedBoundDepartmentUser = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: boundDepartmentUser.id })
    assert.equal(unchangedBoundDepartmentUser.accountType, 'department', '已绑定的新部门共享账号不能被教师目录误转')
    assert.equal(unchangedBoundDepartmentUser.departmentNodeId, 'dept_legacy_bound_to_teacher', '已绑定的新部门共享账号必须保持原部门节点')
    assert.equal(unchangedBoundDepartmentUser.realName, '已绑定部门共享账号', '已绑定的新部门共享账号不得被目录资料覆盖')
    assert.equal(
      await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: product.id }).then((item) => Number(item.preOrderedStock) > 0),
      true,
      '迁移旧账号不应影响已创建订单与库存占用',
    )
    pass('仅未绑定旧部门账号命中教职工目录后可迁移为教师账号，已绑定账号与历史订单保持不变')
  } finally {
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
