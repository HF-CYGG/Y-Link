/**
 * 文件说明：backend/scripts/task2-route-permission-contract-verify.ts
 * 文件职责：以 TypeScript AST 校验主应用与 rescue runtime 的公开、管理端、客户端及救援路由权限契约。
 * 实现逻辑：递归解析 app.use、Router.use 与 Router HTTP 调用；匿名接口按“方法+完整路径”白名单校验。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

type Audience = 'public' | 'admin' | 'client' | 'rescue'
type RouterRoute = { method: string; routePath: string; guards: Set<string>; permissions: string[]; sourceFile: string }
type RouterMount = { mountPath: string; targetRouter: string; guards: Set<string>; sourceFile: string }
type RouterDefinition = { name: string; sourceFile: string; routes: RouterRoute[]; nestedMounts: RouterMount[]; inheritedGuards: Set<string> }
type AppMount = { mountPath: string; targetRouter: string; guards: Set<string>; sourceFile: string }
type ResolvedRoute = { method: string; path: string; audience: Audience; guards: Set<string>; permissions: string[]; sourceFile: string }

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(backendRoot, 'src')
const appFilePath = path.join(sourceRoot, 'app.ts')
const rescueAppFilePath = path.join(sourceRoot, 'runtime', 'rescue-app.ts')
const permissionsFilePath = path.join(sourceRoot, 'constants', 'auth-permissions.ts')
const GUARD_NAMES = new Set([
  'requireAuth', 'requireAdminCsrf', 'requireClientAuth', 'requirePermission', 'requireRole', 'requireDatabaseRescueCredential',
])
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
const DATABASE_RESCUE_ROUTER_NAME = 'databaseRescueRouter'

/** 新增匿名接口必须精确登记完整 HTTP 方法和路径，不能只登记前缀。 */
const ANONYMOUS_ROUTE_ALLOWLIST = new Set<string>([
  'GET /health',
  'GET /database-rescue',
  'GET /api/auth/captcha', 'POST /api/auth/login', 'POST /api/auth/logout',
  'GET /api/client-auth/captcha', 'POST /api/client-auth/register', 'POST /api/client-auth/login',
  'GET /api/client-auth/capabilities', 'POST /api/client-auth/verification-code/send',
  'POST /api/client-auth/forgot-password/verify', 'POST /api/client-auth/forgot-password/reset',
  'GET /api/client-feedback/portal-config',
  'GET /api/o2o/mall/products', 'GET /api/o2o/mall/storefront', 'GET /api/o2o/mall/config', 'GET /api/o2o/mall/rules',
])
/** 已登录用户只能操作自己的会话；这些接口不属于带业务权限点的管理操作。 */
const AUTHENTICATED_SELF_SERVICE_ALLOWLIST = new Set<string>([
  'GET /api/auth/me', 'POST /api/auth/logout',
  'POST /api/auth/presence/heartbeat',
  'POST /api/auth/change-password',
])

const log = (message: string) => console.log(`[task2-route-contract] ${message}`)
const readUtf8 = (filePath: string) => fs.readFileSync(filePath, 'utf8')
const parseSourceFile = (filePath: string) => ts.createSourceFile(filePath, readUtf8(filePath), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
const identifier = (node: ts.Expression): string | null => ts.isIdentifier(node) ? node.text : null

function collectTsFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? collectTsFiles(entryPath) : entry.name.endsWith('.ts') ? [entryPath] : []
  })
}

function staticPath(node: ts.Expression | undefined, context: string): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) throw new Error(`${context} 不允许动态路径`)
  return null
}

function guardsOf(node: ts.Node | readonly ts.Node[]): Set<string> {
  const guards = new Set<string>()
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child) && GUARD_NAMES.has(child.text)) guards.add(child.text)
    ts.forEachChild(child, visit)
  }
  if (Array.isArray(node)) node.forEach(visit)
  else visit(node)
  return guards
}

function permissionsOf(node: ts.Node | readonly ts.Node[]): string[] {
  const permissions = new Set<string>()
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'requirePermission') {
      child.arguments.forEach((argument) => {
        const value = staticPath(argument, 'requirePermission')
        if (!value) throw new Error('requirePermission 必须使用静态权限点字符串')
        permissions.add(value)
      })
    }
    ts.forEachChild(child, visit)
  }
  if (Array.isArray(node)) node.forEach(visit)
  else visit(node)
  return [...permissions]
}

function mergeGuards(...sets: Iterable<string>[]): Set<string> {
  const merged = new Set<string>()
  sets.forEach((set) => { for (const value of set) merged.add(value) })
  return merged
}

function joinPath(basePath: string, childPath: string): string {
  const base = basePath === '/' ? '' : basePath.replace(/\/$/, '')
  const child = childPath === '/' ? '' : `/${childPath.replace(/^\//, '')}`
  return `${base}${child}` || '/'
}

function parsePermissionCodes(): Set<string> {
  const permissions = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PERMISSION_CODES' && node.initializer) {
      const initializer = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer
      if (!ts.isArrayLiteralExpression(initializer)) throw new Error('PERMISSION_CODES 必须保持静态数组声明')
      initializer.elements.forEach((element) => {
        const value = staticPath(element as ts.Expression, 'PERMISSION_CODES')
        if (value) permissions.add(value)
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(parseSourceFile(permissionsFilePath))
  assert.ok(permissions.size > 0, '未从 PERMISSION_CODES AST 读取到权限点')
  return permissions
}

function parseRouters(files: string[]): Map<string, RouterDefinition> {
  const routers = new Map<string, RouterDefinition>()
  for (const filePath of files) {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'Router') {
        if (routers.has(node.name.text)) throw new Error(`Router 标识符重复：${node.name.text}`)
        routers.set(node.name.text, { name: node.name.text, sourceFile: filePath, routes: [], nestedMounts: [], inheritedGuards: new Set() })
      }
      ts.forEachChild(node, visit)
    }
    visit(parseSourceFile(filePath))
  }
  for (const filePath of files) {
    const source = parseSourceFile(filePath)
    const visit = (node: ts.Node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return ts.forEachChild(node, visit)
      const receiver = identifier(node.expression.expression)
      const method = node.expression.name.text
      const router = receiver ? routers.get(receiver) : undefined
      if (!router) return ts.forEachChild(node, visit)
      if (HTTP_METHODS.has(method)) {
        const routePath = staticPath(node.arguments[0], `${receiver}.${method}`)
        if (!routePath) throw new Error(`${receiver}.${method} 的首参数必须是静态字符串路径`)
        const routeArguments = node.arguments.slice(1)
        router.routes.push({ method: method.toUpperCase(), routePath, guards: guardsOf(routeArguments), permissions: permissionsOf(routeArguments), sourceFile: filePath })
      } else if (method === 'use') {
        const firstPath = staticPath(node.arguments[0], `${receiver}.use`)
        const mountPath = firstPath ?? '/'
        const rest = node.arguments.slice(firstPath ? 1 : 0)
        const targetRouters = rest.map(identifier).filter((name): name is string => Boolean(name && routers.has(name)))
        const guards = guardsOf(ts.factory.createNodeArray(rest))
        if (targetRouters.length) targetRouters.forEach((targetRouter) => router.nestedMounts.push({ mountPath, targetRouter, guards, sourceFile: filePath }))
        else router.inheritedGuards = mergeGuards(router.inheritedGuards, guards)
      } else {
        throw new Error(`${router.name}.${method} 是未识别的 Router 调用结构，必须更新契约解析器`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return routers
}

function parseApp(appPath: string, routers: Map<string, RouterDefinition>): { mounts: AppMount[]; directRoutes: ResolvedRoute[] } {
  if (!fs.existsSync(appPath)) return { mounts: [], directRoutes: [] }
  const source = parseSourceFile(appPath)
  const appUses: Array<{ start: number; mountPath: string; guards: Set<string>; targetRouters: string[] }> = []
  const directRoutes: ResolvedRoute[] = []
  const visit = (node: ts.Node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || identifier(node.expression.expression) !== 'app') return ts.forEachChild(node, visit)
    const method = node.expression.name.text
    if (method === 'use') {
      const mountPath = staticPath(node.arguments[0], 'app.use')
      if (!mountPath) {
        const targetRouters = node.arguments.map(identifier).filter((name): name is string => Boolean(name && routers.has(name)))
        if (targetRouters.length) throw new Error('挂载 Router 的 app.use 必须使用静态前缀路径')
        return ts.forEachChild(node, visit)
      }
      const rest = node.arguments.slice(1)
      appUses.push({ start: node.getStart(source), mountPath, guards: guardsOf(ts.factory.createNodeArray(rest)), targetRouters: rest.map(identifier).filter((name): name is string => Boolean(name && routers.has(name))) })
    } else if (HTTP_METHODS.has(method)) {
      const routePath = staticPath(node.arguments[0], `app.${method}`)
      if (!routePath) throw new Error(`app.${method} 必须使用静态路径`)
      const guards = guardsOf(ts.factory.createNodeArray(node.arguments.slice(1)))
      directRoutes.push({ method: method.toUpperCase(), path: routePath, audience: audienceOf(guards), guards, permissions: permissionsOf(node.arguments.slice(1)), sourceFile: appPath })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const globalAdminGate = appUses.find((entry) => entry.mountPath === '/api' && entry.guards.has('requireAuth'))
  return {
    mounts: appUses.flatMap((entry) => entry.targetRouters.map((targetRouter) => ({
      mountPath: entry.mountPath,
      targetRouter,
      guards: mergeGuards(entry.guards, appPath === appFilePath && globalAdminGate && entry.start > globalAdminGate.start ? ['requireAuth', 'requireAdminCsrf'] : []),
      sourceFile: appPath,
    }))),
    directRoutes,
  }
}

function audienceOf(guards: Set<string>): Audience {
  if (guards.has('requireDatabaseRescueCredential')) return 'rescue'
  if (guards.has('requireClientAuth')) return 'client'
  if (guards.has('requireAuth') || guards.has('requirePermission') || guards.has('requireRole')) return 'admin'
  return 'public'
}

function resolveRoutes(routers: Map<string, RouterDefinition>, mounts: AppMount[]): ResolvedRoute[] {
  const resolved: ResolvedRoute[] = []
  const mounted = new Set<string>()
  const walk = (routerName: string, basePath: string, inheritedGuards: Set<string>, stack: string[]) => {
    if (stack.includes(routerName)) throw new Error(`检测到循环 Router 挂载：${[...stack, routerName].join(' -> ')}`)
    const router = routers.get(routerName)
    assert.ok(router, `未找到 Router 定义：${routerName}`)
    mounted.add(routerName)
    const routerGuards = mergeGuards(inheritedGuards, router.inheritedGuards)
    router.routes.forEach((route) => {
      const guards = mergeGuards(routerGuards, route.guards)
      resolved.push({ method: route.method, path: joinPath(basePath, route.routePath), audience: audienceOf(guards), guards, permissions: route.permissions, sourceFile: route.sourceFile })
    })
    router.nestedMounts.forEach((mount) => walk(mount.targetRouter, joinPath(basePath, mount.mountPath), mergeGuards(routerGuards, mount.guards), [...stack, routerName]))
  }
  mounts.forEach((mount) => walk(mount.targetRouter, mount.mountPath, mount.guards, []))
  const unmounted = [...routers.values()].filter((router) => !mounted.has(router.name))
  assert.equal(unmounted.length, 0, `存在未被应用装配识别的 Router：${unmounted.map((router) => router.name).join('、')}`)
  return resolved
}

function assertContracts(routes: ResolvedRoute[], permissions: Set<string>) {
  assert.ok(routes.length > 0, '未解析到任何实际路由')
  routes.forEach((route) => {
    const key = `${route.method} ${route.path}`
    if (route.audience === 'public') assert.ok(ANONYMOUS_ROUTE_ALLOWLIST.has(key), `发现未登记的匿名接口：${key}；守卫：${[...route.guards].join(',') || '无'}`)
    if (route.audience === 'admin' && route.permissions.length === 0) {
      assert.ok(AUTHENTICATED_SELF_SERVICE_ALLOWLIST.has(key), `管理端接口必须声明权限点：${key}`)
    }
    if (route.audience === 'rescue') assert.ok(route.guards.has('requireDatabaseRescueCredential'), `rescue API 缺少凭据守卫：${key}`)
  })
  const undefinedPermissions = routes.flatMap((route) => route.permissions.filter((permission) => !permissions.has(permission)).map((permission) => `${permission} -> ${route.method} ${route.path}`))
  assert.equal(undefinedPermissions.length, 0, `存在未在 PERMISSION_CODES 声明的权限点：${undefinedPermissions.join('；')}`)
}

function main() {
  const routers = parseRouters([...collectTsFiles(path.join(sourceRoot, 'routes')), ...collectTsFiles(path.join(sourceRoot, 'runtime'))])
  const databaseRescueRouter = routers.get(DATABASE_RESCUE_ROUTER_NAME)
  assert.ok(databaseRescueRouter, '必须识别 databaseRescueRouter 的独立救援路由定义')
  assert.ok(databaseRescueRouter.inheritedGuards.has('requireDatabaseRescueCredential'), 'databaseRescueRouter 必须统一挂接 rescue credential 守卫')
  const app = parseApp(appFilePath, routers)
  const rescue = parseApp(rescueAppFilePath, routers)
  const routes = [...resolveRoutes(routers, [...app.mounts, ...rescue.mounts]), ...app.directRoutes, ...rescue.directRoutes]
  assertContracts(routes, parsePermissionCodes())
  const counts = routes.reduce<Record<Audience, number>>((result, route) => { result[route.audience] += 1; return result }, { public: 0, admin: 0, client: 0, rescue: 0 })
  log(`AST 解析 ${routes.length} 条路由：公开 ${counts.public}、管理端 ${counts.admin}、客户端 ${counts.client}、rescue ${counts.rescue}`)
  console.log('Task2 后端路由权限契约验证通过')
}

try { main() } catch (error) { console.error('Task2 后端路由权限契约验证失败', error); process.exit(1) }
