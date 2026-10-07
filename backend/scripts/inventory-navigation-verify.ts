/**
 * 文件说明：backend/scripts/inventory-navigation-verify.ts
 * 文件职责：验证库存单权限账号的菜单、快捷入口、入口卡片和路由守卫使用相同的权限口径。
 */
import assert from 'node:assert/strict'
import type { PermissionCode } from '../../src/api/modules/auth.ts'
import {
  buildAppMenuItems,
  buildDashboardShortcutItems,
  buildInventoryEntryItems,
  canAccessRoute,
  resolveFirstAccessibleManagementPath,
  routes,
  type AppMenuItem,
  type AppRouteMeta,
} from '../../src/router/routes.ts'

type TestUser = { role: 'operator'; permissions: PermissionCode[] }

const root = routes.find((route) => route.path === '/')
assert.ok(root && Array.isArray(root.children))
const inventoryRoute = root.children.find((route) => route.path === 'inventory')
assert.ok(inventoryRoute && Array.isArray(inventoryRoute.children))
const inventoryMeta = inventoryRoute.meta as AppRouteMeta

const childRoute = (path: string) => {
  const child = inventoryRoute.children?.find((route) => route.path === path)
  assert.ok(child, `缺少库存子路由：${path}`)
  return child
}

const visiblePaths = (items: AppMenuItem[]): string[] => items.flatMap((item) => [
  item.path,
  ...(item.children ? visiblePaths(item.children) : []),
])

const cases: Array<{ permission: PermissionCode; entries: string[]; visibleChildren: string[] }> = [
  {
    permission: 'stocktake:view',
    entries: ['/inventory/stocktakes'],
    visibleChildren: ['/inventory/overview'],
  },
  {
    permission: 'inventory:view',
    entries: ['/inventory/stocks', '/inventory/docs', '/inventory/logs'],
    visibleChildren: ['/inventory/overview', '/inventory/docs', '/inventory/logs'],
  },
  {
    permission: 'inventory:operate',
    entries: ['/inventory/scan'],
    visibleChildren: ['/inventory/overview', '/inventory/scan'],
  },
]

for (const { permission, entries, visibleChildren } of cases) {
  const user: TestUser = { role: 'operator', permissions: [permission] }
  const menu = buildAppMenuItems(user)
  const inventoryMenu = menu.find((item) => item.title === '库存管理')
  assert.ok(inventoryMenu, `${permission} 应看到库存管理菜单`)
  assert.equal(inventoryMenu.path, '/inventory/overview')
  assert.deepEqual(visiblePaths(inventoryMenu.children ?? []), visibleChildren)
  assert.deepEqual(buildInventoryEntryItems(user).map((item) => item.path), entries)
  assert.equal(resolveFirstAccessibleManagementPath(user), '/inventory/overview')

  const shortcut = buildDashboardShortcutItems(user).find((item) => item.title === '库存管理')
  assert.equal(shortcut?.path, '/inventory/overview')

  for (const entry of buildInventoryEntryItems(user)) {
    const path = entry.path.slice('/inventory/'.length)
    assert.equal(canAccessRoute(inventoryMeta, user), true)
    assert.equal(canAccessRoute(childRoute(path).meta as AppRouteMeta, user), true, `${permission} 的入口不可访问：${entry.path}`)
  }
  for (const hiddenPath of ['stocks', 'stocktakes']) {
    assert.equal((childRoute(hiddenPath).meta as AppRouteMeta).menu, false)
    assert.equal((childRoute(hiddenPath).meta as AppRouteMeta).activeMenu, '/inventory/overview')
  }
  assert.equal((childRoute('stocktakes/:id').meta as AppRouteMeta).activeMenu, '/inventory/overview')
  // eslint-disable-next-line no-console
  console.log(`✅ ${permission} 库存入口、菜单和守卫一致`)
}

const unauthorized: TestUser = { role: 'operator', permissions: [] }
assert.equal(buildAppMenuItems(unauthorized).some((item) => item.title === '库存管理'), false)
assert.equal(buildDashboardShortcutItems(unauthorized).some((item) => item.title === '库存管理'), false)
assert.deepEqual(buildInventoryEntryItems(unauthorized), [])
assert.equal(canAccessRoute(inventoryMeta, unauthorized), false)
// eslint-disable-next-line no-console
console.log('✅ 无库存权限账号不显示库存入口')
