/**
 * 文件说明：商品管理路由，负责商品列表筛选、单条维护、批量导入以及标签和库存相关后台操作。
 * 实现逻辑：先在路由层规范化布尔值和数值筛选参数，再结合权限中间件把商品写入、批量处理和查询请求分发到商品服务。
 * 维护重点：新增商品字段或筛选条件时，需要同步检查 Zod 预处理逻辑、实体约束以及批量导入的数据兼容性。
 */

import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAnyPermission, requirePermission } from '../middleware/auth.middleware.js'
import { productExcelService } from '../services/product-excel.service.js'
import { productImportYzService, type YzImportResolution } from '../services/product-import-yz.service.js'
import { batchCreateProducts, productService, type ProductView } from '../services/product.service.js'
import { SPEC_VALUE_MAX_LENGTH } from '../services/product-code.service.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import type { AuthenticatedRequest } from '../types/auth.js'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const productImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mimeType = (file.mimetype || '').toLowerCase()
    if (path.extname(file.originalname).toLowerCase() === '.xlsx' && (!mimeType || mimeType === XLSX_MIME || mimeType === 'application/octet-stream')) {
      cb(null, true)
      return
    }
    cb(new BizError('仅支持上传 .xlsx 文件', 400))
  },
})

const requireUploadedFile = (file: Express.Multer.File | undefined) => {
  if (!file) throw new BizError('请选择要导入的 Excel 文件', 400)
  return file.buffer
}

const sendXlsx = (res: import('express').Response, fileName: string, buffer: Buffer) => {
  res.setHeader('Content-Type', XLSX_MIME)
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.send(buffer)
}

/**
 * 成本价属于经营敏感数据：只有具备商品维护权限的账号可见。
 * 供货方等只有 products:view 的账号读取商品、扫码识别或导出时，统一抹掉成本价。
 */
const canViewCostPrice = (req: import('express').Request) =>
  (req as AuthenticatedRequest).auth.permissions.includes('products:manage')
const maskSkuCostPrice = <T extends { costPrice: string | null }>(sku: T): T => ({ ...sku, costPrice: null })
const maskProductCostPrice = (product: ProductView): ProductView => ({ ...product, skus: product.skus.map(maskSkuCostPrice) })

const productTagIdSchema = z.union([z.string(), z.number()])

const optionalNonNegativeNumberSchema = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) {
    return undefined
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim()
    return normalizedValue ? Number(normalizedValue) : undefined
  }

  return value
}, z.number().min(0).optional())

const optionalBooleanSchema = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) {
    return undefined
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase()
    if (normalizedValue === 'true' || normalizedValue === '1') {
      return true
    }
    if (normalizedValue === 'false' || normalizedValue === '0') {
      return false
    }
  }

  if (value === 1) {
    return true
  }
  if (value === 0) {
    return false
  }

  return value
}, z.boolean().optional())

const optionalGeneratedProductCodeSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim()
    return normalizedValue || undefined
  }

  return value
}, z.string().min(1).optional())

const productSpecGroupSchema = z.object({
  name: z.string().trim().min(1).max(32),
  values: z.array(z.string().trim().min(1).max(64)).min(1),
})

const productSkuSchema = z.object({
  id: productTagIdSchema.optional(),
  skuCode: z.string().trim().min(1).max(96).optional(),
  specValues: z.record(z.string().trim().min(1).max(32), z.string().trim().min(1).max(64)).optional(),
  defaultPrice: optionalNonNegativeNumberSchema,
  discountRate: z.number().min(1).max(10).optional(),
  currentStock: z.number().int().nonnegative().optional(),
  preOrderedStock: z.number().int().nonnegative().optional(),
  isActive: optionalBooleanSchema,
  isCurrent: optionalBooleanSchema,
  o2oRecommended: optionalBooleanSchema,
  thumbnail: z.string().max(255).nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  barcode: z.string().max(64).nullable().optional(),
  costPrice: z.number().min(0).nullable().optional(),
  locationId: productTagIdSchema.nullable().optional(),
})

const defaultSkuSchema = z.object({
  barcode: z.string().max(64).nullable().optional(),
  costPrice: z.number().min(0).nullable().optional(),
  locationId: productTagIdSchema.nullable().optional(),
}).optional()

const createProductSchema = z.object({
  productCode: optionalGeneratedProductCodeSchema,
  productName: z.string().trim().min(1, 'productName 不能为空'),
  pinyinAbbr: z.string().optional(),
  defaultPrice: optionalNonNegativeNumberSchema,
  discountRate: z.number().min(1).max(10).optional(),
  isActive: optionalBooleanSchema,
  o2oStatus: z.enum(['listed', 'unlisted']).optional(),
  o2oRecommended: optionalBooleanSchema,
  thumbnail: z.string().max(255).nullable().optional(),
  detailContent: z.string().nullable().optional(),
  limitPerUser: z.number().int().positive().optional(),
  currentStock: z.number().int().nonnegative().optional(),
  preOrderedStock: z.number().int().nonnegative().optional(),
  tagIds: z.array(productTagIdSchema).optional(),
  categoryId: productTagIdSchema.nullable().optional(),
  defaultSku: defaultSkuSchema,
  specGroups: z.array(productSpecGroupSchema).optional(),
  skus: z.array(productSkuSchema).optional(),
  // 非空时走 YZ 通用 SKU 编码体系：productCode 由系统按该系列生成，不能手工填写。
  primarySeriesTagId: z.string().min(1).nullable().optional(),
})

const updateProductSchema = z.object({
  productCode: z.string().optional(),
  productName: z.string().trim().min(1, 'productName 不能为空').optional(),
  pinyinAbbr: z.string().optional(),
  defaultPrice: optionalNonNegativeNumberSchema,
  discountRate: z.number().min(1).max(10).optional(),
  isActive: optionalBooleanSchema,
  o2oStatus: z.enum(['listed', 'unlisted']).optional(),
  o2oRecommended: optionalBooleanSchema,
  thumbnail: z.string().max(255).nullable().optional(),
  detailContent: z.string().nullable().optional(),
  limitPerUser: z.number().int().positive().optional(),
  currentStock: z.number().int().nonnegative().optional(),
  preOrderedStock: z.number().int().nonnegative().optional(),
  tagIds: z.array(productTagIdSchema).optional(),
  categoryId: productTagIdSchema.nullable().optional(),
  defaultSku: defaultSkuSchema,
  specGroups: z.array(productSpecGroupSchema).optional(),
  skus: z.array(productSkuSchema).optional(),
  // YZ 编码商品本批不支持切换系列，传入与当前值不同的值会被服务层拒绝。
  primarySeriesTagId: z.string().min(1).nullable().optional(),
  // 编辑弹窗打开时读取到的库存基线；提交库存与数据库不一致时，服务端据此判断是否被出入库并发改动。
  stockBaseline: z.object({
    currentStock: z.number().int().nonnegative().optional(),
    skus: z.array(z.object({
      id: productTagIdSchema,
      currentStock: z.number().int().nonnegative(),
    })).optional(),
  }).optional(),
})

const batchUpdateProductSchema = z
  .object({
    ids: z.array(productTagIdSchema).min(1, '至少选择一个产品'),
    isActive: optionalBooleanSchema,
  })
  .refine((payload) => typeof payload.isActive === 'boolean', {
    message: '至少提供一个可更新字段',
  })

const batchCreateProductSchema = z.object({
  products: z.array(createProductSchema).min(1, '至少新增一个产品').max(50, '单次最多新增 50 个产品'),
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const productRouter = Router()

productRouter.get(
  '/',
  // 商品列表/筛选属于读取能力，统一要求 products:view。
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const isActiveRaw = req.query.isActive
    const isActive =
      typeof isActiveRaw === 'string'
        ? isActiveRaw === '1' || isActiveRaw.toLowerCase() === 'true'
        : undefined

    const data = await productService.list({
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
      tagId: typeof req.query.tagId === 'string' ? req.query.tagId : undefined,
      categoryId: typeof req.query.categoryId === 'string' && req.query.categoryId ? req.query.categoryId : undefined,
      isActive,
      o2oStatus:
        req.query.o2oStatus === 'listed' || req.query.o2oStatus === 'unlisted'
          ? req.query.o2oStatus
          : undefined,
    })

    res.json({
      code: 0,
      message: 'ok',
      data: canViewCostPrice(req) ? data : data.map(maskProductCostPrice),
    })
  }),
)

productRouter.get(
  '/paged',
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const isActiveRaw = req.query.isActive
    const isActive =
      typeof isActiveRaw === 'string'
        ? isActiveRaw === '1' || isActiveRaw.toLowerCase() === 'true'
        : undefined
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)

    const data = await productService.listPaged({
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
      tagId: typeof req.query.tagId === 'string' ? req.query.tagId : undefined,
      categoryId: typeof req.query.categoryId === 'string' && req.query.categoryId ? req.query.categoryId : undefined,
      isActive,
      o2oStatus:
        req.query.o2oStatus === 'listed' || req.query.o2oStatus === 'unlisted'
          ? req.query.o2oStatus
          : undefined,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    })

    res.json({
      code: 0,
      message: 'ok',
      data: canViewCostPrice(req) ? data : { ...data, list: data.list.map(maskProductCostPrice) },
    })
  }),
)

productRouter.post(
  '/batch',
  // 批量更新商品状态属于管理操作，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = batchUpdateProductSchema.parse(req.body)
    const data = await productService.batchUpdate(payload, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.post(
  '/batch-create',
  // 批量新增商品属于管理操作，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = batchCreateProductSchema.parse(req.body)
    const data = await batchCreateProducts(payload.products, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.get(
  '/lookup',
  // 扫码识别：库存作业与盘点页面共用；purpose=stocktake 时不返回库存数量，避免盲盘泄露账面数。
  requireAnyPermission('products:view', 'inventory:view', 'stocktake:count'),
  asyncHandler(async (req, res) => {
    const auth = (req as AuthenticatedRequest).auth
    const code = typeof req.query.code === 'string' ? req.query.code : ''
    const data = await productService.lookupByCode(code)
    const hideStock = req.query.purpose === 'stocktake'
      || !(auth.permissions.includes('inventory:view') || auth.permissions.includes('products:view'))
    if (hideStock) {
      data.sku = { ...data.sku, currentStock: 0, preOrderedStock: 0, availableStock: 0 }
    }
    if (!canViewCostPrice(req)) {
      data.sku = maskSkuCostPrice(data.sku)
    }
    res.json({ code: 0, message: 'ok', data: { ...data, stockHidden: hideStock } })
  }),
)

productRouter.post(
  '/labels',
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const payload = z.object({ skuIds: z.array(productTagIdSchema).min(1).max(500) }).parse(req.body)
    res.json({ code: 0, message: 'ok', data: await productService.listLabels(payload.skuIds) })
  }),
)

productRouter.get(
  '/export',
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const buffer = await productExcelService.exportProducts({ includeCostPrice: canViewCostPrice(req) })
    sendXlsx(res, `products-${new Date().toISOString().slice(0, 10)}.xlsx`, buffer)
  }),
)

productRouter.get(
  '/import/template',
  requirePermission('products:import'),
  asyncHandler(async (_req, res) => {
    sendXlsx(res, 'product-import-template.xlsx', await productExcelService.buildTemplate())
  }),
)

productRouter.post(
  '/import/preview',
  requirePermission('products:import'),
  productImportUpload.single('file'),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, message: 'ok', data: await productExcelService.preview(requireUploadedFile(req.file)) })
  }),
)

productRouter.post(
  '/import',
  requirePermission('products:import', 'products:manage'),
  productImportUpload.single('file'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await productExcelService.importProducts(requireUploadedFile(req.file), authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

const yzImportResolutionSchema = z.object({
  groupKey: z.string().min(1),
  kind: z.enum(['multi_product_name', 'axis_ambiguous']),
  value: z.string().min(1),
})

const parseYzImportResolutions = (raw: unknown): YzImportResolution[] => {
  if (raw === undefined || raw === null || raw === '') return []
  const parsedJson = typeof raw === 'string' ? (() => {
    try {
      return JSON.parse(raw)
    } catch {
      throw new BizError('待确认项参数格式不正确', 400)
    }
  })() : raw
  const result = z.array(yzImportResolutionSchema).safeParse(parsedJson)
  if (!result.success) {
    throw new BizError('待确认项参数格式不正确', 400)
  }
  return result.data
}

productRouter.get(
  '/import-yz/template',
  requirePermission('products:import'),
  asyncHandler(async (_req, res) => {
    sendXlsx(res, 'product-import-yz-template.xlsx', await productImportYzService.buildTemplate())
  }),
)

productRouter.post(
  '/import-yz/preview',
  requirePermission('products:import'),
  productImportUpload.single('file'),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, message: 'ok', data: await productImportYzService.preview(requireUploadedFile(req.file)) })
  }),
)

productRouter.post(
  '/import-yz',
  requirePermission('products:import', 'products:manage'),
  productImportUpload.single('file'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const resolutions = parseYzImportResolutions(req.body?.resolutions)
    const data = await productImportYzService.importProducts(
      requireUploadedFile(req.file),
      resolutions,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

productRouter.get(
  '/:id',
  // 查看商品详情属于读取能力，需要 products:view。
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const data = await productService.detail(req.params.id)
    res.json({
      code: 0,
      message: 'ok',
      data: canViewCostPrice(req) ? data : maskProductCostPrice(data),
    })
  }),
)

productRouter.post(
  '/',
  // 新增商品属于管理操作，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = createProductSchema.parse(req.body)
    const data = await productService.create(payload, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.put(
  '/:id',
  // 编辑商品属于管理操作，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateProductSchema.parse(req.body)
    const data = await productService.update(req.params.id, payload, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.delete(
  '/:id',
  // 删除商品属于高风险管理操作，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    await productService.delete(req.params.id, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data: true,
    })
  }),
)

const yzCodeUpgradeSchema = z.object({
  primarySeriesTagId: z.string().min(1, '请选择要升级到的文创系列'),
})

productRouter.post(
  '/:id/yz-code-upgrade/preview',
  // 只读预检，权限口径与商品维护一致，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const payload = yzCodeUpgradeSchema.parse(req.body)
    const data = await productService.previewProductYzUpgrade(req.params.id, payload.primarySeriesTagId)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.post(
  '/:id/yz-code-upgrade',
  // 存量商品逐个手动升级到 YZ 编码，属于管理操作，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = yzCodeUpgradeSchema.parse(req.body)
    const data = await productService.upgradeProductToYzCode(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

const specAxisSchema = z.enum(['variant', 'size'])

const specValueRenameSchema = z.object({
  axis: specAxisSchema,
  // P2-D 修复：与登记表 spec_value 列（VARCHAR(64)）上限对齐，避免超长值绕过前端直达服务层才报错，
  // 或在 MySQL/SQLite 两库间行为不一致（MySQL 严格模式抛异常，SQLite 静默截断/接受）。
  oldValue: z.string().min(1, '请提供原取值').max(SPEC_VALUE_MAX_LENGTH, `原取值不能超过 ${SPEC_VALUE_MAX_LENGTH} 个字符`),
  newValue: z.string().min(1, '请提供新取值').max(SPEC_VALUE_MAX_LENGTH, `新取值不能超过 ${SPEC_VALUE_MAX_LENGTH} 个字符`),
})

productRouter.post(
  '/:id/spec-value-rename',
  // 规格取值重命名（编码位不变），属于管理操作，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = specValueRenameSchema.parse(req.body)
    const data = await productService.renameProductSpecValue(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

const zeroSpecEvolveSchema = z.object({
  axis: specAxisSchema,
  mode: z.enum(['inherit', 'retain']),
  inheritValue: z.string().optional(),
})

productRouter.post(
  '/:id/zero-spec-evolve',
  // 0 号规格演进（继承/保留），属于管理操作，需要 products:manage。
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = zeroSpecEvolveSchema.parse(req.body)
    const data = await productService.evolveProductZeroSpec(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
