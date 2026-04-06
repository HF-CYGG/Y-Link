import { Router } from 'express'
import { z } from 'zod'
import { productService } from '../services/product.service.js'
import { asyncHandler } from '../utils/async-handler.js'

const createProductSchema = z.object({
  productCode: z.string().min(1, 'productCode 不能为空'),
  productName: z.string().min(1, 'productName 不能为空'),
  pinyinAbbr: z.string().optional(),
  defaultPrice: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
  tagIds: z.array(z.string()).optional(),
})

const updateProductSchema = createProductSchema.partial()

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
