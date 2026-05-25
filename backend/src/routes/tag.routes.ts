/**
 * 模块说明：backend/src/routes/tag.routes.ts
 * 文件职责：标签管理路由，负责标签列表、创建、更新和删除接口。
 * 实现逻辑：
 * - 路由层完成参数校验与权限判断；
 * - 标签与商品关系约束由 service 层控制；
 * - 删除前由服务层判断是否存在关联数据。
 * 维护说明：
 * - 标签结构调整需同步商品筛选接口与前端标签组件。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../middleware/auth.middleware.js'
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
  // 标签列表属于读取能力，需要 tags:view。
  requirePermission('tags:view'),
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
  // 新增标签属于管理操作，需要 tags:manage。
  requirePermission('tags:manage'),
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
  // 编辑标签属于管理操作，需要 tags:manage。
  requirePermission('tags:manage'),
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
  // 删除标签属于管理操作，需要 tags:manage。
  requirePermission('tags:manage'),
  asyncHandler(async (req, res) => {
    await tagService.delete(req.params.id)
    res.json({
      code: 0,
      message: 'ok',
      data: true,
    })
  }),
)
