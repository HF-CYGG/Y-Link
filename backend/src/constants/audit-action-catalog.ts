/**
 * 文件说明：backend/src/constants/audit-action-catalog.ts
 * 文件职责：统一维护审计日志的业务类别、动作编码目录、目标对象中文名与默认隐藏动作，供列表筛选、导出与筛选项下发共用。
 * 实现逻辑：
 * - 动作归类优先查精确目录，其次按前缀规则匹配，均未命中时归入“其他”，保证历史日志与未来新增动作都有稳定兜底；
 * - 类别筛选在 SQL 中翻译为“精确 IN + 前缀 LIKE”组合条件，列表与导出共用同一翻译结果；
 * - LIKE 统一使用 `!` 作为转义字符，SQLite 与 MySQL 行为一致，避免反斜杠在 MySQL 字符串字面量中的转义歧义。
 * 维护说明：
 * - 新增审计动作时必须在 AUDIT_ACTION_CATALOG 登记中文名与类别，`audit:catalog:verify` 会扫描源码拦截漏登记；
 * - 各类别前缀不得互相覆盖，否则同一动作会同时落入多个类别。
 */

export const AUDIT_CATEGORY_KEYS = [
  'auth',
  'order_outbound',
  'inbound_supply',
  'product_inventory',
  'customer_service',
  'notification',
  'user_permission',
  'system_config',
  'data_database',
  'other',
] as const

export type AuditCategoryKey = (typeof AUDIT_CATEGORY_KEYS)[number]

interface AuditCategoryDefinition {
  key: AuditCategoryKey
  label: string
  /** 前缀规则：动作编码以该前缀开头即归入本类别（精确目录优先）。 */
  prefixes: readonly string[]
}

export const AUDIT_CATEGORIES: readonly AuditCategoryDefinition[] = [
  { key: 'auth', label: '登录与认证', prefixes: ['auth.', 'client.auth.', 'mobile_auth.'] },
  { key: 'order_outbound', label: '订单与出库', prefixes: ['order.', 'o2o.'] },
  { key: 'inbound_supply', label: '入库与供货', prefixes: ['inbound.'] },
  // 商品与库存当前尚无独立审计动作，预留前缀便于后续接入。
  { key: 'product_inventory', label: '商品与库存', prefixes: ['product.', 'inventory.'] },
  { key: 'customer_service', label: '客服与消息', prefixes: ['customer_service.', 'client_feedback.'] },
  { key: 'notification', label: '通知中心', prefixes: ['notification.'] },
  { key: 'user_permission', label: '用户与权限', prefixes: ['user.', 'client_user.', 'client_staff_directory.', 'security.'] },
  { key: 'system_config', label: '系统配置', prefixes: ['system_config.'] },
  { key: 'data_database', label: '数据维护与数据库', prefixes: ['data_maintenance.', 'database_migration.'] },
  { key: 'other', label: '其他', prefixes: [] },
]

interface AuditActionDefinition {
  label: string
  category: AuditCategoryKey
}

/**
 * 审计动作目录：
 * - label 为筛选项与列表展示使用的通用中文名；同一动作写入时的 actionLabel 可能更具体（如“启用用户/停用用户”）；
 * - category 显式声明，避免仅靠字符串前缀推断。
 */
export const AUDIT_ACTION_CATALOG: Readonly<Record<string, AuditActionDefinition>> = {
  // 登录与认证
  'auth.login': { label: '用户登录', category: 'auth' },
  'auth.logout': { label: '用户退出登录', category: 'auth' },
  'auth.change_password': { label: '本人修改密码', category: 'auth' },
  'auth.guard.locked': { label: '认证请求被临时锁定', category: 'auth' },
  'auth.guard.lock': { label: '登录失败触发临时锁定', category: 'auth' },
  'auth.guard.admin_login': { label: '管理端登录频控', category: 'auth' },
  'auth.guard.admin_captcha': { label: '管理端图形验证码频控', category: 'auth' },
  'client.auth.login': { label: '客户端登录', category: 'auth' },
  'client.auth.guard.captcha': { label: '客户端验证码频控', category: 'auth' },
  'client.auth.guard.staff_directory_lookup': { label: '客户端工号目录查询频控', category: 'auth' },
  'client.auth.guard.verification_send': { label: '验证码发送频控', category: 'auth' },
  'client.auth.guard.register': { label: '客户端注册频控', category: 'auth' },
  'client.auth.guard.forgot_verify': { label: '客户端找回密码校验频控', category: 'auth' },
  'client.auth.guard.forgot_reset': { label: '客户端重置密码频控', category: 'auth' },
  'client.auth.guard.login': { label: '客户端登录频控', category: 'auth' },
  'client.auth.guard.change_password': { label: '客户端修改密码频控', category: 'auth' },
  'client.auth.guard.profile_update': { label: '客户端资料更新频控', category: 'auth' },
  'client.auth.staff_invite.failed': { label: '教师邀请码校验失败', category: 'auth' },
  'client.auth.staff_invite.used': { label: '教师统一邀请码注册成功', category: 'auth' },
  'password_changed': { label: '客户端修改或重置密码', category: 'auth' },
  'mobile_auth.guard.refresh': { label: 'Mobile 刷新令牌频控', category: 'auth' },
  'mobile_login': { label: 'Mobile 登录', category: 'auth' },
  'mobile_register': { label: 'Mobile 注册', category: 'auth' },
  'mobile_refresh': { label: 'Mobile 刷新令牌', category: 'auth' },
  'mobile_logout': { label: 'Mobile 登出', category: 'auth' },
  'mobile_logout_all': { label: 'Mobile 全部登出', category: 'auth' },
  'mobile_session_revoked': { label: 'Mobile 会话撤销', category: 'auth' },
  'account_disabled_session_rejected': { label: '停用账号会话拒绝', category: 'auth' },
  'refresh_replay_detected': { label: '检测到刷新令牌重放', category: 'auth' },

  // 订单与出库
  'order.create': { label: '创建出库单', category: 'order_outbound' },
  'order.delete': { label: '删除出库单', category: 'order_outbound' },
  'order.restore': { label: '恢复出库单', category: 'order_outbound' },
  'order.purge': { label: '永久删除出库单', category: 'order_outbound' },
  'order.amendment': { label: '修订出库单', category: 'order_outbound' },
  'order.content_edit': { label: '编辑出库单内容', category: 'order_outbound' },
  'order.merge': { label: '合并出库单', category: 'order_outbound' },
  'order.merge_failed': { label: '合并出库单失败', category: 'order_outbound' },
  'o2o.preorder.verify': { label: '核销预订单并出库', category: 'order_outbound' },
  'o2o.preorder.update_by_client': { label: '客户端修改订单', category: 'order_outbound' },
  'o2o.preorder.onsite_adjust': { label: '门店现场改单', category: 'order_outbound' },
  'o2o.preorder.customer_order_print': { label: '客户端标记部门订单已打印', category: 'order_outbound' },
  'o2o.preorder.cancel_by_system': { label: '系统超时取消预订单', category: 'order_outbound' },
  'o2o.preorder.cancel_by_client': { label: '客户端撤回预订单', category: 'order_outbound' },
  'o2o.preorder.cancel_by_admin': { label: '管理端取消预订单', category: 'order_outbound' },
  'o2o.preorder.delete': { label: '删除订单池订单', category: 'order_outbound' },
  'o2o.preorder.purge_cancelled': { label: '批量永久删除已取消预订单', category: 'order_outbound' },
  'o2o.preorder.purge_cancelled_batch': { label: '批量永久删除已取消预订单汇总', category: 'order_outbound' },
  'o2o.return_request.create': { label: '客户端提交退货申请', category: 'order_outbound' },
  'o2o.return_request.reject': { label: '拒绝退货申请', category: 'order_outbound' },
  'o2o.return_request.verify': { label: '核销退货申请并回库', category: 'order_outbound' },
  'o2o.order.business_status.set': { label: '设置订单商家特殊状态', category: 'order_outbound' },
  'o2o.order.business_status.change': { label: '变更订单商家特殊状态', category: 'order_outbound' },
  'o2o.order.business_status.clear': { label: '清除订单商家特殊状态', category: 'order_outbound' },
  'o2o.order.merchant_message.set': { label: '设置订单商家留言', category: 'order_outbound' },
  'o2o.order.merchant_message.change': { label: '修改订单商家留言', category: 'order_outbound' },
  'o2o.order.merchant_message.clear': { label: '清空订单商家留言', category: 'order_outbound' },

  // 入库与供货
  'inbound.supplier.create': { label: '供货方创建送货单', category: 'inbound_supply' },
  'inbound.supplier.update': { label: '供货方修改送货单', category: 'inbound_supply' },
  'inbound.supplier.cancel': { label: '供货方撤销送货单', category: 'inbound_supply' },
  'inbound.supplier.delete': { label: '供货方删除送货单', category: 'inbound_supply' },
  'inbound.supplier.restore': { label: '供货方恢复送货单', category: 'inbound_supply' },
  'inbound.supplier.purge': { label: '供货方永久删除送货单', category: 'inbound_supply' },
  'inbound.supplier.delete_verified': { label: '供货方删除已入库送货单并冲销库存', category: 'inbound_supply' },
  'inbound.admin.update': { label: '库管现场修改送货单', category: 'inbound_supply' },
  'inbound.admin.verify': { label: '库管核销入库', category: 'inbound_supply' },

  // 客服与消息
  'client_feedback.create': { label: '客户端提交反馈', category: 'customer_service' },
  'client_feedback.reply_by_client': { label: '客户端追加反馈消息', category: 'customer_service' },
  'client_feedback.confirm_resolved': { label: '客户端确认反馈已解决', category: 'customer_service' },
  'client_feedback.withdraw': { label: '客户端撤回反馈单', category: 'customer_service' },
  'client_feedback.submit_satisfaction': { label: '客户端提交反馈满意度评价', category: 'customer_service' },
  'customer_service.reply': { label: '客服回复反馈消息', category: 'customer_service' },
  'customer_service.update_status': { label: '更新反馈会话状态', category: 'customer_service' },
  'customer_service.update_issue_fields': { label: '更新反馈结构化问题字段', category: 'customer_service' },
  'customer_service.update_internal_remark': { label: '更新反馈内部备注', category: 'customer_service' },
  'customer_service.transfer': { label: '转派反馈负责人', category: 'customer_service' },
  'customer_service.assign': { label: '指派反馈负责人', category: 'customer_service' },
  'customer_service.take_over': { label: '客服接单', category: 'customer_service' },

  // 通知中心
  'notification.rule.update': { label: '更新通知中心规则', category: 'notification' },
  'notification.rule.test_send': { label: '通知规则测试发送', category: 'notification' },
  'notification.rule.matched': { label: '通知规则命中', category: 'notification' },
  'notification.external.dispatch': { label: '通知外发执行', category: 'notification' },
  'notification.event.process': { label: '通知事件处理失败', category: 'notification' },

  // 用户与权限
  'security.access_denied': { label: '接口越权访问拦截', category: 'user_permission' },
  'user.create': { label: '创建用户', category: 'user_permission' },
  'user.update': { label: '编辑用户', category: 'user_permission' },
  'user.update_status': { label: '启停用户', category: 'user_permission' },
  'user.reset_password': { label: '管理员重置密码', category: 'user_permission' },
  'user.deactivate': { label: '注销管理端用户', category: 'user_permission' },
  'user.restore': { label: '恢复管理端用户', category: 'user_permission' },
  'user.permanent_delete': { label: '永久删除管理端用户', category: 'user_permission' },
  'user.bootstrap_admin': { label: '初始化默认管理员', category: 'user_permission' },
  'user.bootstrap_admin.rotate_legacy_password': { label: '迁移默认管理员历史默认口令', category: 'user_permission' },
  'client_user.create': { label: '新增客户端用户', category: 'user_permission' },
  'client_user.create_department_accounts_batch': { label: '批量创建部门共享账号', category: 'user_permission' },
  'client_user.update_status': { label: '启停客户端用户', category: 'user_permission' },
  'client_user.update_profile': { label: '编辑客户端用户资料', category: 'user_permission' },
  'client_user.reset_password': { label: '重置客户端用户密码', category: 'user_permission' },
  'client_user.deactivate': { label: '注销客户端用户', category: 'user_permission' },
  'client_user.restore': { label: '恢复客户端用户', category: 'user_permission' },
  'client_user.permanent_delete': { label: '永久删除客户端用户', category: 'user_permission' },
  'client_user.verify_contact': { label: '客户端认证联系方式', category: 'user_permission' },
  'client_staff_directory.create': { label: '新增教职工目录记录', category: 'user_permission' },
  'client_staff_directory.update': { label: '编辑教职工目录记录', category: 'user_permission' },
  'client_staff_directory.update_status': { label: '启停教职工目录记录', category: 'user_permission' },
  'client_staff_directory.batch_delete': { label: '批量删除教职工目录记录', category: 'user_permission' },
  'client_staff_directory.import': { label: '批量导入教职工目录', category: 'user_permission' },

  // 系统配置
  'system_config.update_order_serial': { label: '更新订单流水配置', category: 'system_config' },
  'system_config.update_o2o_rules': { label: '更新线上预订规则配置', category: 'system_config' },
  'system_config.update_customer_service': { label: '更新客服中心配置', category: 'system_config' },
  'system_config.update_client_departments': { label: '更新客户端部门配置', category: 'system_config' },
  'system_config.ensure_client_departments': { label: '自动补齐客户端部门配置', category: 'system_config' },
  'system_config.update_verification_providers': { label: '更新验证码平台配置', category: 'system_config' },
  'system_config.test_verification_provider': { label: '测试验证码平台发送', category: 'system_config' },
  'system_config.staff_invite.set': { label: '设置教师统一邀请码', category: 'system_config' },
  'system_config.staff_invite.disable': { label: '禁用教师统一邀请码', category: 'system_config' },
  'system_config.staff_invite.forbidden': { label: '统一教师邀请码维护越权拦截', category: 'system_config' },

  // 数据维护与数据库
  'data_maintenance.backup_sqlite': { label: '创建 SQLite 物理备份', category: 'data_database' },
  'data_maintenance.export_json': { label: '导出 JSON 数据', category: 'data_database' },
  'data_maintenance.import_json': { label: '导入 JSON 数据', category: 'data_database' },
  'database_migration.create_task': { label: '创建 SQLite 转 MySQL 迁移任务', category: 'data_database' },
  'database_migration.create_automatic_task': { label: '创建一键自动数据库迁移任务', category: 'data_database' },
  'database_migration.run_task': { label: '执行 SQLite 转 MySQL 迁移任务', category: 'data_database' },
  'database_migration.run_task_failed': { label: 'SQLite 转 MySQL 迁移任务执行失败', category: 'data_database' },
  'database_migration.run_automatic_task_failed': { label: '一键自动数据库迁移失败', category: 'data_database' },
  'database_migration.automatic_rolled_back': { label: 'SQLite 一键自动迁移已紧急回退', category: 'data_database' },
  'database_migration.automatic_succeeded': { label: 'SQLite 一键自动迁移成功', category: 'data_database' },
  'database_migration.apply_switch': { label: '应用数据库切换覆盖配置', category: 'data_database' },
  'database_migration.rollback_switch': { label: '回退数据库切换覆盖配置', category: 'data_database' },
  'database_migration.clear_override': { label: '清理数据库运行时覆盖配置', category: 'data_database' },
}

/** 审计目标对象中文名：未登记的目标类型在页面上回退显示原始编码。 */
export const AUDIT_TARGET_TYPE_LABELS: Readonly<Record<string, string>> = {
  api_route: '接口路由',
  security_guard: '安全频控',
  session: '管理端会话',
  user: '管理端用户',
  client_user: '客户端用户',
  client_user_batch: '客户端用户批量操作',
  client_session: '客户端会话',
  client_mobile_session: 'Mobile 会话',
  client_staff_directory: '教职工目录',
  system_config: '系统配置',
  verification_provider: '验证码平台',
  data_maintenance: '数据维护',
  database_migration: '数据库迁移',
  database_runtime_override: '运行时覆盖',
  feedback_conversation: '反馈会话',
  order: '出库单',
  biz_inbound_order: '入库送货单',
  o2o_order: '线上预订单',
  o2o_order_batch: '预订单批量操作',
  o2o_return_request: '退货申请',
  notification_rule: '通知规则',
  notification_event: '通知事件',
}

/**
 * 默认隐藏的通知内部处理记录：
 * - 同一通知事件的规则命中、外发执行与重试失败记录会在“通知事件”页签按 eventId 聚合展示；
 * - 操作日志未选择业务类别与操作类型时不展示这些记录；选择“通知中心”或具体动作时仍可完整查询。
 */
export const AUDIT_DEFAULT_HIDDEN_ACTION_TYPES = [
  'notification.rule.matched',
  'notification.external.dispatch',
  'notification.event.process',
] as const

const CATEGORY_LABEL_MAP = new Map(AUDIT_CATEGORIES.map((item) => [item.key, item.label]))

export const isAuditCategoryKey = (value: unknown): value is AuditCategoryKey =>
  typeof value === 'string' && (AUDIT_CATEGORY_KEYS as readonly string[]).includes(value)

export const getAuditCategoryLabel = (key: AuditCategoryKey) => CATEGORY_LABEL_MAP.get(key) ?? '其他'

/** 按前缀规则归类（不查精确目录），取最长匹配前缀。 */
const resolveAuditCategoryByPrefix = (actionType: string): AuditCategoryKey => {
  let matched: AuditCategoryKey = 'other'
  let matchedLength = 0
  for (const category of AUDIT_CATEGORIES) {
    for (const prefix of category.prefixes) {
      if (actionType.startsWith(prefix) && prefix.length > matchedLength) {
        matched = category.key
        matchedLength = prefix.length
      }
    }
  }
  return matched
}

/** 动作归类：精确目录优先，其次最长前缀，均未命中归入“其他”。 */
export const resolveAuditCategory = (actionType: string): AuditCategoryKey =>
  AUDIT_ACTION_CATALOG[actionType]?.category ?? resolveAuditCategoryByPrefix(actionType)

export const getAuditActionTypeLabel = (actionType: string) => AUDIT_ACTION_CATALOG[actionType]?.label ?? null

/** LIKE 前缀转义：统一使用 `!` 作为转义字符，SQLite 与 MySQL 行为一致。 */
export const escapeAuditLikePrefix = (prefix: string) => `${prefix.replaceAll(/[!%_]/g, (char) => `!${char}`)}%`

/**
 * 预计算每个类别的 SQL 片段组成：
 * - includes：显式归入本类别、但前缀规则不指向本类别的精确动作；
 * - excludes：前缀规则指向本类别、但显式归入其他类别的精确动作。
 */
const CATEGORY_SQL_PARTS = new Map<AuditCategoryKey, { includes: string[]; excludes: string[]; prefixes: readonly string[] }>(
  AUDIT_CATEGORIES.filter((item) => item.key !== 'other').map((category) => {
    const includes: string[] = []
    const excludes: string[] = []
    for (const [actionType, definition] of Object.entries(AUDIT_ACTION_CATALOG)) {
      const prefixCategory = resolveAuditCategoryByPrefix(actionType)
      if (definition.category === category.key && prefixCategory !== category.key) {
        includes.push(actionType)
      }
      if (prefixCategory === category.key && definition.category !== category.key) {
        excludes.push(actionType)
      }
    }
    return [category.key, { includes, excludes, prefixes: category.prefixes }]
  }),
)

/**
 * 构造单个非“其他”类别的条件片段；参数名带类别前缀，避免与同一查询中的其他条件冲突。
 * 返回 null 表示该类别当前没有任何可命中的规则（例如预留类别无精确动作也无前缀）。
 */
const buildSingleCategoryCondition = (column: string, key: Exclude<AuditCategoryKey, 'other'>) => {
  const parts = CATEGORY_SQL_PARTS.get(key)
  if (!parts) {
    return null
  }
  const params: Record<string, unknown> = {}
  const orClauses: string[] = []
  if (parts.includes.length) {
    const name = `auditCat_${key}_includes`
    params[name] = parts.includes
    orClauses.push(`${column} IN (:...${name})`)
  }
  if (parts.prefixes.length) {
    const likeClauses = parts.prefixes.map((prefix, index) => {
      const name = `auditCat_${key}_prefix${index}`
      params[name] = escapeAuditLikePrefix(prefix)
      return `${column} LIKE :${name} ESCAPE '!'`
    })
    let prefixClause = `(${likeClauses.join(' OR ')})`
    if (parts.excludes.length) {
      const name = `auditCat_${key}_excludes`
      params[name] = parts.excludes
      prefixClause = `(${prefixClause} AND ${column} NOT IN (:...${name}))`
    }
    orClauses.push(prefixClause)
  }
  if (!orClauses.length) {
    return null
  }
  return { sql: `(${orClauses.join(' OR ')})`, params }
}

/**
 * 构造业务类别筛选条件：
 * - 普通类别：精确 IN 与前缀 LIKE 的组合；
 * - “其他”：不命中任何非“其他”类别条件的动作，历史未登记动作与未来新增动作都会落在这里。
 */
export const buildAuditCategoryCondition = (column: string, key: AuditCategoryKey): { sql: string; params: Record<string, unknown> } => {
  if (key !== 'other') {
    // 没有任何规则的预留类别返回恒假条件，保证筛选结果为空而不是退化成全部日志。
    return buildSingleCategoryCondition(column, key) ?? { sql: '1 = 0', params: {} }
  }
  const params: Record<string, unknown> = {}
  const clauses: string[] = []
  for (const category of AUDIT_CATEGORIES) {
    if (category.key === 'other') continue
    const condition = buildSingleCategoryCondition(column, category.key)
    if (!condition) continue
    clauses.push(condition.sql)
    Object.assign(params, condition.params)
  }
  if (!clauses.length) {
    return { sql: '1 = 1', params }
  }
  return { sql: `NOT (${clauses.join(' OR ')})`, params }
}
