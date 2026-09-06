/**
 * 文件说明：该文件负责系统配置服务，统一管理订单流水号、O2O 规则、客户端部门树、验证码通道与客服中心等后台配置。
 * 实现逻辑：
 * 1. 通过系统配置表维护各业务域默认值、读取逻辑与更新流程，避免关键运营参数散落在代码常量中；
 * 2. 配置变更时会结合审计日志、请求元信息与实时通知能力，保证后台操作可追溯且能及时同步到消费方；
 * 3. 同时承担默认配置补齐与兼容升级职责，确保老环境在版本演进后仍能平滑收敛到新规则。
 */

import { AppDataSource } from '../config/data-source.js'
import { env } from '../config/env.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BusinessSequence } from '../entities/business-sequence.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import { detectUnsafeHost, formatUnsafeHostReason } from '../utils/safe-network.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { customerServiceRealtimeService } from './customer-service-realtime.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import type { EntityManager } from 'typeorm'
import { createHash } from 'node:crypto'
import { STAFF_INVITE_CONFIG_KEY } from '../utils/staff-invite-code.js'

const CLIENT_DEPARTMENT_NODE_LIMIT = 3000

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const DEFAULT_SYSTEM_CONFIGS = [
  {
    configKey: STAFF_INVITE_CONFIG_KEY,
    configValue: JSON.stringify({ enabled: false, digest: null }),
    configGroup: 'client_auth',
    remark: '教师统一注册邀请码（仅保存摘要）',
  },
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
    configKey: 'o2o.store_business_hours_text',
    configValue: '10:00 - 22:00',
    configGroup: 'o2o',
    remark: '客户端商城展示的店铺营业时间文案',
  },
  {
    configKey: 'o2o.mall_announcement_text',
    configValue: '库存实时刷新，请以下单结果为准',
    configGroup: 'o2o',
    remark: '客户端商城公告文案，留空时隐藏公告块',
  },
  {
    configKey: 'verification.mobile.enabled',
    configValue: '0',
    configGroup: 'verification',
    remark: '短信验证码平台启用开关',
  },
  {
    configKey: 'verification.mobile.provider_type',
    configValue: 'generic_http',
    configGroup: 'verification',
    remark: '短信验证码提供方类型（generic_http 或 aliyun_dypns）',
  },
  {
    configKey: 'verification.mobile.aliyun_sign_name',
    configValue: '',
    configGroup: 'verification',
    remark: '阿里云 PNVS 短信签名',
  },
  {
    configKey: 'verification.mobile.aliyun_scheme_name',
    configValue: '',
    configGroup: 'verification',
    remark: '阿里云 PNVS 验证服务名称（可选）',
  },
  {
    configKey: 'verification.mobile.aliyun_template_register',
    configValue: '',
    configGroup: 'verification',
    remark: '阿里云 PNVS 注册短信模板码',
  },
  {
    configKey: 'verification.mobile.aliyun_template_forgot_password',
    configValue: '',
    configGroup: 'verification',
    remark: '阿里云 PNVS 找回密码短信模板码',
  },
  {
    configKey: 'verification.mobile.aliyun_template_profile_update',
    configValue: '',
    configGroup: 'verification',
    remark: '阿里云 PNVS 资料修改短信模板码',
  },
  {
    configKey: 'verification.mobile.aliyun_template_test',
    configValue: '',
    configGroup: 'verification',
    remark: '阿里云 PNVS 测试短信模板码',
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
  {
    configKey: 'customer_service.enabled',
    configValue: '1',
    configGroup: 'customer_service',
    remark: '客户端反馈入口启用开关',
  },
  {
    configKey: 'customer_service.realtime_enabled',
    configValue: '1',
    configGroup: 'customer_service',
    remark: '客服中心实时通道启用开关',
  },
  {
    configKey: 'customer_service.entry_notice',
    configValue: '客服中心工作时间内会尽快回复，请尽量描述问题现象、时间和影响范围。',
    configGroup: 'customer_service',
    remark: '客户端反馈入口提示语',
  },
  {
    configKey: 'customer_service.workday_start',
    configValue: '10:00',
    configGroup: 'customer_service',
    remark: '客服工作开始时间',
  },
  {
    configKey: 'customer_service.workday_end',
    configValue: '20:00',
    configGroup: 'customer_service',
    remark: '客服工作结束时间',
  },
  {
    configKey: 'customer_service.workday_weekdays',
    configValue: '[0,1,2,3,4,5,6]',
    configGroup: 'customer_service',
    remark: '客服工作日配置(JSON 数组，0=周日，6=周六)',
  },
  {
    configKey: 'customer_service.offline_notice',
    configValue: '当前客服暂时离线，您仍可提交问题，我们会在工作时间优先处理。',
    configGroup: 'customer_service',
    remark: '客服离线提示语',
  },
  {
    configKey: 'customer_service.offline_faq_json',
    configValue: '[{"question":"客服什么时候在线？","answer":"默认工作时间为周一至周日 10:00-20:00。"},{"question":"离线时提交的问题会丢失吗？","answer":"不会，系统会保留完整会话记录，客服上线后继续跟进。"}]',
    configGroup: 'customer_service',
    remark: '客服离线 FAQ(JSON)',
  },
  {
    configKey: 'customer_service.sse_keepalive_seconds',
    configValue: '20',
    configGroup: 'customer_service',
    remark: '客服中心 SSE 心跳间隔（秒）',
  },
  {
    configKey: 'notification.online_window_seconds',
    configValue: '120',
    configGroup: 'notification',
    remark: '通知中心离线判定窗口（秒）',
  },
] as const

/**
 * 文件说明：客服中心默认营业时间已从“工作日 09:00-18:00”升级为“周一至周日 10:00-20:00”。
 * 实现逻辑：
 * 1. 仅对仍然保持旧默认值的配置自动升级，避免覆盖管理员手工调整过的营业时间；
 * 2. 覆盖工作日、开始时间、结束时间和离线 FAQ 中对应的默认描述文案；
 * 3. 该兼容逻辑会在读取系统配置前自动执行，保证已初始化环境也能无感收口到新默认值。
 */
const CUSTOMER_SERVICE_LEGACY_DEFAULT_UPDATES = [
  {
    configKey: 'customer_service.workday_start',
    legacyValue: '09:00',
    nextValue: '10:00',
  },
  {
    configKey: 'customer_service.workday_end',
    legacyValue: '18:00',
    nextValue: '20:00',
  },
  {
    configKey: 'customer_service.workday_weekdays',
    legacyValue: '[1,2,3,4,5]',
    nextValue: '[0,1,2,3,4,5,6]',
  },
  {
    configKey: 'customer_service.offline_faq_json',
    legacyValue:
      '[{"question":"客服什么时候在线？","answer":"默认工作时间为周一至周五 09:00-18:00。"},{"question":"离线时提交的问题会丢失吗？","answer":"不会，系统会保留完整会话记录，客服上线后继续跟进。"}]',
    nextValue:
      '[{"question":"客服什么时候在线？","answer":"默认工作时间为周一至周日 10:00-20:00。"},{"question":"离线时提交的问题会丢失吗？","answer":"不会，系统会保留完整会话记录，客服上线后继续跟进。"}]',
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

interface OrderSerialOccupancySnapshot {
  outboundCount: number
  outboundActiveCount: number
  outboundDeletedCount: number
  preorderCount: number
  maxSerial: number
  latestOutboundShowNo: string | null
  latestPreorderShowNo: string | null
  outboundExamples: OrderSerialOccupancyDetail[]
  preorderExamples: OrderSerialOccupancyDetail[]
}

interface OrderSerialOccupancyDetail {
  showNo: string
  serial: number
  statusLabel: string
}

export interface O2oRuleConfigRecord {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  clientPreorderUpdateLimit: number
  storeBusinessHoursText: string
  mallAnnouncementText: string
  updatedAt: Date
}

export interface UpdateO2oRuleConfigsInput {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  clientPreorderUpdateLimit?: number
  storeBusinessHoursText: string
  mallAnnouncementText: string
}

export type VerificationChannelType = 'mobile' | 'email'
export type SmsVerificationProviderType = 'generic_http' | 'aliyun_dypns'
export type VerificationScene = 'register' | 'forgot_password' | 'profile_update' | 'test'

export interface AliyunDypnsTemplateConfig {
  register: string
  forgotPassword: string
  profileUpdate: string
  test: string
}

export interface VerificationProviderConfigRecord {
  enabled: boolean
  ready: boolean
  httpMethod: 'POST' | 'GET'
  apiUrl: string
  headersTemplate: string
  bodyTemplate: string
  successMatch: string
  updatedAt: Date
  providerType: SmsVerificationProviderType
  aliyunSignName: string
  aliyunSchemeName: string
  aliyunTemplates: AliyunDypnsTemplateConfig
  credentialsConfigured: boolean
  ticketHmacConfigured: boolean
  mnsEnabled: boolean
  mnsConfigured: boolean
  statusError: string | null
  headersTemplateMasked?: boolean
  bodyTemplateMasked?: boolean
  apiUrlMasked?: boolean
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
  clearApiUrl?: boolean
  clearHeadersTemplate?: boolean
  clearBodyTemplate?: boolean
  providerType?: SmsVerificationProviderType
  aliyunSignName?: string
  aliyunSchemeName?: string
  aliyunTemplates?: Partial<AliyunDypnsTemplateConfig>
}

export interface UpdateVerificationProviderConfigsInput {
  mobile: VerificationProviderConfigInput
  email: VerificationProviderConfigInput
}

export const VERIFICATION_SENSITIVE_VALUE_PLACEHOLDER = '[已隐藏敏感内容，保存时保留原值]'

export interface ClientDepartmentConfigRecord {
  tree: ClientDepartmentTreeNode[]
  options: string[]
  updatedAt: Date
}

export interface EnsureClientDepartmentOptionsResult {
  config: ClientDepartmentConfigRecord
  changed: boolean
  createdDepartments: string[]
  resolvedDepartmentMap: Map<string, string>
}

export interface ClientDepartmentTreeNode {
  id: string
  label: string
  children: ClientDepartmentTreeNode[]
}

export interface ResolvedClientDepartmentNode {
  departmentNodeId: string
  departmentName: string
  label: string
}

export interface UpdateClientDepartmentConfigsInput {
  tree?: ClientDepartmentTreeNode[]
  options?: string[]
}

export interface CustomerServiceConfigRecord {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: Array<{ question: string; answer: string }>
  sseKeepaliveSeconds: number
  availability: {
    status: 'online' | 'offline'
    reason: 'within_work_hours' | 'outside_work_hours' | 'no_online_staff'
    isOnline: boolean
    withinWorkHours: boolean
    hasOnlineStaff: boolean
    serviceConnectedCount: number
    serverTime: string
    workHoursText: string
    offlineNotice: string
    offlineFaqs: Array<{ question: string; answer: string }>
  }
  updatedAt: Date
}

export interface UpdateCustomerServiceConfigsInput {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: Array<{ question: string; answer: string }>
  sseKeepaliveSeconds: number
}

class SystemConfigService {
  private readonly configRepo = AppDataSource.getRepository(SystemConfig)
  private readonly o2oConfigKeys = [
    'o2o.auto_cancel_enabled',
    'o2o.auto_cancel_hours',
    'o2o.limit_enabled',
    'o2o.limit_qty',
    'o2o.client_preorder_update_limit',
    'o2o.store_business_hours_text',
    'o2o.mall_announcement_text',
  ] as const
  private readonly clientDepartmentConfigKey = 'client.department.options'
  private readonly verificationConfigKeys = [
    'verification.mobile.enabled',
    'verification.mobile.provider_type',
    'verification.mobile.aliyun_sign_name',
    'verification.mobile.aliyun_scheme_name',
    'verification.mobile.aliyun_template_register',
    'verification.mobile.aliyun_template_forgot_password',
    'verification.mobile.aliyun_template_profile_update',
    'verification.mobile.aliyun_template_test',
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
  private readonly customerServiceConfigKeys = [
    'customer_service.enabled',
    'customer_service.realtime_enabled',
    'customer_service.entry_notice',
    'customer_service.workday_start',
    'customer_service.workday_end',
    'customer_service.workday_weekdays',
    'customer_service.offline_notice',
    'customer_service.offline_faq_json',
    'customer_service.sse_keepalive_seconds',
  ] as const
  /**
   * 默认配置是否已在本进程内确认过存在：
   * - system_configs 里的默认行只会被插入，不会被应用代码删除，因此“已存在”是单调事实；
   * - 确认过一次后，后续调用不再需要每次都发起一条含数十个 OR 分支的存在性校验查询。
   */
  private defaultConfigsEnsured = false
  private static readonly CONFIG_CACHE_TTL_MS = 5_000
  private o2oRuleConfigCache: { value: O2oRuleConfigRecord; expiresAtMs: number } | null = null
  // 只缓存客服配置中来自数据库的静态部分；availability 依赖实时在线人数，每次都要重新计算，不能一并缓存。
  private customerServiceBaseConfigCache: { value: Omit<CustomerServiceConfigRecord, 'availability'>; expiresAtMs: number } | null = null
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

  private parseBooleanFlag(value: string, field: string) {
    const parsed = this.parseNonNegativeInteger(value, field)
    return parsed > 0
  }

  private normalizeTimeText(value: string, fieldLabel: string) {
    const normalized = value.trim()
    if (!/^\d{2}:\d{2}$/.test(normalized)) {
      throw new BizError(`${fieldLabel}格式必须为 HH:mm`, 400)
    }
    const [hour, minute] = normalized.split(':').map((item) => Number.parseInt(item, 10))
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new BizError(`${fieldLabel}格式非法`, 400)
    }
    return normalized
  }

  private normalizeWeekdays(value: number[]) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new BizError('客服工作日不能为空', 400)
    }
    const normalized = Array.from(
      new Set(
        value.map((item) => {
          if (!Number.isInteger(item) || item < 0 || item > 6) {
            throw new BizError('客服工作日仅支持 0 到 6 的整数', 400)
          }
          return item
        }),
      ),
    ).sort((left, right) => left - right)
    return normalized
  }

  private normalizeCustomerServiceFaqs(input: Array<{ question: string; answer: string }>) {
    if (!Array.isArray(input)) {
      throw new BizError('离线 FAQ 配置格式非法', 400)
    }
    if (input.length > 20) {
      throw new BizError('离线 FAQ 最多支持 20 条', 400)
    }
    return input.map((item, index) => {
      const question = item.question?.trim() || ''
      const answer = item.answer?.trim() || ''
      if (!question) {
        throw new BizError(`第 ${index + 1} 条 FAQ 问题不能为空`, 400)
      }
      if (!answer) {
        throw new BizError(`第 ${index + 1} 条 FAQ 答案不能为空`, 400)
      }
      if (question.length > 100) {
        throw new BizError(`第 ${index + 1} 条 FAQ 问题长度不能超过 100 个字符`, 400)
      }
      if (answer.length > 1000) {
        throw new BizError(`第 ${index + 1} 条 FAQ 答案长度不能超过 1000 个字符`, 400)
      }
      return { question, answer }
    })
  }

  private parseCustomerServiceFaqs(rawValue: string) {
    const raw = rawValue.trim()
    if (!raw) {
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      return this.normalizeCustomerServiceFaqs(Array.isArray(parsed) ? parsed : [])
    } catch {
      throw new BizError('客服离线 FAQ 配置格式非法', 500)
    }
  }

  private buildWorkHoursText(start: string, end: string, weekdays: number[]) {
    const weekTextMap = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const weekdayText = weekdays.map((item) => weekTextMap[item]).join('、')
    return `${weekdayText} ${start}-${end}`
  }

  private computeCustomerServiceAvailability(config: Omit<CustomerServiceConfigRecord, 'availability'>, serviceConnectedCount: number) {
    const now = new Date()
    const serverTime = now.toISOString()
    const currentWeekday = now.getDay()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    const [startHour, startMinute] = config.workdayStart.split(':').map((item) => Number.parseInt(item, 10))
    const [endHour, endMinute] = config.workdayEnd.split(':').map((item) => Number.parseInt(item, 10))
    const startMinutes = startHour * 60 + startMinute
    const endMinutes = endHour * 60 + endMinute
    const withinTimeWindow = endMinutes > startMinutes
      ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
      : currentMinutes >= startMinutes || currentMinutes <= endMinutes
    const withinWorkHours = config.workdayWeekdays.includes(currentWeekday) && withinTimeWindow
    const hasOnlineStaff = serviceConnectedCount > 0
    const isOnline = config.enabled && config.realtimeEnabled && withinWorkHours && hasOnlineStaff
    let reason: 'within_work_hours' | 'outside_work_hours' | 'no_online_staff' = 'within_work_hours'
    if (!withinWorkHours) {
      reason = 'outside_work_hours'
    } else if (!hasOnlineStaff) {
      reason = 'no_online_staff'
    }
    const status: 'online' | 'offline' = isOnline ? 'online' : 'offline'
    return {
      status,
      reason,
      isOnline,
      withinWorkHours,
      hasOnlineStaff,
      serviceConnectedCount,
      serverTime,
      workHoursText: this.buildWorkHoursText(config.workdayStart, config.workdayEnd, config.workdayWeekdays),
      offlineNotice: config.offlineNotice,
      offlineFaqs: config.offlineFaqs,
    }
  }

  /**
   * 敏感配置展示口径：
   * - 管理页读取时不直接回传真实模板内容，避免浏览器、日志或抓包中泄露第三方密钥；
   * - 若管理员未修改该字段直接保存，后端会识别占位文本并保留数据库原值。
   */
  private maskSensitiveConfigValue(value: string | null | undefined) {
    if (!value) {
      return ''
    }
    return value.trim() ? VERIFICATION_SENSITIVE_VALUE_PLACEHOLDER : ''
  }

  private isSensitivePlaceholder(value: string | undefined) {
    return (value?.trim() || '') === VERIFICATION_SENSITIVE_VALUE_PLACEHOLDER
  }

  private sanitizeVerificationConfigForAudit(config: VerificationProviderConfigRecord): VerificationProviderConfigRecord {
    return {
      ...config,
      apiUrl: this.maskSensitiveConfigValue(config.apiUrl),
      headersTemplate: this.maskSensitiveConfigValue(config.headersTemplate),
      bodyTemplate: this.maskSensitiveConfigValue(config.bodyTemplate),
      headersTemplateMasked: Boolean(config.headersTemplate.trim()),
      bodyTemplateMasked: Boolean(config.bodyTemplate.trim()),
      apiUrlMasked: Boolean(config.apiUrl.trim()),
    }
  }

  private validateVerificationApiUrl(apiUrl: string, channelLabel: string) {
    if (!apiUrl) {
      return
    }
    let url: URL
    try {
      url = new URL(apiUrl)
    } catch {
      throw new BizError(`${channelLabel}API 地址格式不正确`, 400)
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new BizError(`${channelLabel}API 地址仅支持 http 或 https 协议`, 400)
    }

    /**
     * SSRF 防护：
     * - 验证码平台属于服务端主动出站请求；
     * - 若允许 localhost、裸 IP、私网或链路本地地址，攻击者可把请求打到宿主机、本地服务或内网资源；
     * - 因此在配置保存阶段直接拒绝危险主机，减少错误配置与恶意利用窗口。
     */
    const unsafeReason = detectUnsafeHost(url.hostname)
    if (unsafeReason) {
      throw new BizError(`${channelLabel}API 地址禁止使用${formatUnsafeHostReason(unsafeReason)}`, 400)
    }
  }

  private normalizeVerificationHeadersTemplate(rawValue: string, channelLabel: string) {
    const text = rawValue.trim()
    const jsonText = text || '{}'
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      throw new BizError(`${channelLabel}请求头模板必须是合法 JSON 对象`, 400)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BizError(`${channelLabel}请求头模板必须是 JSON 对象`, 400)
    }
    for (const [headerName, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (!headerName.trim()) {
        throw new BizError(`${channelLabel}请求头名称不能为空`, 400)
      }
      if (headerValue === null || typeof headerValue === 'object') {
        throw new BizError(`${channelLabel}请求头值仅支持字符串、数字或布尔值`, 400)
      }
    }
    return text
  }

  private normalizeVerificationBodyTemplate(rawValue: string, channelLabel: string) {
    const text = rawValue.trim()
    if (text.length > 10000) {
      throw new BizError(`${channelLabel}请求体模板长度不能超过 10000 个字符`, 400)
    }
    return text
  }

  private buildVerificationConfigMap(rows: Array<Pick<SystemConfig, 'configKey' | 'configValue' | 'updatedAt'>>) {
    return new Map(rows.map((row) => [row.configKey, row]))
  }

  private async loadVerificationConfigMap(manager: EntityManager = AppDataSource.manager) {
    await this.ensureDefaultConfigs(manager)
    const rows = await manager.getRepository(SystemConfig).find({
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
    return this.buildVerificationConfigMap(rows)
  }

  private resolveSensitiveVerificationFieldValue(
    nextValue: string,
    persistedValue: string,
    channelLabel: string,
    fieldLabel: string,
    clearValue = false,
  ) {
    if (clearValue) return ''
    if (this.isSensitivePlaceholder(nextValue)) {
      if (!persistedValue.trim()) {
        throw new BizError(`${channelLabel}${fieldLabel}当前没有可保留的历史值，请重新填写真实内容`, 400)
      }
      return persistedValue
    }
    const normalized = nextValue.trim()
    if (!normalized && persistedValue.trim()) return persistedValue
    return normalized
  }

  private normalizeVerificationProviderInput(
    channelType: VerificationChannelType,
    channel: VerificationProviderConfigInput,
    existingConfig: VerificationProviderConfigRecord,
  ): VerificationProviderConfigInput {
    const channelLabel = channelType === 'mobile' ? '短信验证码平台' : '邮箱验证码平台'
    const method = channel.httpMethod === 'GET' ? 'GET' : 'POST'
    const providerType: SmsVerificationProviderType = channelType === 'mobile'
      ? (channel.providerType === 'aliyun_dypns' ? 'aliyun_dypns' : channel.providerType === 'generic_http' ? 'generic_http' : existingConfig.providerType)
      : 'generic_http'
    const apiUrl = this.resolveSensitiveVerificationFieldValue(
      channel.apiUrl,
      existingConfig.apiUrl,
      channelLabel,
      'API 地址',
      Boolean(channel.clearApiUrl),
    )
    if (channel.enabled && providerType === 'generic_http' && !apiUrl) {
      throw new BizError(`${channelLabel}已启用时必须填写 API 地址`, 400)
    }
    if (providerType === 'generic_http') {
      this.validateVerificationApiUrl(apiUrl, channelLabel)
    }

    const normalizeAliyunText = (value: string | undefined, persisted: string, fieldLabel: string, maxLength: number) => {
      const normalized = value === undefined ? persisted.trim() : value.trim()
      if (normalized.length > maxLength) {
        throw new BizError(`${fieldLabel}长度不能超过 ${maxLength} 个字符`, 400)
      }
      return normalized
    }
    const aliyunSignName = normalizeAliyunText(
      channel.aliyunSignName,
      existingConfig.aliyunSignName,
      '阿里云 PNVS 短信签名',
      128,
    )
    const aliyunSchemeName = normalizeAliyunText(
      channel.aliyunSchemeName,
      existingConfig.aliyunSchemeName,
      '阿里云 PNVS 验证服务名称',
      20,
    )
    const aliyunTemplates: AliyunDypnsTemplateConfig = {
      register: normalizeAliyunText(channel.aliyunTemplates?.register, existingConfig.aliyunTemplates.register, '阿里云 PNVS 注册模板码', 128),
      forgotPassword: normalizeAliyunText(channel.aliyunTemplates?.forgotPassword, existingConfig.aliyunTemplates.forgotPassword, '阿里云 PNVS 找回密码模板码', 128),
      profileUpdate: normalizeAliyunText(channel.aliyunTemplates?.profileUpdate, existingConfig.aliyunTemplates.profileUpdate, '阿里云 PNVS 资料修改模板码', 128),
      test: normalizeAliyunText(channel.aliyunTemplates?.test, existingConfig.aliyunTemplates.test, '阿里云 PNVS 测试模板码', 128),
    }
    if (channel.enabled && providerType === 'aliyun_dypns') {
      if (!aliyunSignName || Object.values(aliyunTemplates).some((templateCode) => !templateCode)) {
        throw new BizError('启用阿里云 PNVS 短信时必须填写签名和全部场景模板码', 400)
      }
    }

    return {
      enabled: channel.enabled,
      httpMethod: method,
      apiUrl,
      headersTemplate: this.normalizeVerificationHeadersTemplate(
        this.resolveSensitiveVerificationFieldValue(
          channel.headersTemplate,
          existingConfig.headersTemplate,
          channelLabel,
          '请求头模板',
          Boolean(channel.clearHeadersTemplate),
        ),
        channelLabel,
      ),
      bodyTemplate: this.normalizeVerificationBodyTemplate(
        this.resolveSensitiveVerificationFieldValue(
          channel.bodyTemplate,
          existingConfig.bodyTemplate,
          channelLabel,
          '请求体模板',
          Boolean(channel.clearBodyTemplate),
        ),
        channelLabel,
      ),
      successMatch: channel.successMatch.trim(),
      providerType,
      aliyunSignName,
      aliyunSchemeName,
      aliyunTemplates,
    }
  }

  private createDepartmentNodeId(seed: string) {
    const normalizedSeed = seed.trim().replaceAll(/\s+/g, '-').slice(0, 24)
    return `dept_${normalizedSeed || 'node'}_${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 仅用于读取未持久化 ID 的旧部门配置：同一路径在每次解析中必须得到同一节点ID，
   * 这样管理员 preview 后提交的 nodeId 不会因下一次读取而失效。新建节点仍沿用随机 ID，
   * 避免不同新节点因路径短期相同而意外复用身份。
   */
  private createLegacyDepartmentNodeId(fullPath: string) {
    const digest = createHash('sha256').update(fullPath, 'utf8').digest('hex').slice(0, 24)
    return `legacy_dept_${digest}`
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

  private normalizeDepartmentNodeId(value: unknown) {
    const id = typeof value === 'string' ? value.trim() : ''
    if (!id) {
      throw new BizError('部门节点ID不能为空', 400)
    }
    if (id.length > 128) {
      throw new BizError('部门节点ID长度不能超过 128 个字符', 400)
    }
    return id
  }

  private readDepartmentPathSegments(value: string): string[] {
    return value
      .split('-')
      .map((segment) => this.normalizeDepartmentLabel(segment))
      .filter((segment) => segment.length > 0)
  }

  private buildTreeFromOptions(
    options: string[],
    useLegacyStableIds = false,
    existingNodeIdsByPath = new Map<string, string>(),
  ): ClientDepartmentTreeNode[] {
    const rootNodes: ClientDepartmentTreeNode[] = []
    const findOrCreateNode = (nodes: ClientDepartmentTreeNode[], label: string, seed: string) => {
      const existingNode = nodes.find((node) => node.label === label)
      if (existingNode) {
        return existingNode
      }
      const node: ClientDepartmentTreeNode = {
        id: existingNodeIdsByPath.get(seed)
          ?? (useLegacyStableIds ? this.createLegacyDepartmentNodeId(seed) : this.createDepartmentNodeId(seed)),
        label,
        children: [],
      }
      nodes.push(node)
      return node
    }

    options.forEach((option) => {
      const segments = this.readDepartmentPathSegments(option)
      let currentNodes = rootNodes
      let currentPath = ''
      segments.forEach((segment) => {
        currentPath = currentPath ? `${currentPath}-${segment}` : segment
        // 旧配置节点的身份只由规范化后的完整路径决定，不能掺入 options 顺序或分段序号。
        const node = findOrCreateNode(currentNodes, segment, currentPath)
        currentNodes = node.children
      })
    })

    return this.normalizeClientDepartmentTree(rootNodes)
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

  private buildClientDepartmentPathMap(tree: ClientDepartmentTreeNode[]): Map<string, string> {
    const paths = new Map<string, string>()
    const walk = (nodes: ClientDepartmentTreeNode[], parentPath = '') => {
      for (const node of nodes) {
        const departmentName = parentPath ? `${parentPath}-${node.label}` : node.label
        paths.set(node.id, departmentName)
        walk(node.children, departmentName)
      }
    }
    walk(tree)
    return paths
  }

  /**
   * 旧 options 用连字符分隔层级，无法区分“标签本身含 -”与“父子路径”。
   * 这类树若继续走 options 会静默改变拓扑或丢失节点 ID，因此必须要求调用方改用 tree。
   */
  private assertLegacyOptionsCanRepresentTree(tree: ClientDepartmentTreeNode[]) {
    const seenPaths = new Set<string>()
    const walk = (nodes: ClientDepartmentTreeNode[], parentPath = '') => {
      for (const node of nodes) {
        if (node.label.includes('-')) {
          throw new BizError('当前部门树包含连字符标签，旧 options 无法无歧义保存，请改用 tree 参数', 400)
        }
        const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
        if (seenPaths.has(currentPath)) {
          throw new BizError('当前部门树存在重复完整路径，旧 options 无法唯一保留节点 ID，请改用 tree 参数', 400)
        }
        seenPaths.add(currentPath)
        walk(node.children, currentPath)
      }
    }
    walk(tree)
  }

  private buildClientDepartmentOptionsFromTree(tree: ClientDepartmentTreeNode[]): string[] {
    const flattenedLabels = this.flattenDepartmentTree(tree)
    if (flattenedLabels.length > CLIENT_DEPARTMENT_NODE_LIMIT) {
      throw new BizError(`部门节点总数最多保留 ${CLIENT_DEPARTMENT_NODE_LIMIT} 个`, 400)
    }
    return [...new Set(flattenedLabels)]
  }

  private normalizeClientDepartmentOptions(options: string[]): string[] {
    const normalizedList = options
      .map((item) => this.normalizeDepartmentLabel(item))
      .filter((item) => item.length > 0)

    if (normalizedList.length > CLIENT_DEPARTMENT_NODE_LIMIT) {
      throw new BizError(`部门节点总数最多保留 ${CLIENT_DEPARTMENT_NODE_LIMIT} 个`, 400)
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

  private assertUniqueSiblingDepartmentLabels(nodes: ClientDepartmentTreeNode[], parentPath = '') {
    const siblingLabels = new Set<string>()
    for (const node of nodes) {
      if (siblingLabels.has(node.label)) {
        const parentLabel = parentPath || '根部门'
        throw new BizError(`部门“${node.label}”在“${parentLabel}”下重复，请调整同级部门名称后保存`, 400)
      }
      siblingLabels.add(node.label)
      if (node.children.length > 0) {
        const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
        this.assertUniqueSiblingDepartmentLabels(node.children, currentPath)
      }
    }
  }

  private normalizeClientDepartmentTree(
    tree: ClientDepartmentTreeNode[],
    depth = 1,
    parentPath = '',
    seenNodeIds = new Set<string>(),
    missingNodeIdStrategy: 'random' | 'legacy_path' = 'random',
  ): ClientDepartmentTreeNode[] {
    if (depth > 8) {
      throw new BizError('部门层级最多支持 8 级', 400)
    }
    const normalizedTree = tree.map((node, index) => {
      const label = this.normalizeDepartmentLabel(node.label)
      const currentPath = parentPath ? `${parentPath}-${label}` : label
      const id = this.normalizeDepartmentNodeId(
        String(node.id ?? '').trim()
          || (missingNodeIdStrategy === 'legacy_path'
            ? this.createLegacyDepartmentNodeId(currentPath)
            : this.createDepartmentNodeId(`${label}-${depth}-${index + 1}`)),
      )
      if (seenNodeIds.has(id)) {
        throw new BizError(`部门节点ID“${id}”重复，请修复部门树后再保存`, 400)
      }
      seenNodeIds.add(id)
      const children = Array.isArray(node.children)
        ? this.normalizeClientDepartmentTree(node.children, depth + 1, currentPath, seenNodeIds, missingNodeIdStrategy)
        : []
      return {
        id,
        label,
        children,
      }
    })
    this.assertUniqueSiblingDepartmentLabels(normalizedTree, parentPath)
    return normalizedTree
  }

  private parseClientDepartmentConfig(rawValue: string): { tree: ClientDepartmentTreeNode[]; options: string[] } {
    const raw = rawValue.trim()
    if (!raw) {
      return { tree: [], options: [] }
    }
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        const tree = this.buildTreeFromOptions(parsed, true)
        const options = this.buildClientDepartmentOptionsFromTree(tree)
        return {
          tree,
          options,
        }
      }

      let rawTree: unknown[] | null = null
      if (Array.isArray(parsed)) {
        rawTree = parsed
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tree?: unknown[] }).tree)) {
        rawTree = (parsed as { tree: unknown[] }).tree
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { options?: unknown[] }).options)) {
        const optionList = (parsed as { options: unknown[] }).options.filter((item): item is string => typeof item === 'string')
        const tree = this.buildTreeFromOptions(optionList, true)
        const options = this.buildClientDepartmentOptionsFromTree(tree)
        return { tree, options }
      }
      if (!rawTree) {
        throw new BizError('客户端部门配置格式非法', 500)
      }

      const rawTreeLabels = rawTree.map((item) => {
        const node = item as Partial<ClientDepartmentTreeNode> & { name?: string; title?: string }
        return String(node.label ?? node.name ?? node.title ?? '').trim()
      })
      const rawTreeHasStableNodeId = rawTree.some((item) => {
        const node = item as Partial<ClientDepartmentTreeNode>
        return typeof node.id === 'string' && node.id.trim().length > 0
      })
      const isLegacyFlatTree = rawTree.length > 0
        && !rawTreeHasStableNodeId
        && rawTreeLabels.some((label) => label.includes('-'))
        && rawTree.every((item) => {
          const node = item as Partial<ClientDepartmentTreeNode>
          return !Array.isArray(node.children) || node.children.length === 0
        })
      if (isLegacyFlatTree) {
        const tree = this.buildTreeFromOptions(rawTreeLabels, true)
        const options = this.buildClientDepartmentOptionsFromTree(tree)
        return { tree, options }
      }

      const normalizeRawTreeNode = (item: unknown): ClientDepartmentTreeNode => {
        const node = item as Partial<ClientDepartmentTreeNode> & { name?: string; title?: string }
        return {
          id: String(node.id ?? '').trim(),
          label: String(node.label ?? node.name ?? node.title ?? '').trim(),
          children: Array.isArray(node.children) ? node.children.map((child) => normalizeRawTreeNode(child)) : [],
        }
      }
      const tree = this.normalizeClientDepartmentTree(rawTree.map((item) => normalizeRawTreeNode(item)), 1, '', new Set(), 'legacy_path')
      const options = this.buildClientDepartmentOptionsFromTree(tree)
      return { tree, options }
    } catch (error) {
      if (error instanceof BizError) {
        throw error
      }
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

  private parseSerialFromShowNo(showNo: string | null | undefined, prefix: string): number | null {
    const normalizedShowNo = String(showNo ?? '').trim()
    if (!normalizedShowNo.startsWith(prefix)) {
      return null
    }

    const serialText = normalizedShowNo.slice(prefix.length)
    if (!/^\d+$/.test(serialText)) {
      return null
    }

    const parsed = Number.parseInt(serialText, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }

  private pickMaxSerialShowNo(rows: Array<{ showNo: string }>, prefix: string): { maxSerial: number; showNo: string | null } {
    return rows.reduce(
      (result, row) => {
        const serial = this.parseSerialFromShowNo(row.showNo, prefix)
        if (serial === null || serial <= result.maxSerial) {
          return result
        }
        return {
          maxSerial: serial,
          showNo: row.showNo,
        }
      },
      { maxSerial: 0, showNo: null as string | null },
    )
  }

  private normalizeBooleanFlag(value: unknown) {
    return value === true || value === 1 || value === '1' || value === 'true'
  }

  private formatPreorderStatusLabel(status: string) {
    const statusMap: Record<string, string> = {
      pending: '订单池待核销',
      verified: '订单池已核销',
      cancelled: '订单池已取消',
    }
    return statusMap[status] ?? `订单池状态 ${status || '未知'}`
  }

  private formatOrderSerialOccupancyExamples(examples: OrderSerialOccupancyDetail[]) {
    if (examples.length === 0) {
      return ''
    }
    return `；需处理单号示例：${examples.map((item) => `${item.showNo}（${item.statusLabel}）`).join('、')}`
  }

  private async getOrderSerialOccupancySnapshot(
    manager: typeof AppDataSource.manager,
    orderType: OrderSerialType,
  ): Promise<OrderSerialOccupancySnapshot> {
    const [outboundRows, preorderRows] = await Promise.all([
      manager
        .getRepository(BizOutboundOrder)
        .createQueryBuilder('outboundOrder')
        .select('outboundOrder.showNo', 'showNo')
        .addSelect('outboundOrder.isDeleted', 'isDeleted')
        .where('outboundOrder.orderType = :orderType', { orderType })
        .getRawMany<{ showNo: string; isDeleted: boolean | number | string }>(),
      manager
        .getRepository(O2oPreorder)
        .createQueryBuilder('preorder')
        .select('preorder.showNo', 'showNo')
        .addSelect('preorder.status', 'status')
        .where('preorder.clientOrderType = :orderType', { orderType })
        .andWhere('preorder.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('preorder.status <> :verifiedStatus', { verifiedStatus: 'verified' })
        .getRawMany<{ showNo: string; status: string }>(),
    ])
    const prefix = ORDER_SERIAL_META[orderType].prefix
    const outboundMax = this.pickMaxSerialShowNo(outboundRows, prefix)
    const preorderMax = this.pickMaxSerialShowNo(preorderRows, prefix)
    const outboundDetails = outboundRows
      .map((row) => ({
        showNo: row.showNo,
        serial: this.parseSerialFromShowNo(row.showNo, prefix),
        statusLabel: this.normalizeBooleanFlag(row.isDeleted) ? '已删除未永久删除' : '正常出库单',
      }))
      .filter((item): item is OrderSerialOccupancyDetail => item.serial !== null)
      .sort((left, right) => right.serial - left.serial)
    const preorderDetails = preorderRows
      .map((row) => ({
        showNo: row.showNo,
        serial: this.parseSerialFromShowNo(row.showNo, prefix),
        statusLabel: this.formatPreorderStatusLabel(row.status),
      }))
      .filter((item): item is OrderSerialOccupancyDetail => item.serial !== null)
      .sort((left, right) => right.serial - left.serial)
    const outboundDeletedCount = outboundRows.filter((row) => this.normalizeBooleanFlag(row.isDeleted)).length

    return {
      outboundCount: outboundRows.length,
      outboundActiveCount: outboundRows.length - outboundDeletedCount,
      outboundDeletedCount,
      preorderCount: preorderRows.length,
      maxSerial: Math.max(outboundMax.maxSerial, preorderMax.maxSerial),
      latestOutboundShowNo: outboundMax.showNo,
      latestPreorderShowNo: preorderMax.showNo,
      outboundExamples: outboundDetails.slice(0, 5),
      preorderExamples: preorderDetails.slice(0, 5),
    }
  }

  private formatOrderSerialOccupancyReason(
    orderType: OrderSerialType,
    nextCurrent: number,
    snapshot: OrderSerialOccupancySnapshot,
  ): string {
    const sourceParts: string[] = []
    if (snapshot.preorderCount > 0) {
      sourceParts.push(
        `订单池仍有 ${snapshot.preorderCount} 单占用流水`
        + `${snapshot.latestPreorderShowNo ? `，最大单号 ${snapshot.latestPreorderShowNo}` : ''}`
        + this.formatOrderSerialOccupancyExamples(snapshot.preorderExamples),
      )
    }
    if (snapshot.outboundCount > 0) {
      sourceParts.push(
        `出库单仍有 ${snapshot.outboundCount} 单占用流水`
        + `（正常 ${snapshot.outboundActiveCount} 单，已删除未永久删除 ${snapshot.outboundDeletedCount} 单）`
        + `${snapshot.latestOutboundShowNo ? `，最大单号 ${snapshot.latestOutboundShowNo}` : ''}`
        + this.formatOrderSerialOccupancyExamples(snapshot.outboundExamples),
      )
    }

    return [
      `${ORDER_SERIAL_META[orderType].label}当前号不能改为 ${nextCurrent}。`,
      `原因：${ORDER_SERIAL_META[orderType].label}流水仍被订单占用，当前号不能小于已占用的最大流水 ${snapshot.maxSerial}，否则后续生成单号会冲突。`,
      `具体占用：${sourceParts.join('；') || '未识别到可展示来源'}。`,
      `处理方式：订单池订单请到“订单池工作台”删除；出库单请到“出库单列表”处理，正常单据需先删除，已删除单据需筛选“已删除单据”后执行永久删除。也可以把当前号设置为 ${snapshot.maxSerial} 及以上。`,
    ].join('')
  }

  private async assertOrderSerialCurrentSafety(
    manager: typeof AppDataSource.manager,
    beforeList: OrderSerialConfigRecord[],
    input: UpdateOrderSerialConfigsInput,
  ) {
    for (const orderType of ORDER_SERIAL_TYPES) {
      const before = beforeList.find((item) => item.orderType === orderType)
      if (!before) {
        continue
      }
      const next = input[orderType]
      const isLoweringCurrent = next.current < before.current
      if (!isLoweringCurrent) {
        continue
      }

      const occupancySnapshot = await this.getOrderSerialOccupancySnapshot(manager, orderType)
      if (next.current >= occupancySnapshot.maxSerial) {
        continue
      }

      throw new BizError(this.formatOrderSerialOccupancyReason(orderType, next.current, occupancySnapshot), 400)
    }
  }

  private formatVerificationProviderConfig(
    channel: VerificationChannelType,
    configMap: Map<string, Pick<SystemConfig, 'configValue' | 'updatedAt'>>,
    options: { maskSensitiveValues?: boolean } = {},
  ): VerificationProviderConfigRecord {
    const keyPrefix = `verification.${channel}`
    const enabledConfig = configMap.get(`${keyPrefix}.enabled`)
    const providerTypeConfig = channel === 'mobile' ? configMap.get(`${keyPrefix}.provider_type`) : undefined
    const aliyunSignNameConfig = channel === 'mobile' ? configMap.get(`${keyPrefix}.aliyun_sign_name`) : undefined
    const aliyunSchemeNameConfig = channel === 'mobile' ? configMap.get(`${keyPrefix}.aliyun_scheme_name`) : undefined
    const aliyunTemplateRegisterConfig = channel === 'mobile' ? configMap.get(`${keyPrefix}.aliyun_template_register`) : undefined
    const aliyunTemplateForgotPasswordConfig = channel === 'mobile' ? configMap.get(`${keyPrefix}.aliyun_template_forgot_password`) : undefined
    const aliyunTemplateProfileUpdateConfig = channel === 'mobile' ? configMap.get(`${keyPrefix}.aliyun_template_profile_update`) : undefined
    const aliyunTemplateTestConfig = channel === 'mobile' ? configMap.get(`${keyPrefix}.aliyun_template_test`) : undefined
    const methodConfig = configMap.get(`${keyPrefix}.http_method`)
    const urlConfig = configMap.get(`${keyPrefix}.api_url`)
    const headersConfig = configMap.get(`${keyPrefix}.headers_template`)
    const bodyConfig = configMap.get(`${keyPrefix}.body_template`)
    const successConfig = configMap.get(`${keyPrefix}.success_match`)
    if (
      !enabledConfig || !methodConfig || !urlConfig || !headersConfig || !bodyConfig || !successConfig
      || (channel === 'mobile' && (
        !providerTypeConfig || !aliyunSignNameConfig || !aliyunSchemeNameConfig || !aliyunTemplateRegisterConfig
        || !aliyunTemplateForgotPasswordConfig || !aliyunTemplateProfileUpdateConfig || !aliyunTemplateTestConfig
      ))
    ) {
      throw new BizError('验证码平台配置缺失，请联系管理员补齐配置', 500)
    }

    const httpMethod = methodConfig.configValue === 'GET' ? 'GET' : 'POST'
    const providerType: SmsVerificationProviderType = providerTypeConfig?.configValue === 'aliyun_dypns' ? 'aliyun_dypns' : 'generic_http'
    const updatedAt = [
      enabledConfig.updatedAt,
      methodConfig.updatedAt,
      urlConfig.updatedAt,
      headersConfig.updatedAt,
      bodyConfig.updatedAt,
      successConfig.updatedAt,
      providerTypeConfig?.updatedAt,
      aliyunSignNameConfig?.updatedAt,
      aliyunSchemeNameConfig?.updatedAt,
      aliyunTemplateRegisterConfig?.updatedAt,
      aliyunTemplateForgotPasswordConfig?.updatedAt,
      aliyunTemplateProfileUpdateConfig?.updatedAt,
      aliyunTemplateTestConfig?.updatedAt,
    ].filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0]

    const enabled = this.parseNonNegativeInteger(enabledConfig.configValue, `${keyPrefix}.enabled`) > 0
    const credentialsConfigured = Boolean(env.ALIBABA_CLOUD_ACCESS_KEY_ID && env.ALIBABA_CLOUD_ACCESS_KEY_SECRET)
    const ticketHmacConfigured = (env.VERIFICATION_TICKET_HMAC_SECRET?.length ?? 0) >= 32
    const mnsEnabled = env.ALIYUN_DYPNS_MNS_ENABLED
    const mnsConfigured = !mnsEnabled || credentialsConfigured
    let statusError: string | null = null
    const aliyunTemplateReady = Object.values({
      register: aliyunTemplateRegisterConfig?.configValue ?? '',
      forgotPassword: aliyunTemplateForgotPasswordConfig?.configValue ?? '',
      profileUpdate: aliyunTemplateProfileUpdateConfig?.configValue ?? '',
      test: aliyunTemplateTestConfig?.configValue ?? '',
    }).every((templateCode) => templateCode.trim().length > 0)
    const aliyunConfigReady = Boolean(aliyunSignNameConfig?.configValue.trim()) && aliyunTemplateReady
    const ready = providerType === 'generic_http'
      ? enabled && Boolean(urlConfig.configValue.trim())
      : enabled && aliyunConfigReady && credentialsConfigured && ticketHmacConfigured
    if (enabled && providerType === 'generic_http' && !urlConfig.configValue.trim()) {
      statusError = `${channel === 'mobile' ? '短信' : '邮箱'}验证码平台 API 未配置`
    } else if (enabled && providerType === 'aliyun_dypns' && !aliyunConfigReady) {
      statusError = '阿里云 PNVS 短信签名或场景模板码未配置完整'
    } else if (enabled && providerType === 'aliyun_dypns' && !credentialsConfigured) {
      statusError = '阿里云 PNVS 凭证未配置，无法发送或核验短信验证码'
    } else if (enabled && providerType === 'aliyun_dypns' && !ticketHmacConfigured) {
      statusError = '验证码 HMAC 密钥未配置或长度不足，无法安全关联短信核验记录'
    } else if (mnsEnabled && !mnsConfigured) {
      statusError = '已启用阿里云 MNS 回执，但阿里云访问凭证未配置'
    }

    return {
      enabled,
      ready,
      httpMethod,
      apiUrl: options.maskSensitiveValues ? this.maskSensitiveConfigValue(urlConfig.configValue) : urlConfig.configValue,
      headersTemplate: options.maskSensitiveValues ? this.maskSensitiveConfigValue(headersConfig.configValue) : headersConfig.configValue,
      bodyTemplate: options.maskSensitiveValues ? this.maskSensitiveConfigValue(bodyConfig.configValue) : bodyConfig.configValue,
      successMatch: successConfig.configValue,
      updatedAt,
      providerType,
      aliyunSignName: aliyunSignNameConfig?.configValue ?? '',
      aliyunSchemeName: aliyunSchemeNameConfig?.configValue ?? '',
      aliyunTemplates: {
        register: aliyunTemplateRegisterConfig?.configValue ?? '',
        forgotPassword: aliyunTemplateForgotPasswordConfig?.configValue ?? '',
        profileUpdate: aliyunTemplateProfileUpdateConfig?.configValue ?? '',
        test: aliyunTemplateTestConfig?.configValue ?? '',
      },
      credentialsConfigured,
      ticketHmacConfigured,
      mnsEnabled,
      mnsConfigured,
      statusError,
      headersTemplateMasked: options.maskSensitiveValues ? Boolean(headersConfig.configValue.trim()) : false,
      bodyTemplateMasked: options.maskSensitiveValues ? Boolean(bodyConfig.configValue.trim()) : false,
      apiUrlMasked: options.maskSensitiveValues ? Boolean(urlConfig.configValue.trim()) : false,
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

  private async lockOrderSerialSequences(
    manager: EntityManager,
    configList: OrderSerialConfigRecord[],
  ): Promise<Map<OrderSerialType, BusinessSequence>> {
    for (const config of configList) {
      if (manager.connection.options.type === 'mysql') {
        await manager.query(
          `
            INSERT INTO business_sequence (sequence_key, current_value, created_at, updated_at)
            VALUES (?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
            ON DUPLICATE KEY UPDATE sequence_key = sequence_key
          `,
          [ORDER_SERIAL_META[config.orderType].keyPrefix, config.current],
        )
      } else {
        await manager.query(
          `
            INSERT OR IGNORE INTO business_sequence (sequence_key, current_value, created_at, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `,
          [ORDER_SERIAL_META[config.orderType].keyPrefix, config.current],
        )
      }
    }

    const sequenceKeys = ORDER_SERIAL_TYPES.map((orderType) => ORDER_SERIAL_META[orderType].keyPrefix)
    const query = manager.getRepository(BusinessSequence)
      .createQueryBuilder('sequence')
      .where('sequence.sequenceKey IN (:...sequenceKeys)', { sequenceKeys })
      .orderBy('sequence.sequenceKey', 'ASC')
    if (manager.connection.options.type === 'mysql') {
      query.setLock('pessimistic_write')
    }
    const sequences = await query.getMany()
    if (sequences.length !== ORDER_SERIAL_TYPES.length) {
      throw new BizError('订单流水序列缺失，请联系管理员修复数据库', 500)
    }
    return new Map(
      sequences.map((sequence) => {
        const orderType = ORDER_SERIAL_TYPES.find(
          (candidate) => ORDER_SERIAL_META[candidate].keyPrefix === sequence.sequenceKey,
        )
        if (!orderType) {
          throw new BizError(`发现未知订单流水序列：${sequence.sequenceKey}`, 500)
        }
        return [orderType, sequence]
      }),
    )
  }

  private applySequenceTruth(
    configList: OrderSerialConfigRecord[],
    sequences: Map<OrderSerialType, BusinessSequence>,
  ): OrderSerialConfigRecord[] {
    return configList.map((config) => {
      const sequence = sequences.get(config.orderType)
      if (!sequence) {
        return config
      }
      const current = this.parseNonNegativeInteger(
        String(sequence.currentValue),
        `${ORDER_SERIAL_META[config.orderType].keyPrefix} 流水序列异常`,
      )
      return {
        ...config,
        current,
        updatedAt: sequence.updatedAt > config.updatedAt ? sequence.updatedAt : config.updatedAt,
      }
    })
  }

  async ensureDefaultConfigs(manager: EntityManager = AppDataSource.manager): Promise<{ insertedCount: number; totalCount: number }> {
    if (this.defaultConfigsEnsured) {
      return { insertedCount: 0, totalCount: DEFAULT_SYSTEM_CONFIGS.length }
    }
    const configRepo = manager.getRepository(SystemConfig)
    const existingConfigs = await configRepo.find({
      where: DEFAULT_SYSTEM_CONFIGS.map((config) => ({ configKey: config.configKey })),
      select: {
        id: true,
        configKey: true,
        configValue: true,
      },
    })
    const existingKeySet = new Set(existingConfigs.map((config) => config.configKey))
    const missingConfigs = DEFAULT_SYSTEM_CONFIGS.filter((config) => !existingKeySet.has(config.configKey))

    if (missingConfigs.length > 0) {
      await configRepo.insert(missingConfigs)
    }

    const legacyUpdateEntries: Array<{ id: string; configValue: string }> = []
    for (const item of CUSTOMER_SERVICE_LEGACY_DEFAULT_UPDATES) {
      const currentConfig = existingConfigs.find((config) => config.configKey === item.configKey)
      if (currentConfig?.configValue !== item.legacyValue) {
        continue
      }
      legacyUpdateEntries.push({
        id: currentConfig.id,
        configValue: item.nextValue,
      })
    }

    if (legacyUpdateEntries.length > 0) {
      await Promise.all(
        legacyUpdateEntries.map((item) =>
          configRepo.update(
            { id: item.id },
            {
              configValue: item.configValue,
            },
          ),
        ),
      )
    }

    this.defaultConfigsEnsured = true
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
    const configList = ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, configMap))
    const sequenceRows = await AppDataSource.getRepository(BusinessSequence).find({
      where: ORDER_SERIAL_TYPES.map((orderType) => ({
        sequenceKey: ORDER_SERIAL_META[orderType].keyPrefix,
      })),
    })
    const sequenceMap = new Map(
      sequenceRows.map((sequence) => {
        const orderType = ORDER_SERIAL_TYPES.find(
          (candidate) => ORDER_SERIAL_META[candidate].keyPrefix === sequence.sequenceKey,
        )
        return orderType ? [orderType, sequence] : null
      }).filter((entry): entry is [OrderSerialType, BusinessSequence] => entry !== null),
    )
    const list = this.applySequenceTruth(configList, sequenceMap)
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

    return runInTransaction(async (manager) => {
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

      const configBeforeList = ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, rowMap))
      // 锁顺序固定为 system_configs -> business_sequence，与生成单号保持一致，
      // 避免管理员更新与下单并发时形成双真源或死锁。
      const sequences = await this.lockOrderSerialSequences(manager, configBeforeList)
      const beforeList = this.applySequenceTruth(configBeforeList, sequences)
      await this.assertOrderSerialCurrentSafety(manager, beforeList, input)
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

      for (const orderType of ORDER_SERIAL_TYPES) {
        const sequence = sequences.get(orderType)
        if (!sequence) {
          throw new BizError(`订单流水序列缺失：${orderType}`, 500)
        }
        const targetCurrent = input[orderType].current
        if (Number(sequence.currentValue) === targetCurrent) {
          continue
        }
        sequence.currentValue = targetCurrent
        await manager.getRepository(BusinessSequence).save(sequence)
        changedCount += 1
      }

      const afterList = this.applySequenceTruth(
        ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, rowMap)),
        sequences,
      )

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

  /**
   * 写时失效 + 短 TTL 兜底的配置读取：
   * - buildOrderDetail 等热路径在同一次调用里会读两次、且常发生在库存行已被 pessimistic_write
   *   锁定的事务内，逐次回源查询会不必要地拉长锁持有时间；
   * - 配置变更走 updateO2oRuleConfigs，其内部会在写入后立即调用 invalidateO2oRuleConfigCache
   *   保证“改完立刻读到新值”；TTL 只是兜底，防止遗漏的写路径导致缓存长期陈旧。
   *
   * 传入事务 manager 时（isTransactionalManager 为真）一律绕过缓存，读与写都不经过它：
   * - 绕过读：事务内的调用方通常已经用 FOR UPDATE 锁定了这些行，要的就是“锁定行的真实当前值”。
   *   多实例部署下，本实例的缓存可能是其它实例更新配置之前的旧值，若此时返回缓存，
   *   updateO2oRuleConfigs 写入审计的 before 快照就会与实际被覆盖的配置不一致。
   * - 绕过写：事务尚未提交，把未提交值放进进程级缓存后，一旦事务回滚，
   *   缓存会在 TTL 窗口内向其它调用方返回从未真正落库的值。
   *   缓存改由调用方在事务成功提交后，用确认落库的结果显式发布（见 updateO2oRuleConfigs 末尾）。
   */
  async getO2oRuleConfigs(manager: EntityManager = AppDataSource.manager): Promise<O2oRuleConfigRecord> {
    const isTransactional = this.isTransactionalManager(manager)
    if (!isTransactional) {
      const cached = this.o2oRuleConfigCache
      if (cached && cached.expiresAtMs > Date.now()) {
        return cached.value
      }
    }
    await this.ensureDefaultConfigs(manager)
    const rows = await manager.getRepository(SystemConfig).find({
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
    // 统一从已加载配置中读取必填项，避免散落的非空断言掩盖真实缺配置问题。
    const getRequiredConfigValue = (configKey: string) => {
      const row = map.get(configKey)
      if (!row) {
        throw new BizError(`线上预订配置缺失：${configKey}`, 500)
      }
      return row.configValue
    }
    const autoCancelEnabled = this.parseNonNegativeInteger(getRequiredConfigValue('o2o.auto_cancel_enabled'), 'o2o.auto_cancel_enabled') > 0
    const autoCancelHours = this.parsePositiveInteger(getRequiredConfigValue('o2o.auto_cancel_hours'), 'o2o.auto_cancel_hours')
    const limitEnabled = this.parseNonNegativeInteger(getRequiredConfigValue('o2o.limit_enabled'), 'o2o.limit_enabled') > 0
    const limitQty = this.parsePositiveInteger(getRequiredConfigValue('o2o.limit_qty'), 'o2o.limit_qty')
    const clientPreorderUpdateLimit = this.parsePositiveInteger(
      getRequiredConfigValue('o2o.client_preorder_update_limit'),
      'o2o.client_preorder_update_limit',
    )
    const storeBusinessHoursText = getRequiredConfigValue('o2o.store_business_hours_text').trim()
    if (!storeBusinessHoursText) {
      throw new BizError('线上预订配置缺失：o2o.store_business_hours_text', 500)
    }
    const mallAnnouncementText = getRequiredConfigValue('o2o.mall_announcement_text').trim()
    const updatedAt = rows.map((row) => row.updatedAt).sort((a, b) => b.getTime() - a.getTime())[0]

    const record: O2oRuleConfigRecord = {
      autoCancelEnabled,
      autoCancelHours,
      limitEnabled,
      limitQty,
      clientPreorderUpdateLimit,
      storeBusinessHoursText,
      mallAnnouncementText,
      updatedAt,
    }
    if (!isTransactional) {
      this.publishO2oRuleConfigCache(record)
    }
    return record
  }

  /**
   * 判断是否处于调用方开启的事务上下文中。
   * TypeORM 的 AppDataSource.transaction() 会为回调创建独立的 EntityManager，
   * 与 AppDataSource.manager 不是同一个实例；据此即可识别“事务内读取”，
   * 无需依赖调用方逐处传参，避免遗漏。
   */
  private isTransactionalManager(manager: EntityManager): boolean {
    return manager !== AppDataSource.manager
  }

  private invalidateO2oRuleConfigCache(): void {
    this.o2oRuleConfigCache = null
  }

  private publishO2oRuleConfigCache(record: O2oRuleConfigRecord): void {
    this.o2oRuleConfigCache = { value: record, expiresAtMs: Date.now() + SystemConfigService.CONFIG_CACHE_TTL_MS }
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
    const storeBusinessHoursText = input.storeBusinessHoursText.trim()
    if (!storeBusinessHoursText) {
      throw new BizError('店铺营业时间不能为空', 400)
    }
    if (storeBusinessHoursText.length > 100) {
      throw new BizError('店铺营业时间长度不能超过 100 个字符', 400)
    }

    await this.ensureDefaultConfigs()
    const result = await runInTransaction(async (manager) => {
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

      const mallAnnouncementText = input.mallAnnouncementText.trim()
      if (mallAnnouncementText.length > 500) {
        throw new BizError('商城公告长度不能超过 500 个字符', 400)
      }

      const targetMap = new Map<string, string>([
        ['o2o.auto_cancel_enabled', input.autoCancelEnabled ? '1' : '0'],
        ['o2o.auto_cancel_hours', String(input.autoCancelHours)],
        ['o2o.limit_enabled', input.limitEnabled ? '1' : '0'],
        ['o2o.limit_qty', String(input.limitQty)],
        ['o2o.store_business_hours_text', storeBusinessHoursText],
        ['o2o.mall_announcement_text', mallAnnouncementText],
      ])
      if (input.clientPreorderUpdateLimit !== undefined) {
        targetMap.set('o2o.client_preorder_update_limit', String(input.clientPreorderUpdateLimit))
      }

      const before = await this.getO2oRuleConfigs(manager)
      let changed = false
      const repo = manager.getRepository(SystemConfig)
      for (const row of lockedRows) {
        const targetValue = targetMap.get(row.configKey)
        if (targetValue === undefined || targetValue === row.configValue) {
          continue
        }
        await repo.update({ id: row.id }, { configValue: targetValue })
        changed = true
      }

      // 传入事务 manager 的读取会自动绕过缓存（读与写都不经过），因此这里拿到的一定是
      // 本事务锁定行的真实值，也不会把未提交的写入泄露进共享缓存；
      // 仍然显式失效一次，是为了让"本次更新已发生"立刻对其它请求可见，
      // 避免它们在事务提交前继续命中写入前的旧缓存。缓存在事务提交后统一发布（见方法末尾）。
      this.invalidateO2oRuleConfigCache()
      const config = await this.getO2oRuleConfigs(manager)

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
    if (result.changed) {
      invalidateMallCatalogReadCache()
    }

    // 事务已成功提交，此时 result.config 才是确认落库的值，可以安全发布进共享缓存。
    this.publishO2oRuleConfigCache(result.config)
    return result
  }

  async getCustomerServiceConfigs(manager: EntityManager = AppDataSource.manager): Promise<CustomerServiceConfigRecord> {
    const baseConfig = await this.getCustomerServiceBaseConfig(manager)
    return {
      ...baseConfig,
      availability: this.computeCustomerServiceAvailability(
        baseConfig,
        customerServiceRealtimeService.buildServiceSessionSnapshot().serviceConnectionCount,
      ),
    }
  }

  private invalidateCustomerServiceConfigCache(): void {
    this.customerServiceBaseConfigCache = null
  }

  private publishCustomerServiceConfigCache(value: Omit<CustomerServiceConfigRecord, 'availability'>): void {
    this.customerServiceBaseConfigCache = { value, expiresAtMs: Date.now() + SystemConfigService.CONFIG_CACHE_TTL_MS }
  }

  /**
   * 只读、可缓存的客服配置静态部分：与 getO2oRuleConfigs 完全同构——
   * 同一套写时失效 + 短 TTL 策略，以及同样的“事务 manager 一律绕过缓存”规则（读与写都绕过）。
   * 必须接收调用方的事务 manager 才能读取——若固定用 this.configRepo（默认连接），
   * 在 updateCustomerServiceConfigs 的事务内回读会走另一条连接，在事务提交前看到的还是旧值，
   * 导致返回给调用方的“新配置”和审计 after 字段都错误地停留在旧值上。
   * availability 依赖的实时在线状态由调用方 getCustomerServiceConfigs 每次单独计算，不经过这层缓存。
   */
  private async getCustomerServiceBaseConfig(
    manager: EntityManager = AppDataSource.manager,
  ): Promise<Omit<CustomerServiceConfigRecord, 'availability'>> {
    const isTransactional = this.isTransactionalManager(manager)
    if (!isTransactional) {
      const cached = this.customerServiceBaseConfigCache
      if (cached && cached.expiresAtMs > Date.now()) {
        return cached.value
      }
    }
    await this.ensureDefaultConfigs(manager)
    const rows = await manager.getRepository(SystemConfig).find({
      where: this.customerServiceConfigKeys.map((key) => ({ configKey: key })),
      select: {
        configKey: true,
        configValue: true,
        updatedAt: true,
      },
    })
    if (rows.length !== this.customerServiceConfigKeys.length) {
      throw new BizError('客服中心配置缺失，请联系管理员补齐配置', 500)
    }
    const configMap = new Map(rows.map((row) => [row.configKey, row]))
    const enabledConfig = configMap.get('customer_service.enabled')
    const realtimeEnabledConfig = configMap.get('customer_service.realtime_enabled')
    const entryNoticeConfig = configMap.get('customer_service.entry_notice')
    const workdayStartConfig = configMap.get('customer_service.workday_start')
    const workdayEndConfig = configMap.get('customer_service.workday_end')
    const workdayWeekdaysConfig = configMap.get('customer_service.workday_weekdays')
    const offlineNoticeConfig = configMap.get('customer_service.offline_notice')
    const offlineFaqConfig = configMap.get('customer_service.offline_faq_json')
    const keepaliveConfig = configMap.get('customer_service.sse_keepalive_seconds')
    if (
      !enabledConfig
      || !realtimeEnabledConfig
      || !entryNoticeConfig
      || !workdayStartConfig
      || !workdayEndConfig
      || !workdayWeekdaysConfig
      || !offlineNoticeConfig
      || !offlineFaqConfig
      || !keepaliveConfig
    ) {
      throw new BizError('客服中心配置缺失，请联系管理员补齐配置', 500)
    }

    const baseConfig = {
      enabled: this.parseBooleanFlag(enabledConfig.configValue, 'customer_service.enabled'),
      realtimeEnabled: this.parseBooleanFlag(realtimeEnabledConfig.configValue, 'customer_service.realtime_enabled'),
      entryNotice: entryNoticeConfig.configValue,
      workdayStart: this.normalizeTimeText(workdayStartConfig.configValue, '客服工作开始时间'),
      workdayEnd: this.normalizeTimeText(workdayEndConfig.configValue, '客服工作结束时间'),
      workdayWeekdays: this.normalizeWeekdays(JSON.parse(workdayWeekdaysConfig.configValue) as number[]),
      offlineNotice: offlineNoticeConfig.configValue.trim(),
      offlineFaqs: this.parseCustomerServiceFaqs(offlineFaqConfig.configValue),
      sseKeepaliveSeconds: this.parsePositiveInteger(
        keepaliveConfig.configValue,
        'customer_service.sse_keepalive_seconds',
      ),
      updatedAt: [
        enabledConfig.updatedAt,
        realtimeEnabledConfig.updatedAt,
        entryNoticeConfig.updatedAt,
        workdayStartConfig.updatedAt,
        workdayEndConfig.updatedAt,
        workdayWeekdaysConfig.updatedAt,
        offlineNoticeConfig.updatedAt,
        offlineFaqConfig.updatedAt,
        keepaliveConfig.updatedAt,
      ].sort((a, b) => b.getTime() - a.getTime())[0],
    }
    if (!isTransactional) {
      this.publishCustomerServiceConfigCache(baseConfig)
    }
    return baseConfig
  }

  async updateCustomerServiceConfigs(
    input: UpdateCustomerServiceConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ config: CustomerServiceConfigRecord; changed: boolean }> {
    await this.assertAdminActor(actor, requestMeta, 'system_config.update_customer_service', '更新客服中心配置')
    const entryNotice = input.entryNotice.trim()
    if (!entryNotice) {
      throw new BizError('客服入口提示语不能为空', 400)
    }
    if (entryNotice.length > 500) {
      throw new BizError('客服入口提示语长度不能超过 500 个字符', 400)
    }
    const workdayStart = this.normalizeTimeText(input.workdayStart, '客服工作开始时间')
    const workdayEnd = this.normalizeTimeText(input.workdayEnd, '客服工作结束时间')
    const workdayWeekdays = this.normalizeWeekdays(input.workdayWeekdays)
    const offlineNotice = input.offlineNotice.trim()
    if (!offlineNotice) {
      throw new BizError('离线提示语不能为空', 400)
    }
    if (offlineNotice.length > 500) {
      throw new BizError('离线提示语长度不能超过 500 个字符', 400)
    }
    const offlineFaqs = this.normalizeCustomerServiceFaqs(input.offlineFaqs)
    if (
      !Number.isInteger(input.sseKeepaliveSeconds)
      || input.sseKeepaliveSeconds < 5
      || input.sseKeepaliveSeconds > 300
    ) {
      throw new BizError('SSE 心跳间隔必须为 5 到 300 秒的整数', 400)
    }

    await this.ensureDefaultConfigs()
    const result = await runInTransaction(async (manager) => {
      const useForUpdate = manager.connection.options.type === 'mysql'
      const placeholders = this.customerServiceConfigKeys.map(() => '?').join(', ')
      const lockedRows: Array<{ id: string; configKey: string; configValue: string; updatedAt: string }> = await manager.query(
        `
          SELECT id, config_key AS configKey, config_value AS configValue, updated_at AS updatedAt
          FROM system_configs
          WHERE config_key IN (${placeholders})
          ${useForUpdate ? 'FOR UPDATE' : ''}
        `,
        [...this.customerServiceConfigKeys],
      )
      if (lockedRows.length !== this.customerServiceConfigKeys.length) {
        throw new BizError('客服中心配置缺失，请联系管理员补齐配置', 500)
      }

      const targetMap = new Map<string, string>([
        ['customer_service.enabled', input.enabled ? '1' : '0'],
        ['customer_service.realtime_enabled', input.realtimeEnabled ? '1' : '0'],
        ['customer_service.entry_notice', entryNotice],
        ['customer_service.workday_start', workdayStart],
        ['customer_service.workday_end', workdayEnd],
        ['customer_service.workday_weekdays', JSON.stringify(workdayWeekdays)],
        ['customer_service.offline_notice', offlineNotice],
        ['customer_service.offline_faq_json', JSON.stringify(offlineFaqs)],
        ['customer_service.sse_keepalive_seconds', String(input.sseKeepaliveSeconds)],
      ])
      const before = await this.getCustomerServiceConfigs(manager)
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

      // 传入事务 manager 的读取会自动绕过缓存（读与写都不经过），因此这里拿到的一定是
      // 本事务锁定行的真实值，也不会把未提交的写入泄露进共享缓存；
      // 仍然显式失效一次，是为了让"本次更新已发生"立刻对其它请求可见。
      // 缓存在事务提交后统一发布（见方法末尾）。
      this.invalidateCustomerServiceConfigCache()
      const config = await this.getCustomerServiceConfigs(manager)
      if (changed) {
        await auditService.record(
          {
            actionType: 'system_config.update_customer_service',
            actionLabel: '更新客服中心配置',
            targetType: 'system_config',
            targetCode: 'customer_service',
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

    // 事务已成功提交，此时才把确认落库的静态配置部分发布进共享缓存；
    // availability 依赖实时在线状态，从不进入这层缓存，因此发布前需要先剔除它。
    const { availability: _availability, ...baseConfigToPublish } = result.config
    this.publishCustomerServiceConfigCache(baseConfigToPublish)
    return result
  }

  async getVerificationProviderConfigs(
    options: { maskSensitiveValues?: boolean } = { maskSensitiveValues: true },
    manager: EntityManager = AppDataSource.manager,
  ): Promise<VerificationProviderConfigsResult> {
    const map = await this.loadVerificationConfigMap(manager)
    return {
      mobile: this.formatVerificationProviderConfig('mobile', map, options),
      email: this.formatVerificationProviderConfig('email', map, options),
    }
  }

  async resolveVerificationProviderConfigInput(
    channelType: VerificationChannelType,
    input: VerificationProviderConfigInput,
  ): Promise<VerificationProviderConfigRecord> {
    const currentConfigs = await this.getVerificationProviderConfigs({ maskSensitiveValues: false })
    const normalizedInput = this.normalizeVerificationProviderInput(channelType, input, currentConfigs[channelType])
    const providerType = normalizedInput.providerType ?? 'generic_http'
    const credentialsConfigured = Boolean(env.ALIBABA_CLOUD_ACCESS_KEY_ID && env.ALIBABA_CLOUD_ACCESS_KEY_SECRET)
    const ticketHmacConfigured = (env.VERIFICATION_TICKET_HMAC_SECRET?.length ?? 0) >= 32
    const templates = {
      register: normalizedInput.aliyunTemplates?.register ?? '',
      forgotPassword: normalizedInput.aliyunTemplates?.forgotPassword ?? '',
      profileUpdate: normalizedInput.aliyunTemplates?.profileUpdate ?? '',
      test: normalizedInput.aliyunTemplates?.test ?? '',
    }
    const aliyunConfigReady = Boolean(normalizedInput.aliyunSignName?.trim())
      && Object.values(templates).every((templateCode) => templateCode.trim().length > 0)
    const ready = providerType === 'generic_http'
      ? normalizedInput.enabled && Boolean(normalizedInput.apiUrl.trim())
      : normalizedInput.enabled && aliyunConfigReady && credentialsConfigured && ticketHmacConfigured
    const statusError = !normalizedInput.enabled
      ? null
      : providerType === 'generic_http' && !normalizedInput.apiUrl.trim()
        ? `${channelType === 'mobile' ? '短信' : '邮箱'}验证码平台 API 未配置`
        : providerType === 'aliyun_dypns' && !aliyunConfigReady
          ? '阿里云 PNVS 短信签名或场景模板码未配置完整'
          : providerType === 'aliyun_dypns' && !credentialsConfigured
            ? '阿里云 PNVS 凭证未配置，无法发送或核验短信验证码'
            : providerType === 'aliyun_dypns' && !ticketHmacConfigured
              ? '验证码 HMAC 密钥未配置或长度不足，无法安全关联短信核验记录'
              : null
    return {
      enabled: normalizedInput.enabled,
      ready,
      httpMethod: normalizedInput.httpMethod,
      apiUrl: normalizedInput.apiUrl,
      headersTemplate: normalizedInput.headersTemplate,
      bodyTemplate: normalizedInput.bodyTemplate,
      successMatch: normalizedInput.successMatch,
      updatedAt: new Date(),
      providerType,
      aliyunSignName: normalizedInput.aliyunSignName ?? '',
      aliyunSchemeName: normalizedInput.aliyunSchemeName ?? '',
      aliyunTemplates: templates,
      credentialsConfigured,
      ticketHmacConfigured,
      mnsEnabled: env.ALIYUN_DYPNS_MNS_ENABLED,
      mnsConfigured: !env.ALIYUN_DYPNS_MNS_ENABLED || credentialsConfigured,
      statusError,
      headersTemplateMasked: false,
      bodyTemplateMasked: false,
      apiUrlMasked: false,
    }
  }

  async getClientDepartmentConfigs(
    manager?: EntityManager,
    options: { lockForUpdate?: boolean } = {},
  ): Promise<ClientDepartmentConfigRecord> {
    await this.ensureDefaultConfigs(manager)
    const repository = manager ? manager.getRepository(SystemConfig) : this.configRepo
    const useForUpdate = Boolean(manager && options.lockForUpdate && manager.connection.options.type === 'mysql')
    const lockedRows: Array<{ id: string; configValue: string; updatedAt: Date | string }> = useForUpdate
      ? await manager!.query(
        `
          SELECT id, config_value AS configValue, updated_at AS updatedAt
          FROM system_configs
          WHERE config_key = ?
          FOR UPDATE
        `,
        [this.clientDepartmentConfigKey],
      )
      : []
    const row = lockedRows[0] ?? await repository.findOne({
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
      updatedAt: new Date(row.updatedAt),
    }
  }

  async updateClientDepartmentConfigs(
    input: UpdateClientDepartmentConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ config: ClientDepartmentConfigRecord; changed: boolean }> {
    await this.assertAdminActor(actor, requestMeta, 'system_config.update_client_departments', '更新客户端部门配置')
    const submittedTree = Array.isArray(input.tree)
      ? this.normalizeClientDepartmentTree(input.tree)
      : null
    await this.ensureDefaultConfigs()
    return runInTransaction(async (manager) => {
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

      const beforePaths = this.buildClientDepartmentPathMap(before.tree)
      if (submittedTree === null) {
        this.assertLegacyOptionsCanRepresentTree(before.tree)
      }
      const existingNodeIdsByPath = new Map(
        [...beforePaths.entries()].map(([departmentNodeId, departmentPath]) => [departmentPath, departmentNodeId]),
      )
      // options 是旧入口，不携带节点 ID。必须在锁定当前配置后按完整路径复用旧 ID，
      // 否则无改动保存也会把已绑定账号的节点误判为删除。新路径仍生成新 ID。
      const normalizedTree = submittedTree
        ?? this.buildTreeFromOptions(input.options ?? [], false, existingNodeIdsByPath)
      const normalizedOptions = this.buildClientDepartmentOptionsFromTree(normalizedTree)
      const afterPaths = this.buildClientDepartmentPathMap(normalizedTree)
      const affectedDepartmentNodeIds = [...new Set([...beforePaths.keys(), ...afterPaths.keys()])].filter((departmentNodeId) => {
        const beforePath = beforePaths.get(departmentNodeId)
        return beforePath !== afterPaths.get(departmentNodeId)
      })
      const departmentAccountRepo = manager.getRepository(ClientUser)
      const affectedDepartmentAccounts = affectedDepartmentNodeIds.length === 0
        ? []
        : await (() => {
          const query = departmentAccountRepo
            .createQueryBuilder('user')
            .where('user.accountType = :accountType', { accountType: 'department' })
            .andWhere('user.departmentNodeId IN (:...departmentNodeIds)', { departmentNodeIds: affectedDepartmentNodeIds })
          if (useForUpdate) {
            query.setLock('pessimistic_write')
          }
          return query.getMany()
        })()
      const enabledDeletedBinding = affectedDepartmentAccounts.find((account) => (
        account.status === 'enabled' && !afterPaths.has(account.departmentNodeId ?? '')
      ))
      if (enabledDeletedBinding) {
        throw new BizError('该部门已绑定已启用部门共享账号，请先停用或重新绑定账号后再删除部门', 409)
      }
      const synchronizedDepartmentAccounts = affectedDepartmentAccounts.filter((account) => {
        const nextDepartmentName = afterPaths.get(account.departmentNodeId ?? '')
        return Boolean(nextDepartmentName) && nextDepartmentName !== account.departmentName
      })

      const targetValue = JSON.stringify({
        tree: normalizedTree,
      })
      let changed = false
      if (row.configValue !== targetValue) {
        await manager.getRepository(SystemConfig).update({ id: row.id }, { configValue: targetValue })
        for (const account of synchronizedDepartmentAccounts) {
          account.departmentName = afterPaths.get(account.departmentNodeId ?? '')!
        }
        if (synchronizedDepartmentAccounts.length > 0) {
          await departmentAccountRepo.save(synchronizedDepartmentAccounts)
        }
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
              departmentAccountSynchronization: {
                updatedAccountIds: synchronizedDepartmentAccounts.map((account) => account.id),
                orphanedAccountIds: affectedDepartmentAccounts
                  .filter((account) => !afterPaths.has(account.departmentNodeId ?? ''))
                  .map((account) => account.id),
              },
            },
          },
          manager,
        )
      }

      return { config, changed }
    })
  }

  /**
   * 批量补齐客户端部门配置：
   * - 导入教职工目录时优先按现有路径精确匹配或按唯一标签回填；
   * - 若系统里不存在该部门，则自动作为根节点追加到客户端部门树，避免管理员先手工建部门再导入；
   * - 支持复用外层事务，保证“补部门配置”和“写教职工目录”在同一事务内完成。
   */
  async ensureClientDepartmentOptions(
    departmentNames: string[],
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
    manager?: EntityManager,
  ): Promise<EnsureClientDepartmentOptionsResult> {
    await this.assertAdminActor(actor, requestMeta, 'system_config.ensure_client_departments', '自动补齐客户端部门配置')
    const normalizedDepartmentNames = [...new Set(departmentNames.map((item) => this.normalizeDepartmentLabel(item)))]
    if (normalizedDepartmentNames.length === 0) {
      const config = await this.getClientDepartmentConfigs()
      return {
        config,
        changed: false,
        createdDepartments: [],
        resolvedDepartmentMap: new Map<string, string>(),
      }
    }

    await this.ensureDefaultConfigs()
    const execute = async (transactionManager: EntityManager): Promise<EnsureClientDepartmentOptionsResult> => {
      const useForUpdate = transactionManager.connection.options.type === 'mysql'
      const lockedRows: Array<{ id: string; configValue: string; updatedAt: string }> = await transactionManager.query(
        `
          SELECT id, config_value AS configValue, updated_at AS updatedAt
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
      let workingTree = before.tree.map((node) => ({ ...node, children: [...node.children] }))
      const createdDepartments: string[] = []
      const resolvedDepartmentMap = new Map<string, string>()

      for (const departmentName of normalizedDepartmentNames) {
        if (before.options.includes(departmentName) || this.flattenDepartmentTree(workingTree).includes(departmentName)) {
          resolvedDepartmentMap.set(departmentName, departmentName)
          continue
        }
        const matchedPaths = this.findDepartmentPathsByLabel(workingTree, departmentName)
        if (matchedPaths.length === 1) {
          resolvedDepartmentMap.set(departmentName, matchedPaths[0])
          continue
        }
        if (matchedPaths.length > 1) {
          throw new BizError(`部门“${departmentName}”存在多个同名节点，请先在系统配置中明确路径后再导入`, 400)
        }
        workingTree = [
          ...workingTree,
          {
            id: this.createDepartmentNodeId(`${departmentName}-${workingTree.length + 1}`),
            label: departmentName,
            children: [],
          },
        ]
        createdDepartments.push(departmentName)
        resolvedDepartmentMap.set(departmentName, departmentName)
      }

      const normalizedTree = this.normalizeClientDepartmentTree(workingTree)
      const normalizedOptions = this.buildClientDepartmentOptionsFromTree(normalizedTree)
      const targetValue = JSON.stringify({ tree: normalizedTree })
      const changed = row.configValue !== targetValue

      if (changed) {
        await transactionManager.getRepository(SystemConfig).update({ id: row.id }, { configValue: targetValue })
      }

      const config: ClientDepartmentConfigRecord = {
        tree: normalizedTree,
        options: normalizedOptions,
        updatedAt: changed ? new Date() : new Date(row.updatedAt),
      }

      if (changed) {
        await auditService.record(
          {
            actionType: 'system_config.ensure_client_departments',
            actionLabel: '自动补齐客户端部门配置',
            targetType: 'system_config',
            targetCode: 'client_departments',
            actor,
            requestMeta,
            detail: {
              before,
              after: config,
              createdDepartments,
            },
          },
          transactionManager,
        )
      }

      return {
        config,
        changed,
        createdDepartments,
        resolvedDepartmentMap,
      }
    }

    return manager ? execute(manager) : runInTransaction(execute)
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

  async resolveClientDepartmentNode(
    departmentNodeId: string,
    manager?: EntityManager,
    config?: ClientDepartmentConfigRecord,
  ): Promise<ResolvedClientDepartmentNode> {
    const normalizedNodeId = this.normalizeDepartmentNodeId(departmentNodeId)
    const currentConfig = config ?? await this.getClientDepartmentConfigs(manager)
    const walk = (nodes: ClientDepartmentTreeNode[], parentPath = ''): ResolvedClientDepartmentNode | null => {
      for (const node of nodes) {
        const departmentName = parentPath ? `${parentPath}-${node.label}` : node.label
        if (node.id === normalizedNodeId) {
          return { departmentNodeId: node.id, departmentName, label: node.label }
        }
        const childResult = walk(node.children, departmentName)
        if (childResult) {
          return childResult
        }
      }
      return null
    }
    const resolved = walk(currentConfig.tree)
    if (!resolved) {
      throw new BizError('指定部门节点不存在或已被删除，请刷新后重试', 400)
    }
    return resolved
  }

  async resolveClientDepartmentReference(input: {
    departmentNodeId?: string
    departmentName?: string
  }, manager?: EntityManager, config?: ClientDepartmentConfigRecord): Promise<ResolvedClientDepartmentNode> {
    if (input.departmentNodeId?.trim()) {
      return this.resolveClientDepartmentNode(input.departmentNodeId, manager, config)
    }
    const currentConfig = config ?? await this.getClientDepartmentConfigs(manager)
    const rawDepartmentName = input.departmentName?.trim() ?? ''
    let normalizedDepartmentName = rawDepartmentName
    if (rawDepartmentName && !currentConfig.options.includes(rawDepartmentName)) {
      const matchedPaths = this.findDepartmentPathsByLabel(currentConfig.tree, rawDepartmentName)
      if (matchedPaths.length === 1) {
        normalizedDepartmentName = matchedPaths[0]
      } else if (matchedPaths.length > 1) {
        throw new BizError(`部门“${rawDepartmentName}”存在多个同名节点，请使用完整部门路径`, 400)
      } else {
        throw new BizError(`部门“${rawDepartmentName}”不在可选范围内，请重新选择`, 400)
      }
    }
    if (!normalizedDepartmentName) {
      throw new BizError('部门共享账号必须选择所属部门', 400)
    }
    const walk = (nodes: ClientDepartmentTreeNode[], parentPath = ''): ResolvedClientDepartmentNode | null => {
      for (const node of nodes) {
        const departmentName = parentPath ? `${parentPath}-${node.label}` : node.label
        if (departmentName === normalizedDepartmentName) {
          return { departmentNodeId: node.id, departmentName, label: node.label }
        }
        const childResult = walk(node.children, departmentName)
        if (childResult) return childResult
      }
      return null
    }
    const resolved = walk(currentConfig.tree)
    if (!resolved) {
      throw new BizError('部门配置缺少稳定节点ID，请重新保存部门树后重试', 500)
    }
    return resolved
  }

  async updateVerificationProviderConfigs(
    input: UpdateVerificationProviderConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ config: VerificationProviderConfigsResult; changed: boolean }> {
    await this.assertAdminActor(actor, requestMeta, 'system_config.update_verification_providers', '更新验证码平台配置')
    return runInTransaction(async (manager) => {
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

      const lockedConfigMap = this.buildVerificationConfigMap(lockedRows.map((row) => ({
        configKey: row.configKey,
        configValue: row.configValue,
        updatedAt: new Date(row.updatedAt),
      })))
      const before = {
        mobile: this.formatVerificationProviderConfig('mobile', lockedConfigMap, { maskSensitiveValues: false }),
        email: this.formatVerificationProviderConfig('email', lockedConfigMap, { maskSensitiveValues: false }),
      }
      const normalizedMobile = this.normalizeVerificationProviderInput('mobile', input.mobile, before.mobile)
      const normalizedEmail = this.normalizeVerificationProviderInput('email', input.email, before.email)

      const targetMap = new Map<string, string>([
        ['verification.mobile.enabled', normalizedMobile.enabled ? '1' : '0'],
        ['verification.mobile.provider_type', normalizedMobile.providerType ?? 'generic_http'],
        ['verification.mobile.aliyun_sign_name', normalizedMobile.aliyunSignName ?? ''],
        ['verification.mobile.aliyun_scheme_name', normalizedMobile.aliyunSchemeName ?? ''],
        ['verification.mobile.aliyun_template_register', normalizedMobile.aliyunTemplates?.register ?? ''],
        ['verification.mobile.aliyun_template_forgot_password', normalizedMobile.aliyunTemplates?.forgotPassword ?? ''],
        ['verification.mobile.aliyun_template_profile_update', normalizedMobile.aliyunTemplates?.profileUpdate ?? ''],
        ['verification.mobile.aliyun_template_test', normalizedMobile.aliyunTemplates?.test ?? ''],
        ['verification.mobile.http_method', normalizedMobile.httpMethod],
        ['verification.mobile.api_url', normalizedMobile.apiUrl],
        ['verification.mobile.headers_template', normalizedMobile.headersTemplate],
        ['verification.mobile.body_template', normalizedMobile.bodyTemplate],
        ['verification.mobile.success_match', normalizedMobile.successMatch],
        ['verification.email.enabled', normalizedEmail.enabled ? '1' : '0'],
        ['verification.email.http_method', normalizedEmail.httpMethod],
        ['verification.email.api_url', normalizedEmail.apiUrl],
        ['verification.email.headers_template', normalizedEmail.headersTemplate],
        ['verification.email.body_template', normalizedEmail.bodyTemplate],
        ['verification.email.success_match', normalizedEmail.successMatch],
      ])

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

      // 必须复用当前事务的 manager；MySQL 的全局仓库连接看不到尚未提交的更新。
      const config = await this.getVerificationProviderConfigs({ maskSensitiveValues: true }, manager)
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
              before: {
                mobile: this.sanitizeVerificationConfigForAudit(before.mobile),
                email: this.sanitizeVerificationConfigForAudit(before.email),
              },
              after: {
                mobile: this.sanitizeVerificationConfigForAudit({
                  ...config.mobile,
                  headersTemplateMasked: false,
                  bodyTemplateMasked: false,
                }),
                email: this.sanitizeVerificationConfigForAudit({
                  ...config.email,
                  headersTemplateMasked: false,
                  bodyTemplateMasked: false,
                }),
              },
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
