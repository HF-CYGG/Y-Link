/**
 * 模块说明：backend/src/services/system-config.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { AppDataSource } from '../config/data-source.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const DEFAULT_SYSTEM_CONFIGS = [
  {
    configKey: 'order.serial.department.start',
    configValue: '1',
    configGroup: 'order_serial',
    remark: '部门单号起始值',
  },
  {
    configKey: 'order.serial.department.current',
    configValue: '0',
    configGroup: 'order_serial',
    remark: '部门单号当前值',
  },
  {
    configKey: 'order.serial.department.width',
    configValue: '6',
    configGroup: 'order_serial',
    remark: '部门单号位宽',
  },
  {
    configKey: 'order.serial.walkin.start',
    configValue: '1',
    configGroup: 'order_serial',
    remark: '散客单号起始值',
  },
  {
    configKey: 'order.serial.walkin.current',
    configValue: '0',
    configGroup: 'order_serial',
    remark: '散客单号当前值',
  },
  {
    configKey: 'order.serial.walkin.width',
    configValue: '6',
    configGroup: 'order_serial',
    remark: '散客单号位宽',
  },
  {
    configKey: 'client.department.options',
    configValue: '[]',
    configGroup: 'client',
    remark: '客户端可选部门列表(JSON数组)',
  },
  {
    configKey: 'o2o.auto_cancel_enabled',
    configValue: '1',
    configGroup: 'o2o',
    remark: '预订单超时自动取消开关',
  },
  {
    configKey: 'o2o.auto_cancel_hours',
    configValue: '24',
    configGroup: 'o2o',
    remark: '预订单超时自动取消时长（小时）',
  },
  {
    configKey: 'o2o.limit_enabled',
    configValue: '1',
    configGroup: 'o2o',
    remark: '预订单限购开关',
  },
  {
    configKey: 'o2o.limit_qty',
    configValue: '5',
    configGroup: 'o2o',
    remark: '预订单默认限购数量',
  },
  {
    configKey: 'o2o.client_preorder_update_limit',
    configValue: '3',
    configGroup: 'o2o',
    remark: '客户端单笔预订单最大可修改次数',
  },
  {
    configKey: 'verification.mobile.enabled',
    configValue: '0',
    configGroup: 'verification',
    remark: '短信验证码平台启用开关',
  },
  {
    configKey: 'verification.mobile.http_method',
    configValue: 'POST',
    configGroup: 'verification',
    remark: '短信验证码平台请求方法',
  },
  {
    configKey: 'verification.mobile.api_url',
    configValue: '',
    configGroup: 'verification',
    remark: '短信验证码平台请求地址',
  },
  {
    configKey: 'verification.mobile.headers_template',
    configValue: '{"Content-Type":"application/json"}',
    configGroup: 'verification',
    remark: '短信验证码平台请求头模板(JSON)',
  },
  {
    configKey: 'verification.mobile.body_template',
    configValue: '{"mobile":"{{target}}","code":"{{code}}","scene":"{{scene}}"}',
    configGroup: 'verification',
    remark: '短信验证码平台请求体模板(JSON)',
  },
  {
    configKey: 'verification.mobile.success_match',
    configValue: '',
    configGroup: 'verification',
    remark: '短信验证码平台成功关键字（可选）',
  },
  {
    configKey: 'verification.email.enabled',
    configValue: '0',
    configGroup: 'verification',
    remark: '邮箱验证码平台启用开关',
  },
  {
    configKey: 'verification.email.http_method',
    configValue: 'POST',
    configGroup: 'verification',
    remark: '邮箱验证码平台请求方法',
  },
  {
    configKey: 'verification.email.api_url',
    configValue: '',
    configGroup: 'verification',
    remark: '邮箱验证码平台请求地址',
  },
  {
    configKey: 'verification.email.headers_template',
    configValue: '{"Content-Type":"application/json"}',
    configGroup: 'verification',
    remark: '邮箱验证码平台请求头模板(JSON)',
  },
  {
    configKey: 'verification.email.body_template',
    configValue: '{"email":"{{target}}","subject":"Y-Link 验证码","content":"您的验证码为 {{code }}，场景：{{scene}}。5 分钟内有效。"}',
    configGroup: 'verification',
    remark: '邮箱验证码平台请求体模板(JSON)',
  },
  {
    configKey: 'verification.email.success_match',
    configValue: '',
    configGroup: 'verification',
    remark: '邮箱验证码平台成功关键字（可选）',
  },
] as const

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const ORDER_SERIAL_TYPES = ['department', 'walkin'] as const
type OrderSerialType = (typeof ORDER_SERIAL_TYPES)[number]

const ORDER_SERIAL_META: Record<OrderSerialType, { label: string; prefix: string; keyPrefix: string }> = {
  department: {
    label: '部门订单',
    prefix: 'hyyzjd',
    keyPrefix: 'order.serial.department',
  },
  walkin: {
    label: '散客订单',
    prefix: 'hyyz',
    keyPrefix: 'order.serial.walkin',
  },
}

export interface OrderSerialConfigValue {
  start: number
  current: number
  width: number
}

export interface OrderSerialConfigRecord extends OrderSerialConfigValue {
  orderType: OrderSerialType
  orderTypeLabel: string
  prefix: string
  updatedAt: Date
}

export interface UpdateOrderSerialConfigsInput {
  department: OrderSerialConfigValue
  walkin: OrderSerialConfigValue
}

export interface O2oRuleConfigRecord {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  clientPreorderUpdateLimit: number
  updatedAt: Date
}

export interface UpdateO2oRuleConfigsInput {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  clientPreorderUpdateLimit?: number
}

export type VerificationChannelType = 'mobile' | 'email'

export interface VerificationProviderConfigRecord {
  enabled: boolean
  httpMethod: 'POST' | 'GET'
  apiUrl: string
  headersTemplate: string
  bodyTemplate: string
  successMatch: string
  updatedAt: Date
}

export interface VerificationProviderConfigsResult {
  mobile: VerificationProviderConfigRecord
  email: VerificationProviderConfigRecord
}

export interface VerificationProviderConfigInput {
  enabled: boolean
  httpMethod: 'POST' | 'GET'
  apiUrl: string
  headersTemplate: string
  bodyTemplate: string
  successMatch: string
}

export interface UpdateVerificationProviderConfigsInput {
  mobile: VerificationProviderConfigInput
  email: VerificationProviderConfigInput
}

export interface ClientDepartmentConfigRecord {
  tree: ClientDepartmentTreeNode[]
  options: string[]
  updatedAt: Date
}

export interface ClientDepartmentTreeNode {
  id: string
  label: string
  children: ClientDepartmentTreeNode[]
}

export interface UpdateClientDepartmentConfigsInput {
  tree?: ClientDepartmentTreeNode[]
  options?: string[]
}

class SystemConfigService {
  private readonly configRepo = AppDataSource.getRepository(SystemConfig)
  private readonly o2oConfigKeys = [
    'o2o.auto_cancel_enabled',
    'o2o.auto_cancel_hours',
    'o2o.limit_enabled',
    'o2o.limit_qty',
    'o2o.client_preorder_update_limit',
  ] as const
  private readonly clientDepartmentConfigKey = 'client.department.options'
  private readonly verificationConfigKeys = [
    'verification.mobile.enabled',
    'verification.mobile.http_method',
    'verification.mobile.api_url',
    'verification.mobile.headers_template',
    'verification.mobile.body_template',
    'verification.mobile.success_match',
    'verification.email.enabled',
    'verification.email.http_method',
    'verification.email.api_url',
    'verification.email.headers_template',
    'verification.email.body_template',
    'verification.email.success_match',
  ] as const

  /**
   * 系统治理配置写操作强制管理员：
   * - 与路由层 requireRole('admin') 形成双重门禁；
   * - 若发生越权调用，统一记录失败审计，便于后续排查权限绕过或路由误配。
   */
  private async assertAdminActor(actor: AuthUserContext, requestMeta: RequestMeta | undefined, actionType: string, actionLabel: string) {
    if (actor.role === 'admin') {
      return
    }
    await auditService.safeRecord({
      actionType,
      actionLabel: `${actionLabel}（越权拦截）`,
      targetType: 'system_config',
      targetCode: actionType,
      actor,
      requestMeta,
      resultStatus: 'failed',
      detail: {
        reason: 'role_mismatch',
        requiredRole: 'admin',
        actualRole: actor.role,
      },
    })
    throw new BizError('当前账号无权执行该操作', 403)
  }

  private getOrderSerialAllKeys(): string[] {
    return ORDER_SERIAL_TYPES.flatMap((orderType) => {
      const keyPrefix = ORDER_SERIAL_META[orderType].keyPrefix
      return [`${keyPrefix}.start`, `${keyPrefix}.current`, `${keyPrefix}.width`]
    })
  }

  private parsePositiveInteger(value: string, field: string) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BizError(`${field} 配置值非法`, 500)
    }
    return parsed
  }

  private parseNonNegativeInteger(value: string, field: string) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BizError(`${field} 配置值非法`, 500)
    }
    return parsed
  }

  private createDepartmentNodeId(seed: string) {
    const normalizedSeed = seed.trim().replaceAll(/\s+/g, '-').slice(0, 24)
    return `dept_${normalizedSeed || 'node'}_${Math.random().toString(36).slice(2, 8)}`
  }

  private normalizeDepartmentLabel(value: unknown) {
    const label = typeof value === 'string' ? value.trim() : ''
    if (!label) {
      throw new BizError('部门名称不能为空', 400)
    }
    if (label.length > 32) {
      throw new BizError('部门名称长度不能超过 32 个字符', 400)
    }
    return label
  }

  private buildTreeFromOptions(options: string[]): ClientDepartmentTreeNode[] {
    return options.map((label, index) => ({
      id: this.createDepartmentNodeId(`${label}-${index + 1}`),
      label,
      children: [],
    }))
  }

  private flattenDepartmentTree(tree: ClientDepartmentTreeNode[]): string[] {
    const labels: string[] = []
    const walk = (nodes: ClientDepartmentTreeNode[], parentPath = '') => {
      nodes.forEach((node) => {
        const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
        labels.push(currentPath)
        if (node.children.length > 0) {
          walk(node.children, currentPath)
        }
      })
    }
    walk(tree)
    return labels
  }

  private findDepartmentPathsByLabel(tree: ClientDepartmentTreeNode[], targetLabel: string): string[] {
    const paths: string[] = []
    const walk = (nodes: ClientDepartmentTreeNode[], parentPath = '') => {
      nodes.forEach((node) => {
        const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
        if (node.label === targetLabel) {
          paths.push(currentPath)
        }
        if (node.children.length > 0) {
          walk(node.children, currentPath)
        }
      })
    }
    walk(tree)
    return paths
  }

  private normalizeClientDepartmentOptions(options: string[]): string[] {
    const normalizedList = options
      .map((item) => this.normalizeDepartmentLabel(item))
      .filter((item) => item.length > 0)

    if (normalizedList.length > 50) {
      throw new BizError('部门节点总数最多保留 50 个', 400)
    }

    const uniqueSet = new Set<string>()
    for (const item of normalizedList) {
      if (uniqueSet.has(item)) {
        throw new BizError(`部门“${item}”重复，请去重后保存`, 400)
      }
      uniqueSet.add(item)
    }
    return [...uniqueSet]
  }

  private normalizeClientDepartmentTree(tree: ClientDepartmentTreeNode[], depth = 1): ClientDepartmentTreeNode[] {
    if (depth > 8) {
      throw new BizError('部门层级最多支持 8 级', 400)
    }
    return tree.map((node, index) => {
      const label = this.normalizeDepartmentLabel(node.label)
      const id = String(node.id ?? '').trim() || this.createDepartmentNodeId(`${label}-${depth}-${index + 1}`)
      const children = Array.isArray(node.children) ? this.normalizeClientDepartmentTree(node.children, depth + 1) : []
      return {
        id,
        label,
        children,
      }
    })
  }

  private parseClientDepartmentConfig(rawValue: string): { tree: ClientDepartmentTreeNode[]; options: string[] } {
    const raw = rawValue.trim()
    if (!raw) {
      return { tree: [], options: [] }
    }
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        const options = this.normalizeClientDepartmentOptions(parsed)
        return {
          tree: this.buildTreeFromOptions(options),
          options,
        }
      }

      let rawTree: unknown[] | null = null
      if (Array.isArray(parsed)) {
        rawTree = parsed
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tree?: unknown[] }).tree)) {
        rawTree = (parsed as { tree: unknown[] }).tree
      }
      if (!rawTree) {
        throw new BizError('客户端部门配置格式非法', 500)
      }

      const tree = this.normalizeClientDepartmentTree(
        rawTree.map((item) => {
          const node = item as Partial<ClientDepartmentTreeNode> & { name?: string; title?: string }
          return {
            id: String(node.id ?? '').trim(),
            label: String(node.label ?? node.name ?? node.title ?? '').trim(),
            children: Array.isArray(node.children) ? node.children : [],
          }
        }),
      )
      const options = this.normalizeClientDepartmentOptions(this.flattenDepartmentTree(tree))
      return { tree, options }
    } catch {
      throw new BizError('客户端部门配置格式非法', 500)
    }
  }

  private validateInputValue(orderType: OrderSerialType, value: OrderSerialConfigValue) {
    if (!Number.isInteger(value.start) || value.start <= 0) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}起始号必须为正整数`, 400)
    }
    if (!Number.isInteger(value.current) || value.current < 0) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}当前号必须为非负整数`, 400)
    }
    if (!Number.isInteger(value.width) || value.width <= 0 || value.width > 12) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}位宽必须为 1 到 12 的整数`, 400)
    }

    if (value.current < value.start - 1) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}当前号不能小于起始号减一`, 400)
    }

    const maxValue = 10 ** value.width - 1
    if (value.start > maxValue || value.current > maxValue) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}起始号或当前号超过位宽上限`, 400)
    }
  }

  private formatVerificationProviderConfig(
    channel: VerificationChannelType,
    configMap: Map<string, Pick<SystemConfig, 'configValue' | 'updatedAt'>>,
  ): VerificationProviderConfigRecord {
    const keyPrefix = `verification.${channel}`
    const enabledConfig = configMap.get(`${keyPrefix}.enabled`)
    const methodConfig = configMap.get(`${keyPrefix}.http_method`)
    const urlConfig = configMap.get(`${keyPrefix}.api_url`)
    const headersConfig = configMap.get(`${keyPrefix}.headers_template`)
    const bodyConfig = configMap.get(`${keyPrefix}.body_template`)
    const successConfig = configMap.get(`${keyPrefix}.success_match`)
    if (!enabledConfig || !methodConfig || !urlConfig || !headersConfig || !bodyConfig || !successConfig) {
      throw new BizError('验证码平台配置缺失，请联系管理员补齐配置', 500)
    }

    const httpMethod = methodConfig.configValue === 'GET' ? 'GET' : 'POST'
    const updatedAt = [
      enabledConfig.updatedAt,
      methodConfig.updatedAt,
      urlConfig.updatedAt,
      headersConfig.updatedAt,
      bodyConfig.updatedAt,
      successConfig.updatedAt,
    ].sort((a, b) => b.getTime() - a.getTime())[0]

    return {
      enabled: this.parseNonNegativeInteger(enabledConfig.configValue, `${keyPrefix}.enabled`) > 0,
      httpMethod,
      apiUrl: urlConfig.configValue,
      headersTemplate: headersConfig.configValue,
      bodyTemplate: bodyConfig.configValue,
      successMatch: successConfig.configValue,
      updatedAt,
    }
  }

  private formatConfigRecord(
    orderType: OrderSerialType,
    configMap: Map<string, Pick<SystemConfig, 'configValue' | 'updatedAt'>>,
  ): OrderSerialConfigRecord {
    const keyPrefix = ORDER_SERIAL_META[orderType].keyPrefix
    const startKey = `${keyPrefix}.start`
    const currentKey = `${keyPrefix}.current`
    const widthKey = `${keyPrefix}.width`
    const startConfig = configMap.get(startKey)
    const currentConfig = configMap.get(currentKey)
    const widthConfig = configMap.get(widthKey)

    if (!startConfig || !currentConfig || !widthConfig) {
      throw new BizError('订单流水配置缺失，请联系管理员补齐配置', 500)
    }

    const start = this.parsePositiveInteger(startConfig.configValue, `${startKey}`)
    const current = this.parseNonNegativeInteger(currentConfig.configValue, `${currentKey}`)
    const width = this.parsePositiveInteger(widthConfig.configValue, `${widthKey}`)
    const updatedAt = [startConfig.updatedAt, currentConfig.updatedAt, widthConfig.updatedAt].sort(
      (prev, next) => next.getTime() - prev.getTime(),
    )[0]

    return {
      orderType,
      orderTypeLabel: ORDER_SERIAL_META[orderType].label,
      prefix: ORDER_SERIAL_META[orderType].prefix,
      start,
      current,
      width,
      updatedAt,
    }
  }

  async ensureDefaultConfigs(): Promise<{ insertedCount: number; totalCount: number }> {
    const existingConfigs = await this.configRepo.find({
      where: DEFAULT_SYSTEM_CONFIGS.map((config) => ({ configKey: config.configKey })),
      select: {
        configKey: true,
      },
    })
    const existingKeySet = new Set(existingConfigs.map((config) => config.configKey))
    const missingConfigs = DEFAULT_SYSTEM_CONFIGS.filter((config) => !existingKeySet.has(config.configKey))

    if (missingConfigs.length > 0) {
      await this.configRepo.insert(missingConfigs)
    }

    return {
      insertedCount: missingConfigs.length,
      totalCount: DEFAULT_SYSTEM_CONFIGS.length,
    }
  }

  async getOrderSerialConfigs(): Promise<{ list: OrderSerialConfigRecord[] }> {
    await this.ensureDefaultConfigs()

    const keys = this.getOrderSerialAllKeys()
    const rows = await this.configRepo.find({
      where: keys.map((key) => ({ configKey: key })),
      select: {
        configKey: true,
        configValue: true,
        updatedAt: true,
      },
    })

    const configMap = new Map(rows.map((row) => [row.configKey, row]))
    const list = ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, configMap))
    return { list }
  }

  async updateOrderSerialConfigs(
    input: UpdateOrderSerialConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ list: OrderSerialConfigRecord[]; changed: boolean }> {
    await this.assertAdminActor(actor, requestMeta, 'system_config.update_order_serial', '更新订单流水配置')
    this.validateInputValue('department', input.department)
    this.validateInputValue('walkin', input.walkin)
    await this.ensureDefaultConfigs()

    return AppDataSource.transaction(async (manager) => {
      const keys = this.getOrderSerialAllKeys()
      const placeholders = keys.map(() => '?').join(', ')
      const useForUpdate = manager.connection.options.type === 'mysql'
      const lockedRows: Array<{ id: string; configKey: string; configValue: string; updatedAt: string }> = await manager.query(
        `
          SELECT id, config_key AS configKey, config_value AS configValue, updated_at AS updatedAt
          FROM system_configs
          WHERE config_key IN (${placeholders})
          ${useForUpdate ? 'FOR UPDATE' : ''}
        `,
        keys,
      )

      if (lockedRows.length !== keys.length) {
        throw new BizError('订单流水配置缺失，请联系管理员补齐配置', 500)
      }

      const rowMap = new Map(
        lockedRows.map((row) => [
          row.configKey,
          {
            id: row.id,
            configKey: row.configKey,
            configValue: row.configValue,
            updatedAt: new Date(row.updatedAt),
          },
        ]),
      )

      const beforeList = ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, rowMap))
      const targetMap = new Map<string, string>()

      ORDER_SERIAL_TYPES.forEach((orderType) => {
        const payload = input[orderType]
        const keyPrefix = ORDER_SERIAL_META[orderType].keyPrefix
        targetMap.set(`${keyPrefix}.start`, String(payload.start))
        targetMap.set(`${keyPrefix}.current`, String(payload.current))
        targetMap.set(`${keyPrefix}.width`, String(payload.width))
      })

      let changedCount = 0
      for (const [configKey, targetValue] of targetMap) {
        const currentRow = rowMap.get(configKey)
        if (!currentRow || currentRow.configValue === targetValue) {
          continue
        }

        await manager.getRepository(SystemConfig).update({ id: currentRow.id }, { configValue: targetValue })
        currentRow.configValue = targetValue
        currentRow.updatedAt = new Date()
        changedCount += 1
      }

      const afterList = ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, rowMap))

      if (changedCount > 0) {
        await auditService.record(
          {
            actionType: 'system_config.update_order_serial',
            actionLabel: '更新订单流水配置',
            targetType: 'system_config',
            targetCode: 'order_serial',
            actor,
            requestMeta,
            detail: {
              before: beforeList,
              after: afterList,
            },
          },
          manager,
        )
      }

      return {
        list: afterList,
        changed: changedCount > 0,
      }
    })
  }

  async getO2oRuleConfigs(): Promise<O2oRuleConfigRecord> {
    await this.ensureDefaultConfigs()
    const rows = await this.configRepo.find({
      where: this.o2oConfigKeys.map((key) => ({ configKey: key })),
      select: {
        configKey: true,
        configValue: true,
        updatedAt: true,
      },
    })

    if (rows.length !== this.o2oConfigKeys.length) {
      throw new BizError('线上预订配置缺失，请联系管理员补齐配置', 500)
    }

    const map = new Map(rows.map((row) => [row.configKey, row]))
    const autoCancelEnabled = this.parseNonNegativeInteger(map.get('o2o.auto_cancel_enabled')!.configValue, 'o2o.auto_cancel_enabled') > 0
    const autoCancelHours = this.parsePositiveInteger(map.get('o2o.auto_cancel_hours')!.configValue, 'o2o.auto_cancel_hours')
    const limitEnabled = this.parseNonNegativeInteger(map.get('o2o.limit_enabled')!.configValue, 'o2o.limit_enabled') > 0
    const limitQty = this.parsePositiveInteger(map.get('o2o.limit_qty')!.configValue, 'o2o.limit_qty')
    const clientPreorderUpdateLimit = this.parsePositiveInteger(
      map.get('o2o.client_preorder_update_limit')!.configValue,
      'o2o.client_preorder_update_limit',
    )
    const updatedAt = rows.map((row) => row.updatedAt).sort((a, b) => b.getTime() - a.getTime())[0]

    return {
      autoCancelEnabled,
      autoCancelHours,
      limitEnabled,
      limitQty,
      clientPreorderUpdateLimit,
      updatedAt,
    }
  }

  async updateO2oRuleConfigs(
    input: UpdateO2oRuleConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ config: O2oRuleConfigRecord; changed: boolean }> {
    await this.assertAdminActor(actor, requestMeta, 'system_config.update_o2o_rules', '更新线上预订规则配置')
    if (!Number.isInteger(input.autoCancelHours) || input.autoCancelHours <= 0 || input.autoCancelHours > 168) {
      throw new BizError('超时取消时长必须为 1 到 168 小时', 400)
    }
    if (!Number.isInteger(input.limitQty) || input.limitQty <= 0 || input.limitQty > 999) {
      throw new BizError('限购数量必须为 1 到 999 的整数', 400)
    }
    if (
      input.clientPreorderUpdateLimit !== undefined
      && (
        !Number.isInteger(input.clientPreorderUpdateLimit)
        || input.clientPreorderUpdateLimit <= 0
        || input.clientPreorderUpdateLimit > 999
      )
    ) {
      throw new BizError('客户端改单次数上限必须为 1 到 999 的整数', 400)
    }

    await this.ensureDefaultConfigs()
    return AppDataSource.transaction(async (manager) => {
      const useForUpdate = manager.connection.options.type === 'mysql'
      const placeholders = this.o2oConfigKeys.map(() => '?').join(', ')
      const lockedRows: Array<{ id: string; configKey: string; configValue: string; updatedAt: string }> = await manager.query(
        `
          SELECT id, config_key AS configKey, config_value AS configValue, updated_at AS updatedAt
          FROM system_configs
          WHERE config_key IN (${placeholders})
          ${useForUpdate ? 'FOR UPDATE' : ''}
        `,
        [...this.o2oConfigKeys],
      )

      if (lockedRows.length !== this.o2oConfigKeys.length) {
        throw new BizError('线上预订配置缺失，请联系管理员补齐配置', 500)
      }

      const targetMap = new Map<string, string>([
        ['o2o.auto_cancel_enabled', input.autoCancelEnabled ? '1' : '0'],
        ['o2o.auto_cancel_hours', String(input.autoCancelHours)],
        ['o2o.limit_enabled', input.limitEnabled ? '1' : '0'],
        ['o2o.limit_qty', String(input.limitQty)],
      ])
      if (input.clientPreorderUpdateLimit !== undefined) {
        targetMap.set('o2o.client_preorder_update_limit', String(input.clientPreorderUpdateLimit))
      }

      const before = await this.getO2oRuleConfigs()
      let changed = false
      const repo = manager.getRepository(SystemConfig)
      for (const row of lockedRows) {
        const targetValue = targetMap.get(row.configKey)
        if (!targetValue || targetValue === row.configValue) {
          continue
        }
        await repo.update({ id: row.id }, { configValue: targetValue })
        changed = true
      }

      const config = await this.getO2oRuleConfigs()

      if (changed) {
        await auditService.record(
          {
            actionType: 'system_config.update_o2o_rules',
            actionLabel: '更新线上预订规则配置',
            targetType: 'system_config',
            targetCode: 'o2o_rules',
            actor,
            requestMeta,
            detail: {
              before,
              after: config,
            },
          },
          manager,
        )
      }

      return { config, changed }
    })
  }

  async getVerificationProviderConfigs(): Promise<VerificationProviderConfigsResult> {
    await this.ensureDefaultConfigs()
    const rows = await this.configRepo.find({
      where: this.verificationConfigKeys.map((key) => ({ configKey: key })),
      select: {
        configKey: true,
        configValue: true,
        updatedAt: true,
      },
    })
    if (rows.length !== this.verificationConfigKeys.length) {
      throw new BizError('验证码平台配置缺失，请联系管理员补齐配置', 500)
    }
    const map = new Map(rows.map((row) => [row.configKey, row]))
    return {
      mobile: this.formatVerificationProviderConfig('mobile', map),
      email: this.formatVerificationProviderConfig('email', map),
    }
  }

  async getClientDepartmentConfigs(): Promise<ClientDepartmentConfigRecord> {
    await this.ensureDefaultConfigs()
    const row = await this.configRepo.findOne({
      where: { configKey: this.clientDepartmentConfigKey },
      select: {
        id: true,
        configValue: true,
        updatedAt: true,
      },
    })
    if (!row) {
      throw new BizError('客户端部门配置缺失，请联系管理员补齐配置', 500)
    }
    const parsedConfig = this.parseClientDepartmentConfig(row.configValue)
    return {
      tree: parsedConfig.tree,
      options: parsedConfig.options,
      updatedAt: row.updatedAt,
    }
  }

  async updateClientDepartmentConfigs(
    input: UpdateClientDepartmentConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ config: ClientDepartmentConfigRecord; changed: boolean }> {
    await this.assertAdminActor(actor, requestMeta, 'system_config.update_client_departments', '更新客户端部门配置')
    const normalizedTree = Array.isArray(input.tree)
      ? this.normalizeClientDepartmentTree(input.tree)
      : this.buildTreeFromOptions(this.normalizeClientDepartmentOptions(input.options ?? []))
    const normalizedOptions = this.normalizeClientDepartmentOptions(this.flattenDepartmentTree(normalizedTree))
    await this.ensureDefaultConfigs()
    return AppDataSource.transaction(async (manager) => {
      const useForUpdate = manager.connection.options.type === 'mysql'
      const lockedRows: Array<{ id: string; configKey: string; configValue: string; updatedAt: string }> = await manager.query(
        `
          SELECT id, config_key AS configKey, config_value AS configValue, updated_at AS updatedAt
          FROM system_configs
          WHERE config_key = ?
          ${useForUpdate ? 'FOR UPDATE' : ''}
        `,
        [this.clientDepartmentConfigKey],
      )

      const row = lockedRows[0]
      if (!row) {
        throw new BizError('客户端部门配置缺失，请联系管理员补齐配置', 500)
      }

      const before: ClientDepartmentConfigRecord = {
        ...this.parseClientDepartmentConfig(row.configValue),
        updatedAt: new Date(row.updatedAt),
      }

      const targetValue = JSON.stringify({
        tree: normalizedTree,
      })
      let changed = false
      if (row.configValue !== targetValue) {
        await manager.getRepository(SystemConfig).update({ id: row.id }, { configValue: targetValue })
        changed = true
      }

      const config: ClientDepartmentConfigRecord = {
        tree: normalizedTree,
        options: normalizedOptions,
        updatedAt: changed ? new Date() : new Date(row.updatedAt),
      }
      if (changed) {
        await auditService.record(
          {
            actionType: 'system_config.update_client_departments',
            actionLabel: '更新客户端部门配置',
            targetType: 'system_config',
            targetCode: 'client_departments',
            actor,
            requestMeta,
            detail: {
              before,
              after: config,
            },
          },
          manager,
        )
      }

      return { config, changed }
    })
  }

  async assertClientDepartmentOption(departmentName?: string) {
    const normalizedDepartment = departmentName?.trim() || ''
    if (!normalizedDepartment) {
      return ''
    }
    const config = await this.getClientDepartmentConfigs()
    if (!config.options.includes(normalizedDepartment)) {
      // 兼容历史数据：若用户提交的是旧版“叶子部门名”，且能唯一定位到路径，则自动转换为路径值。
      const matchedPaths = this.findDepartmentPathsByLabel(config.tree, normalizedDepartment)
      if (matchedPaths.length === 1) {
        return matchedPaths[0]
      }
      throw new BizError(`部门“${normalizedDepartment}”不在可选范围内，请重新选择`, 400)
    }
    return normalizedDepartment
  }

  async updateVerificationProviderConfigs(
    input: UpdateVerificationProviderConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ config: VerificationProviderConfigsResult; changed: boolean }> {
    await this.assertAdminActor(actor, requestMeta, 'system_config.update_verification_providers', '更新验证码平台配置')
    const normalizeChannelInput = (channel: VerificationProviderConfigInput, channelLabel: string) => {
      const method = channel.httpMethod === 'GET' ? 'GET' : 'POST'
      if (channel.enabled && !channel.apiUrl.trim()) {
        throw new BizError(`${channelLabel}已启用时必须填写 API 地址`, 400)
      }
      return {
        enabled: channel.enabled ? '1' : '0',
        httpMethod: method,
        apiUrl: channel.apiUrl.trim(),
        headersTemplate: channel.headersTemplate.trim(),
        bodyTemplate: channel.bodyTemplate.trim(),
        successMatch: channel.successMatch.trim(),
      }
    }

    const normalizedMobile = normalizeChannelInput(input.mobile, '短信验证码平台')
    const normalizedEmail = normalizeChannelInput(input.email, '邮箱验证码平台')

    await this.ensureDefaultConfigs()
    return AppDataSource.transaction(async (manager) => {
      const useForUpdate = manager.connection.options.type === 'mysql'
      const placeholders = this.verificationConfigKeys.map(() => '?').join(', ')
      const lockedRows: Array<{ id: string; configKey: string; configValue: string; updatedAt: string }> = await manager.query(
        `
          SELECT id, config_key AS configKey, config_value AS configValue, updated_at AS updatedAt
          FROM system_configs
          WHERE config_key IN (${placeholders})
          ${useForUpdate ? 'FOR UPDATE' : ''}
        `,
        [...this.verificationConfigKeys],
      )

      if (lockedRows.length !== this.verificationConfigKeys.length) {
        throw new BizError('验证码平台配置缺失，请联系管理员补齐配置', 500)
      }

      const targetMap = new Map<string, string>([
        ['verification.mobile.enabled', normalizedMobile.enabled],
        ['verification.mobile.http_method', normalizedMobile.httpMethod],
        ['verification.mobile.api_url', normalizedMobile.apiUrl],
        ['verification.mobile.headers_template', normalizedMobile.headersTemplate],
        ['verification.mobile.body_template', normalizedMobile.bodyTemplate],
        ['verification.mobile.success_match', normalizedMobile.successMatch],
        ['verification.email.enabled', normalizedEmail.enabled],
        ['verification.email.http_method', normalizedEmail.httpMethod],
        ['verification.email.api_url', normalizedEmail.apiUrl],
        ['verification.email.headers_template', normalizedEmail.headersTemplate],
        ['verification.email.body_template', normalizedEmail.bodyTemplate],
        ['verification.email.success_match', normalizedEmail.successMatch],
      ])

      const before = await this.getVerificationProviderConfigs()
      let changed = false
      const repo = manager.getRepository(SystemConfig)
      for (const row of lockedRows) {
        const targetValue = targetMap.get(row.configKey)
        if (targetValue == null || targetValue === row.configValue) {
          continue
        }
        await repo.update({ id: row.id }, { configValue: targetValue })
        changed = true
      }

      const config = await this.getVerificationProviderConfigs()
      if (changed) {
        await auditService.record(
          {
            actionType: 'system_config.update_verification_providers',
            actionLabel: '更新验证码平台配置',
            targetType: 'system_config',
            targetCode: 'verification_providers',
            actor,
            requestMeta,
            detail: {
              before,
              after: config,
            },
          },
          manager,
        )
      }

      return { config, changed }
    })
  }
}

export const systemConfigService = new SystemConfigService()
