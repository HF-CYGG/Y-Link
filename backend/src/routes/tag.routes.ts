/**
 * 文件说明：标签管理路由，提供商品标签的列表、创建、更新与删除等后台维护接口。
 * 实现逻辑：先在路由层校验标签名称与编码，再配合权限中间件调用标签服务完成标签主数据的增删改查。
 * 维护重点：调整标签字段或唯一性规则时，需要同步核对标签实体约束以及商品与标签的关联关系处理。
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
