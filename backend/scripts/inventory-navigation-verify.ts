/**
 * 文件说明：backend/scripts/inventory-navigation-verify.ts
 * 文件职责：验证库存菜单、快捷入口及新旧入口使用相同的路由权限口径。
 */
import assert from 'node:assert/strict'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { PermissionCode, UserRole } from '../../src/api/modules/auth.ts'
import { routeViewLoaders } from '../../src/router/route-performance.ts'
import {
  buildAppMenuItems,
  buildDashboardShortcutItems,
  canAccessRoute,
  resolveFirstAccessibleManagementPath,
  resolveInventoryEntryRedirect,
  routes,
  type AppMenuItem,
  type AppRouteMeta,
} from '../../src/router/routes.ts'

type TestUser = { role: UserRole; permissions: PermissionCode[] }

const root = routes.find((route) => route.path === '/')
assert.ok(root && Array.isArray(root.children))
const inventoryRoute = root.children.find((route) => route.path === 'inventory')
assert.ok(inventoryRoute && Array.isArray(inventoryRoute.children))
const inventoryMeta = inventoryRoute.meta as AppRouteMeta
const testRouter = createRouter({ history: createMemoryHistory(), routes })

const childRoute = (path: string) => {
  const child = inventoryRoute.children?.find((route) => route.path === path)
  assert.ok(child, '缺少库存子路由：' + path)
  return child
}

const visiblePaths = (items: AppMenuItem[]): string[] => items.flatMap((item) => [
  item.path,
  ...(item.children ? visiblePaths(item.children) : []),
])

assert.equal(inventoryRoute.redirect, undefined)
assert.equal(childRoute('overview').component, undefined)
assert.equal(childRoute('overview').redirect, '/inventory')
assert.equal((childRoute('overview').meta as AppRouteMeta).menu, false)
assert.equal(Object.hasOwn(routeViewLoaders, 'inventory-overview'), false)
const entryPaths = ['/inventory', '/inventory/', '/inventory/overview', '/inventory/overview/']
for (const path of entryPaths) {
  const matchedPaths = testRouter.resolve(path).matched.map((record) => record.path)
  assert.equal(matchedPaths.some((matchedPath) => matchedPath.endsWith('/inventory')), true, matchedPaths.join(','))
}

const cases: Array<{ name: string; user: TestUser; visibleChildren: string[]; first: string }> = [
  {
    name: '仅有盘点查看',
    user: { role: 'operator', permissions: ['stocktake:view'] },
    visibleChildren: ['/inventory/stocktakes'],
    first: '/inventory/stocktakes',
  },
  {
    name: '仅有库存查看',
    user: { role: 'operator', permissions: ['inventory:view'] },
    visibleChildren: ['/inventory/stocks', '/inventory/docs', '/inventory/logs'],
    first: '/inventory/stocks',
  },
  {
    name: '仅有库存操作',
    user: { role: 'operator', permissions: ['inventory:operate'] },
    visibleChildren: ['/inventory/scan'],
    first: '/inventory/scan',
  },
  {
    name: '查看与盘点组合',
    user: { role: 'operator', permissions: ['inventory:view', 'stocktake:view'] },
    visibleChildren: ['/inventory/stocks', '/inventory/stocktakes', '/inventory/docs', '/inventory/logs'],
    first: '/inventory/stocks',
  },
  {
    name: '管理员全权限',
    user: { role: 'admin', permissions: ['inventory:view', 'inventory:operate', 'stocktake:view', 'products:view'] },
    visibleChildren: [
      '/inventory/scan', '/inventory/stocks', '/inventory/stocktakes',
      '/inventory/docs', '/inventory/logs', '/inventory/master-data',
    ],
    first: '/inventory/scan',
  },
]

for (const { name, user, visibleChildren, first } of cases) {
  const menu = buildAppMenuItems(user)
  const inventoryMenu = menu.find((item) => item.title === '库存管理')
  assert.ok(inventoryMenu, name + ' 应看到库存管理菜单')
  assert.equal(inventoryMenu.path, first)
  assert.deepEqual(visiblePaths(inventoryMenu.children ?? []), visibleChildren)
  if (user.role === 'operator') {
    assert.equal(resolveFirstAccessibleManagementPath(user), first)
  }

  const shortcut = buildDashboardShortcutItems(user).find((item) => item.title === '库存管理')
  assert.equal(shortcut?.path, '/inventory')
  for (const path of entryPaths) {
    assert.equal(resolveInventoryEntryRedirect(path, user), first, name + ' 的 ' + path + ' 首跳错误')
  }

  assert.equal(canAccessRoute(inventoryMeta, user), true)
  for (const path of visibleChildren) {
    const childPath = path.slice('/inventory/'.length)
    assert.equal(canAccessRoute(childRoute(childPath).meta as AppRouteMeta, user), true, name + ' 无法访问 ' + path)
  }
  // eslint-disable-next-line no-console
  console.log('✅ ' + name + ' 菜单、快捷入口与新旧首跳一致')
}

assert.equal((childRoute('stocks').meta as AppRouteMeta).menu, undefined)
assert.equal((childRoute('stocktakes').meta as AppRouteMeta).menu, undefined)
assert.equal((childRoute('stocktakes/:id').meta as AppRouteMeta).menu, false)
assert.equal((childRoute('stocktakes/:id').meta as AppRouteMeta).activeMenu, '/inventory/stocktakes')

for (const user of [
  { role: 'operator', permissions: [] },
  { role: 'operator', permissions: ['products:view'] },
  { role: 'supplier', permissions: ['inventory:view'] },
] satisfies TestUser[]) {
  assert.equal(buildAppMenuItems(user).some((item) => item.title === '库存管理'), false)
  assert.equal(buildDashboardShortcutItems(user).some((item) => item.title === '库存管理'), false)
  assert.equal(canAccessRoute(inventoryMeta, user), false)
  for (const path of entryPaths) {
    assert.equal(resolveInventoryEntryRedirect(path, user), null)
  }
}
assert.equal(resolveInventoryEntryRedirect('/inventory/overview/extra', cases[0].user), null)
assert.equal(resolveInventoryEntryRedirect('/inventory/stocks', cases[0].user), null)
// eslint-disable-next-line no-console
console.log('✅ 无库存权限与供应方无法进入库存入口，兼容跳转仅处理精确路径')
