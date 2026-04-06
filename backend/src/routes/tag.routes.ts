import { Router } from 'express'
import { z } from 'zod'
import { tagService } from '../services/tag.service.js'
import { asyncHandler } from '../utils/async-handler.js'

const createTagSchema = z.object({
  tagName: z.string().min(1, 'tagName 不能为空'),
  tagCode: z.string().optional().nullable(),
})

const updateTagSchema = createTagSchema.partial()

export const tagRouter = Router()

tagRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const list = await tagService.listAll()
    res.json({
      code: 0,
      message: 'ok',
      data: list,
    })
  }),
)

tagRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = createTagSchema.parse(req.body)
    const data = await tagService.create(payload)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

tagRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const payload = updateTagSchema.parse(req.body)
    const data = await tagService.update(req.params.id, payload)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

tagRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await tagService.delete(req.params.id)
    res.json({
      code: 0,
      message: 'ok',
      data: true,
    })
  }),
)
