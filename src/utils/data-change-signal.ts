/**
 * 模块说明：src/utils/data-change-signal.ts
 * 文件职责：维护管理端“基础数据已变更”的进程内版本号，供被 KeepAlive 缓存的页面在重新激活时判断是否需要刷新。
 * 实现逻辑：
 * - 统一请求层在写请求成功后按 URL 前缀识别数据域并递增版本号，无需在每个写接口里手工通知；
 * - 只读的 POST（预览、查询、标签预取、测试发送）不视为变更，避免切页时无谓重载；
 * - 版本号是响应式对象，页面侧由 useDataChangeRefresh 订阅。
 * 维护说明：
 * - 新增会改动商品、部门等共享基础数据的写接口时，确认其 URL 能被下方规则命中；
 * - 本模块只在当前标签页内生效，不跨浏览器标签页、不跨账号，也不代表服务端数据版本。
 */

import { reactive } from 'vue'

export type DataChangeDomain = 'products' | 'departments'

export const dataChangeVersions = reactive<Record<DataChangeDomain, number>>({
  products: 0,
  departments: 0,
})

const DATA_CHANGE_URL_RULES: Array<{ domain: DataChangeDomain; pattern: RegExp }> = [
  // 商品、SKU、标签、分类、库位与库存单据都会影响各页的商品选择器、筛选项和库存展示。
  { domain: 'products', pattern: /^\/(products|tags)(\/|$)/ },
  { domain: 'products', pattern: /^\/inventory\/(categories|locations|docs|stocktakes)(\/|$)/ },
  // 客户端部门树与部门账号决定开单、订单池、客户端用户管理中的部门选项。
  { domain: 'departments', pattern: /^\/system-configs\/client-departments(\/|$)/ },
  { domain: 'departments', pattern: /^\/client-users\/department-accounts(\/|$)/ },
]

const READ_ONLY_WRITE_URL_PATTERN = /\/(preview|lookup|labels|test-send)(\/|$)/

const normalizeRequestPath = (url?: string) => {
  if (!url) {
    return ''
  }
  const path = url.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? ''
  return path.replace(/^\/api(?=\/)/, '')
}

export const resolveDataChangeDomains = (url?: string): DataChangeDomain[] => {
  const path = normalizeRequestPath(url)
  if (!path || READ_ONLY_WRITE_URL_PATTERN.test(path)) {
    return []
  }
  return [...new Set(DATA_CHANGE_URL_RULES.filter((rule) => rule.pattern.test(path)).map((rule) => rule.domain))]
}

export const markDataChanged = (domains: DataChangeDomain[]) => {
  for (const domain of domains) {
    dataChangeVersions[domain] += 1
  }
}
