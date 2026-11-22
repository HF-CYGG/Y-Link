/**
 * 文件说明：backend/scripts/task4-role-navigation-verify.ts
 * 文件职责：执行 Task4 角色导航与访问一致性回归，验证管理员/操作员/供货方在“菜单可见性、直达访问、守卫兜底”三层口径一致。
 * 实现逻辑：
 * 1) 直接复用前端路由同源函数 `buildAppMenuItems`、`resolveFirstAccessibleManagementPath` 与 `canAccessRoute`；
 * 2) 从管理端根路由递归构建“绝对路径 -> 元信息链”映射，模拟 `to.matched` 逐层守卫校验；
 * 3) 逐角色断言：菜单层级和点击目标、不可见入口直达拦截、隐藏但授权入口可访问、无权限时回退目标可达且可见。
 * 维护说明：若后续新增管理端业务路由或调整角色权限，请同步更新本脚本中的期望矩阵与断言说明。
 */
import assert from 'node:assert/strict'
import { DEFAULT_ROLE_PERMISSIONS } from '../src/constants/auth-permissions.js'
import type { UserRole } from '../src/types/auth.js'
import {
  buildAppMenuItems,
  canAccessRoute,
  resolveFirstAccessibleManagementPath,
  routes,
  type AppMenuItem,
  type AppRouteMeta,
} from '../../src/router/routes.ts'

type RoleUser = {
  role: UserRole
  permissions: string[]
}

type ExpectedMenuItem = string | { path: string; children: string[] }

/**
 * 输出通过日志：
 * - 使用统一前缀，便于 CI/人工巡检快速定位当前验证进度；
 * - 仅在关键断言组通过后打印，避免噪音日志掩盖失败点。
 */
function pass(message: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${message}`)
}

/**
 * 构造指定角色的最小用户上下文：
 * - 权限集合复用后端默认角色权限，保证和真实登录会话口径一致；
 * - 仅保留本次回归需要的 role/permissions 字段，减少与页面展示字段耦合。
 */
function createRoleUser(role: UserRole): RoleUser {
  return {
    role,
    permissions: [...DEFAULT_ROLE_PERMISSIONS[role]],
  }
}

/**
 * 菜单树扁平化：
 * - 递归提取所有菜单路径，方便做“集合级”断言；
 * - 不区分父子层级，重点校验当前角色最终可见入口全集。
 */
function flattenMenuPaths(items: AppMenuItem[]): string[] {
  const paths: string[] = []
  for (const item of items) {
    paths.push(item.path)
    if (item.children?.length) {
      paths.push(...flattenMenuPaths(item.children))
    }
  }
  return paths
}

/**
 * 解析相对/绝对子路由路径为绝对路径：
 * - 与前端路由派生逻辑保持一致，避免脚本和业务运行时规则不一致；
 * - 父级为 `/` 时不重复拼接多余斜杠。
 */
function resolveRoutePath(parentPath: string, routePath: string): string {
  if (routePath.startsWith('/')) {
    return routePath
  }
  const normalizedParent = parentPath === '/' ? '' : parentPath.replace(/\/$/, '')
  return `${normalizedParent}/${routePath}`
}

/**
 * 管理端路径元信息链索引：
 * - 键：管理端绝对路径（如 `/base-data/products`）；
 * - 值：从根布局到目标路由的 `meta` 链，用于模拟 beforeEach 中 `to.matched` 逐层校验。
 */
function buildManagementMetaChainMap() {
  const managementRoot = routes.find((route) => route.path === '/')
  assert.ok(managementRoot, '未找到管理端根路由（path=/）')

  const chainMap = new Map<string, AppRouteMeta[]>()
  const rootMeta = (managementRoot.meta ?? {}) as AppRouteMeta

  const walk = (records: unknown[], parentPath: string, parentChain: AppRouteMeta[]) => {
    for (const record of records as Array<{ path?: unknown; meta?: unknown; children?: unknown[] }>) {
      if (typeof record.path !== 'string') {
        continue
      }
      const absolutePath = resolveRoutePath(parentPath, record.path)
      const currentMeta = (record.meta ?? {}) as AppRouteMeta
      const nextChain = [...parentChain, currentMeta]
      chainMap.set(absolutePath, nextChain)

      if (Array.isArray(record.children) && record.children.length > 0) {
        walk(record.children, absolutePath, nextChain)
      }
    }
  }

  if (Array.isArray(managementRoot.children)) {
    walk(managementRoot.children, '/', [rootMeta])
  }

  return chainMap
}

/**
 * 计算角色是否可直达访问某管理端路径：
 * - 基于“路径命中的元信息链”逐层执行 `canAccessRoute`；
 * - 任何一层不满足均视为不可访问，等价于真实守卫中的 deniedRecord 判定。
 */
function canAccessManagementPath(path: string, user: RoleUser, chainMap: Map<string, AppRouteMeta[]>) {
  const metaChain = chainMap.get(path)
  assert.ok(metaChain, `未在管理端路由中找到路径：${path}`)
  return metaChain.every((meta) => canAccessRoute(meta, user))
}

function verifyMenuVisibility(user: RoleUser, expected: ExpectedMenuItem[], chainMap: Map<string, AppRouteMeta[]>) {
  // 分组点击目标也是首个可访问子菜单的路径。分别比较父节点和子节点，保留有意重复的路径。
  const project = (item: AppMenuItem): ExpectedMenuItem => item.children?.length
    ? { path: item.path, children: item.children.map((child) => child.path) }
    : item.path
  const itemPath = (item: ExpectedMenuItem) => typeof item === 'string' ? item : item.path
  const compare = (left: ExpectedMenuItem, right: ExpectedMenuItem) => itemPath(left).localeCompare(itemPath(right))
  const menu = buildAppMenuItems(user)
  assert.deepEqual(menu.map(project).sort(compare), [...expected].sort(compare), `${user.role} 菜单可见性或层级不符合预期`)
  for (const item of menu) {
    if (item.children?.length) {
      assert.equal(item.path, item.children[0].path, `${item.title} 点击后应进入首个可访问子页`)
      assert.equal(item.children.some((child) => child.children?.length), false, `${item.title} 的子菜单不应继续分组`)
    }
  }
  for (const path of flattenMenuPaths(menu)) {
    assert.equal(canAccessManagementPath(path, user, chainMap), true, `${user.role} 的可见菜单不能直达 ${path}`)
  }
}

/**
 * 验证“不可见入口守卫兜底”：
 * - 对不可访问目标路径，要求首个可访问回退路径存在、可见、可访问；
 * - 对可访问但隐藏入口（如 supplier-history），要求“可访问但不出现在菜单”成立。
 */
function verifyAccessAndFallbackConsistency(chainMap: Map<string, AppRouteMeta[]>) {
  const adminUser = createRoleUser('admin')
  const operatorUser = createRoleUser('operator')
  const supplierUser = createRoleUser('supplier')

  const cases: Array<{ user: RoleUser; path: string; expectAccessible: boolean; scene: string }> = [
    { user: adminUser, path: '/dashboard', expectAccessible: true, scene: '管理员访问工作台' },
    { user: adminUser, path: '/supplier-delivery', expectAccessible: false, scene: '管理员访问供货入口应拦截' },
    { user: operatorUser, path: '/system/db-migration', expectAccessible: false, scene: '操作员访问数据库迁移应拦截' },
    { user: operatorUser, path: '/system/users', expectAccessible: false, scene: '操作员访问用户中心应拦截' },
    { user: operatorUser, path: '/supplier-delivery', expectAccessible: false, scene: '操作员访问供货入口应拦截' },
    { user: supplierUser, path: '/supplier-delivery', expectAccessible: true, scene: '供货方访问供货工作台' },
    { user: supplierUser, path: '/supplier-history', expectAccessible: true, scene: '供货方访问隐藏历史页' },
    { user: supplierUser, path: '/dashboard', expectAccessible: false, scene: '供货方访问工作台应拦截' },
    { user: supplierUser, path: '/order-entry', expectAccessible: false, scene: '供货方访问出库开单应拦截' },
    { user: supplierUser, path: '/base-data/products', expectAccessible: false, scene: '供货方访问基础资料应拦截' },
    { user: supplierUser, path: '/inventory/scan', expectAccessible: false, scene: '供货方访问库存作业应拦截' },
    { user: supplierUser, path: '/reports', expectAccessible: false, scene: '供货方访问报表应拦截' },
    { user: supplierUser, path: '/system/customer-service', expectAccessible: false, scene: '供货方访问客服工作台应拦截' },
    { user: supplierUser, path: '/system/configs', expectAccessible: false, scene: '供货方访问系统治理应拦截' },
  ]

  for (const item of cases) {
    const actualAccessible = canAccessManagementPath(item.path, item.user, chainMap)
    assert.equal(actualAccessible, item.expectAccessible, `${item.scene} 校验失败`)

    if (!item.expectAccessible) {
      const fallbackPath = resolveFirstAccessibleManagementPath(item.user)
      assert.ok(fallbackPath, `${item.scene} 未找到回退路径`)
      assert.equal(fallbackPath, item.user.role === 'supplier' ? '/supplier-delivery' : '/dashboard', `${item.scene} 回退目标不符合预期`)
      const menuPaths = flattenMenuPaths(buildAppMenuItems(item.user))
      assert.equal(menuPaths.includes(fallbackPath), true, `${item.scene} 回退路径不在可见菜单内`)
      assert.equal(
        canAccessManagementPath(fallbackPath, item.user, chainMap),
        true,
        `${item.scene} 回退路径本身不可访问`,
      )
    }
  }
  pass('不可见入口守卫兜底一致性符合预期')

  const supplierMenu = flattenMenuPaths(buildAppMenuItems(supplierUser))
  assert.equal(supplierMenu.includes('/supplier-history'), false, '供货方隐藏历史入口不应出现在菜单')
  assert.equal(canAccessManagementPath('/supplier-history', supplierUser, chainMap), true, '供货方应可直达历史页面')
  pass('隐藏但授权入口（supplier-history）行为符合预期')
}

async function main() {
  const chainMap = buildManagementMetaChainMap()
  const sharedManagementMenu: ExpectedMenuItem[] = [
    '/dashboard',
    '/order-entry',
    '/order-list',
    '/reports',
    '/inbound-scan',
    '/inbound-manage',
    '/system/customer-service',
    { path: '/base-data/products', children: ['/base-data/products', '/base-data/tags'] },
    { path: '/o2o-console/orders', children: ['/o2o-console/orders', '/o2o-console/verify'] },
    { path: '/inventory/scan', children: ['/inventory/scan', '/inventory/stocks', '/inventory/stocktakes', '/inventory/docs', '/inventory/logs'] },
  ]
  verifyMenuVisibility(createRoleUser('admin'), [
    ...sharedManagementMenu,
    { path: '/system/configs', children: ['/system/configs', '/system/db-migration', '/system/users', '/system/audit-logs'] },
  ], chainMap)
  verifyMenuVisibility(createRoleUser('operator'), [
    ...sharedManagementMenu,
    { path: '/system/configs', children: ['/system/configs'] },
  ], chainMap)
  verifyMenuVisibility(createRoleUser('supplier'), ['/supplier-delivery'], chainMap)
  pass('默认角色菜单、分组点击目标与路由访问权限一致')

  const stocktakeOnly: RoleUser = { role: 'operator', permissions: ['stocktake:view'] }
  verifyMenuVisibility(stocktakeOnly, [{ path: '/inventory/stocktakes', children: ['/inventory/stocktakes'] }], chainMap)
  assert.equal(canAccessManagementPath('/inventory/scan', stocktakeOnly, chainMap), false, '仅有盘点权限时应拦截扫码作业')
  assert.equal(resolveFirstAccessibleManagementPath(stocktakeOnly), '/inventory/stocktakes', '仅有盘点权限时应回退到盘点页')
  pass('权限裁剪后的库存分组跳过不可访问子页')

  verifyAccessAndFallbackConsistency(chainMap)

  // eslint-disable-next-line no-console
  console.log('\nTask4 角色导航可见性与访问一致性回归通过。')
}

try {
  await main()
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\nTask4 角色导航可见性与访问一致性回归失败：', error)
  process.exitCode = 1
}
