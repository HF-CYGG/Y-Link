/**
 * 模块说明：F:/Y-Link/src/api/index.ts
 * 文件职责：前端 API 聚合出口文件。
 * 实现逻辑：统一导出各业务 API 模块，降低页面层导入路径复杂度并形成单一接口入口。
 * 维护说明：新增、拆分或重命名 API 模块时需同步维护本文件导出，避免调用方使用深层路径直引。
 */
export * as authApi from '@/api/modules/auth'
export * as systemApi from '@/api/modules/system'
export * as systemConfigApi from '@/api/modules/system-config'
export * as productApi from '@/api/modules/product'
export * as orderApi from '@/api/modules/order'
export * as tagApi from '@/api/modules/tag'
export * as dashboardApi from '@/api/modules/dashboard'
export * as userApi from '@/api/modules/user'
export * as auditApi from '@/api/modules/audit'
export * as clientAuthApi from '@/api/modules/client-auth'
export * as o2oApi from '@/api/modules/o2o'
export * as dataMaintenanceApi from '@/api/modules/data-maintenance'
export * as customerServiceFeedbackApi from '@/api/modules/customer-service-feedback'
