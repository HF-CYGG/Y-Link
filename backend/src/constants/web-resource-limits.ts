/**
 * Web 单据输入共用的安全上限。
 * 路由校验与服务层复用同一来源，避免直调服务或配置漂移绕过限制。
 */
export const MAX_DATABASE_INT = 2_147_483_647
export const MAX_O2O_ORDER_ITEM_COUNT = 200
export const MAX_INBOUND_ORDER_ITEM_COUNT = 200
