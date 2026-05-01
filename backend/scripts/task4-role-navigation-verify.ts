/**
 * 文件说明：backend/scripts/task4-role-navigation-verify.ts
 * 文件职责：执行 Task4 角色导航与访问一致性回归，验证管理员/操作员/供货方在“菜单可见性、直达访问、守卫兜底”三层口径一致。
 * 实现逻辑：
 * 1) 直接复用前端路由同源函数 `buildAppMenuItems`、`resolveFirstAccessibleManagementPath` 与 `canAccessRoute`；
 * 2) 从管理端根路由递归构建“绝对路径 -> 元信息链”映射，模拟 `to.matched` 逐层守卫校验；
 * 3) 逐角色断言：可见菜单集合、不可见入口直达拦截、隐藏但授权入口可访问、无权限时回退目标可达且可见。
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

/**
 * 验证角色菜单可见性：
 * - 断言“实际可见菜单集合”与“业务期望集合”一致；
 * - 集合比较采用排序后深比较，确保顺序变化不影响断言稳定性。
 */
function verifyMenuVisibility(role: UserRole, expectedVisiblePaths: string[]) {
  const user = createRoleUser(role)
  const visiblePaths = flattenMenuPaths(buildAppMenuItems(user)).sort((left, right) => left.localeCompare(right))
  const expected = [...expectedVisiblePaths].sort((left, right) => left.localeCompare(right))
  assert.deepEqual(visiblePaths, expected, `${role} 菜单可见性不符合预期`)
  pass(`${role} 菜单可见性符合预期`)
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
    { user: operatorUser, path: '/system/users', expectAccessible: false, scene: '操作员访问用户中心应拦截' },
    { user: operatorUser, path: '/supplier-delivery', expectAccessible: false, scene: '操作员访问供货入口应拦截' },
    { user: supplierUser, path: '/supplier-delivery', expectAccessible: true, scene: '供货方访问供货工作台' },
    { user: supplierUser, path: '/supplier-history', expectAccessible: true, scene: '供货方访问隐藏历史页' },
    { user: supplierUser, path: '/dashboard', expectAccessible: false, scene: '供货方访问工作台应拦截' },
    { user: supplierUser, path: '/order-entry', expectAccessible: false, scene: '供货方访问出库开单应拦截' },
    { user: supplierUser, path: '/base-data/products', expectAccessible: false, scene: '供货方访问基础资料应拦截' },
    { user: supplierUser, path: '/system/configs', expectAccessible: false, scene: '供货方访问系统治理应拦截' },
  ]

  for (const item of cases) {
    const actualAccessible = canAccessManagementPath(item.path, item.user, chainMap)
    assert.equal(actualAccessible, item.expectAccessible, `${item.scene} 校验失败`)

    if (!item.expectAccessible) {
      const fallbackPath = resolveFirstAccessibleManagementPath(item.user)
      assert.ok(fallbackPath, `${item.scene} 未找到回退路径`)
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
  verifyMenuVisibility('admin', [
    '/dashboard',
    '/order-entry',
    '/order-list',
    '/inbound-scan',
    '/inbound-manage',
    '/base-data',
    '/base-data/products',
    '/base-data/tags',
    '/o2o-console',
    '/o2o-console/orders',
    '/o2o-console/verify',
    '/system',
    '/system/configs',
    '/system/db-migration',
    '/system/users',
    '/system/audit-logs',
  ])
  verifyMenuVisibility('operator', [
    '/dashboard',
    '/order-entry',
    '/order-list',
    '/inbound-scan',
    '/inbound-manage',
    '/base-data',
    '/base-data/products',
    '/base-data/tags',
    '/o2o-console',
    '/o2o-console/orders',
    '/o2o-console/verify',
    '/system',
    '/system/configs',
    '/system/db-migration',
  ])
  verifyMenuVisibility('supplier', ['/supplier-delivery'])

  const chainMap = buildManagementMetaChainMap()
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
