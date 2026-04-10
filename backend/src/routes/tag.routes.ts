/**
 * 模块说明：backend/src/routes/tag.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import { tagService } from '../services/tag.service.js'
import { asyncHandler } from '../utils/async-handler.js'

const createTagSchema = z.object({
  tagName: z.string().min(1, 'tagName 不能为空'),
  tagCode: z.string().optional().nullable(),
})

const updateTagSchema = createTagSchema.partial()

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
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
