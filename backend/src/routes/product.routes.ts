import { Router } from 'express'
import { z } from 'zod'
import { productService } from '../services/product.service.js'
import { asyncHandler } from '../utils/async-handler.js'

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

const createProductSchema = z.object({
  productCode: optionalGeneratedProductCodeSchema,
  productName: z.string().trim().min(1, 'productName 不能为空'),
  pinyinAbbr: z.string().optional(),
  defaultPrice: optionalNonNegativeNumberSchema,
  isActive: optionalBooleanSchema,
  tagIds: z.array(productTagIdSchema).optional(),
})

const updateProductSchema = z.object({
  productCode: z.string().optional(),
  productName: z.string().trim().min(1, 'productName 不能为空').optional(),
  pinyinAbbr: z.string().optional(),
  defaultPrice: optionalNonNegativeNumberSchema,
  isActive: optionalBooleanSchema,
  tagIds: z.array(productTagIdSchema).optional(),
})

const batchUpdateProductSchema = z
  .object({
    ids: z.array(productTagIdSchema).min(1, '至少选择一个产品'),
    isActive: optionalBooleanSchema,
  })
  .refine((payload) => typeof payload.isActive === 'boolean', {
    message: '至少提供一个可更新字段',
  })

export const productRouter = Router()

productRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const isActiveRaw = req.query.isActive
    const isActive =
      typeof isActiveRaw === 'string'
        ? isActiveRaw === '1' || isActiveRaw.toLowerCase() === 'true'
        : undefined

    const data = await productService.list({
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
      tagId: typeof req.query.tagId === 'string' ? req.query.tagId : undefined,
      isActive,
    })

    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.post(
  '/batch',
  asyncHandler(async (req, res) => {
    const payload = batchUpdateProductSchema.parse(req.body)
    const data = await productService.batchUpdate(payload)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = await productService.detail(req.params.id)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = createProductSchema.parse(req.body)
    const data = await productService.create(payload)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const payload = updateProductSchema.parse(req.body)
    const data = await productService.update(req.params.id, payload)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

productRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await productService.delete(req.params.id)
    res.json({
      code: 0,
      message: 'ok',
      data: true,
    })
  }),
)
