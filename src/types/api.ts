/**
 * 模块说明：src/types/api.ts
 * 文件职责：集中定义前端 API 层通用类型契约，统一承接后端标准返回体、分页查询参数与分页结果结构。
 * 实现逻辑：
 * - 把多个接口模块都会复用的公共类型沉淀到独立文件，避免各业务域重复声明相同结构；
 * - 通过统一分页类型约束 API 模块与列表页之间的交互口径，减少字段命名漂移；
 * - 作为请求层和业务 API 层之间的基础类型桥梁，保持上游响应结构表达稳定。
 */

/**
 * Web 兼容出口：通用响应与分页类型的真源已迁移到 shared-types。
 * 保留本文件 re-export，现有调用方无需改 import path。
 */
export type {
  ApiResponse,
  PaginationQuery,
  PaginationQueryInput,
  PaginationResult,
} from '../../packages/shared-types/src/index'
