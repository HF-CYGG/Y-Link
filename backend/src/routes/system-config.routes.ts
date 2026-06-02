/**
 * 文件说明：系统配置路由，负责后台维护单号规则、O2O 业务规则、验证码渠道以及客户端部门相关配置。
 * 实现逻辑：路由层先用 Zod 校验请求体和查询参数，再结合权限中间件与服务层完成配置读取、更新、测试发送和目录同步。
 * 维护重点：新增配置项时需要同步关注配置键名、前端表单字段以及操作审计所依赖的请求上下文。
 */

import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { systemConfigService } from '../services/system-config.service.js'
import type { UpdateClientDepartmentConfigsInput } from '../services/system-config.service.js'
import { verificationCodeService } from '../services/verification-code.service.js'
import { clientStaffDirectoryService } from '../services/client-staff-directory.service.js'
import { CLIENT_STAFF_DIRECTORY_STATUSES } from '../entities/client-staff-directory.entity.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const orderSerialConfigValueSchema = z.object({
  start: z.number().int().positive(),
  current: z.number().int().nonnegative(),
  width: z.number().int().min(1).max(12),
})

const updateOrderSerialConfigsSchema = z.object({
  department: orderSerialConfigValueSchema,
  walkin: orderSerialConfigValueSchema,
})

const updateO2oRuleConfigsSchema = z.object({
  autoCancelEnabled: z.boolean(),
  autoCancelHours: z.number().int().min(1).max(168),
  limitEnabled: z.boolean(),
  limitQty: z.number().int().min(1).max(999),
  clientPreorderUpdateLimit: z.number().int().min(1).max(999).optional(),
  storeBusinessHoursText: z.string().trim().min(1).max(100),
})

const verificationProviderChannelSchema = z.object({
  enabled: z.boolean(),
  httpMethod: z.enum(['POST', 'GET']),
  apiUrl: z.string().max(500),
  headersTemplate: z.string().max(5000),
  bodyTemplate: z.string().max(10000),
  successMatch: z.string().max(500),
})

const updateVerificationProviderConfigsSchema = z.object({
  mobile: verificationProviderChannelSchema,
  email: verificationProviderChannelSchema,
})

const updateCustomerServiceConfigsSchema = z.object({
  enabled: z.boolean(),
  realtimeEnabled: z.boolean(),
  entryNotice: z.string().trim().min(1).max(500),
  workdayStart: z.string().trim().regex(/^\d{2}:\d{2}$/),
  workdayEnd: z.string().trim().regex(/^\d{2}:\d{2}$/),
  workdayWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  offlineNotice: z.string().trim().min(1).max(500),
  offlineFaqs: z.array(
    z.object({
      question: z.string().trim().min(1).max(100),
      answer: z.string().trim().min(1).max(1000),
    }),
  ).max(20),
  sseKeepaliveSeconds: z.number().int().min(5).max(300),
})

const clientDepartmentTreeNodeSchema: z.ZodType<{
  id?: string
  label: string
  children?: Array<{ id?: string; label: string; children?: unknown[] }>
}> = z.lazy(() =>
  z.object({
    id: z.string().trim().max(128).optional(),
    label: z.string().trim().min(1).max(32),
    children: z.array(clientDepartmentTreeNodeSchema).max(50).optional(),
  }),
)

const updateClientDepartmentConfigsSchema = z
  .object({
    tree: z.array(clientDepartmentTreeNodeSchema).max(50).optional(),
    options: z.array(z.string().trim().min(1).max(32)).max(50).optional(),
  })
  .refine((value) => Array.isArray(value.tree) || Array.isArray(value.options), {
    message: '部门配置参数缺失',
  })

const normalizeClientDepartmentTreePayload = (
  tree: Array<{ id?: string; label: string; children?: unknown[] }>,
): NonNullable<UpdateClientDepartmentConfigsInput['tree']> => {
  return tree.map((node) => ({
    id: node.id?.trim() || '',
    label: node.label,
    children: Array.isArray(node.children)
      ? normalizeClientDepartmentTreePayload(node.children as Array<{ id?: string; label: string; children?: unknown[] }>)
      : [],
  }))
}

const readSingleQueryValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    const firstString = value.find((item) => typeof item === 'string')
    return typeof firstString === 'string' ? firstString : undefined
  }
  return undefined
}

const testVerificationProviderSchema = z.object({
  channel: z.enum(['mobile', 'email']),
  target: z.string().trim().min(1).max(200),
  config: verificationProviderChannelSchema,
})

const clientStaffDirectoryStatusSchema = z.enum(CLIENT_STAFF_DIRECTORY_STATUSES)

const clientStaffDirectoryRecordSchema = z.object({
  staffNo: z.string().trim().min(1).max(64),
  realName: z.string().trim().min(1).max(128),
  departmentName: z.string().trim().min(1).max(128),
  status: clientStaffDirectoryStatusSchema.optional(),
})

const createClientStaffDirectorySchema = clientStaffDirectoryRecordSchema

const updateClientStaffDirectorySchema = z.object({
  staffNo: z.string().trim().min(1).max(64),
  realName: z.string().trim().min(1).max(128),
  departmentName: z.string().trim().min(1).max(128),
})

const updateClientStaffDirectoryStatusSchema = z.object({
  status: clientStaffDirectoryStatusSchema,
})

const importClientStaffDirectorySchema = z
  .object({
    rows: z.array(clientStaffDirectoryRecordSchema).max(5000).optional(),
    rawText: z.string().max(2000000).optional(),
  })
  .refine((value) => (Array.isArray(value.rows) && value.rows.length > 0) || Boolean(value.rawText?.trim()), {
    message: '教职工目录导入参数缺失',
  })

const STAFF_DIRECTORY_IMPORT_ALLOWED_EXTENSIONS = new Set(['.txt', '.xlsx'])
const STAFF_DIRECTORY_IMPORT_ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
])
const STAFF_DIRECTORY_IMPORT_MAX_FILE_SIZE = 8 * 1024 * 1024

const staffDirectoryImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: STAFF_DIRECTORY_IMPORT_MAX_FILE_SIZE,
  },
  fileFilter: (_req, file, cb) => {
    const normalizedExtension = path.extname(file.originalname).toLowerCase()
    const normalizedMimeType = (file.mimetype || '').toLowerCase()
    if (
      STAFF_DIRECTORY_IMPORT_ALLOWED_EXTENSIONS.has(normalizedExtension)
      && (!normalizedMimeType || STAFF_DIRECTORY_IMPORT_ALLOWED_MIME_TYPES.has(normalizedMimeType))
    ) {
      cb(null, true)
      return
    }
    cb(new BizError('仅支持上传 txt 或 xlsx 文件', 400))
  },
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const systemConfigRouter = Router()

systemConfigRouter.get(
  '/order-serial',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getOrderSerialConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/order-serial',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateOrderSerialConfigsSchema.parse(req.body)
    const data = await systemConfigService.updateOrderSerialConfigs(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.get(
  '/o2o-rules',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getO2oRuleConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/o2o-rules',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateO2oRuleConfigsSchema.parse(req.body)
    const data = await systemConfigService.updateO2oRuleConfigs(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.get(
  '/customer-service',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getCustomerServiceConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/customer-service',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateCustomerServiceConfigsSchema.parse(req.body)
    const data = await systemConfigService.updateCustomerServiceConfigs(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.get(
  '/verification-providers',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getVerificationProviderConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/verification-providers',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateVerificationProviderConfigsSchema.parse(req.body)
    const data = await systemConfigService.updateVerificationProviderConfigs(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.post(
  '/verification-providers/test-send',
  requirePermission('verification_providers:test'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = testVerificationProviderSchema.parse(req.body)
    const data = await verificationCodeService.sendTest({
      channel: payload.channel,
      target: payload.target,
      config: payload.config,
      actor: authReq.auth,
      requestMeta: extractRequestMeta(req),
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.get(
  '/client-departments',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getClientDepartmentConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/client-departments',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateClientDepartmentConfigsSchema.parse(req.body)
    const normalizedPayload: UpdateClientDepartmentConfigsInput = {
      options: payload.options,
      tree: payload.tree ? normalizeClientDepartmentTreePayload(payload.tree) : undefined,
    }
    const data = await systemConfigService.updateClientDepartmentConfigs(normalizedPayload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.get(
  '/client-staff-directory',
  requirePermission('system_configs:view'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const page = Number.parseInt(readSingleQueryValue(req.query.page) ?? '1', 10)
    const pageSize = Number.parseInt(readSingleQueryValue(req.query.pageSize) ?? '20', 10)
    const statusInput = (readSingleQueryValue(req.query.status) ?? '').trim()
    const keywordInput = (readSingleQueryValue(req.query.keyword) ?? '').trim()
    const data = await clientStaffDirectoryService.list({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      keyword: keywordInput || undefined,
      status: statusInput ? clientStaffDirectoryStatusSchema.parse(statusInput) : undefined,
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.post(
  '/client-staff-directory',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = createClientStaffDirectorySchema.parse(req.body)
    const data = await clientStaffDirectoryService.create(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/client-staff-directory/:id',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateClientStaffDirectorySchema.parse(req.body)
    const data = await clientStaffDirectoryService.update(String(req.params.id ?? '').trim(), payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.patch(
  '/client-staff-directory/:id/status',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateClientStaffDirectoryStatusSchema.parse(req.body)
    const data = await clientStaffDirectoryService.updateStatus(
      String(req.params.id ?? '').trim(),
      payload,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.post(
  '/client-staff-directory/import/preview',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  staffDirectoryImportUpload.single('file'),
  asyncHandler(async (req, res) => {
    const payload = req.file
      ? await clientStaffDirectoryService.parseImportFile({
          buffer: req.file.buffer,
          originalName: req.file.originalname,
        })
      : importClientStaffDirectorySchema.parse(req.body)
    const data = await clientStaffDirectoryService.previewImport(payload)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.post(
  '/client-staff-directory/import',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  staffDirectoryImportUpload.single('file'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = req.file
      ? await clientStaffDirectoryService.parseImportFile({
          buffer: req.file.buffer,
          originalName: req.file.originalname,
        })
      : importClientStaffDirectorySchema.parse(req.body)
    const data = await clientStaffDirectoryService.importRows(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
