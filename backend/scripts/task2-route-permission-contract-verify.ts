/**
 * 文件说明：backend/scripts/task2-route-permission-contract-verify.ts
 * 文件职责：校验后端路由的权限契约是否稳定，包括匿名挂载边界、权限点声明完整性与角色限制搭配规则。
 * 实现逻辑：
 * 1. 解析 `src/app.ts`，确认哪些路由挂载在全局 `requireAuth` 之前，避免受保护接口被误暴露为匿名可访问；
 * 2. 扫描 `src/routes/*.ts` 中每个 `Router` 的路由定义，抽取 `requirePermission` / `requireRole` 中间件契约；
 * 3. 对照 `src/constants/auth-permissions.ts` 中声明的权限点白名单，阻止拼写漂移或历史权限残留；
 * 4. 约束“全局鉴权后的业务路由必须显式声明权限点”“角色限制不能脱离权限点单独存在”，让后续扩展继续遵守同一口径。
 * 维护说明：
 * - 若 `src/app.ts` 的挂载顺序、匿名路由范围或 `requirePermission` 接入方式发生变化，需要同步调整本脚本；
 * - 若新增公共路由前缀，必须先在 `EXPECTED_PUBLIC_ROUTE_PREFIXES` 中显式登记，再让脚本通过。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type MountedRouter = {
  mountPath: string
  routerName: string
  sourceIndex: number
}

type RouteContract = {
  filePath: string
  routerName: string
  method: string
  routePath: string
  permissions: string[]
  roles: string[]
}

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsRoot = path.dirname(currentFilePath)
const backendRoot = path.resolve(scriptsRoot, '..')
const appFilePath = path.join(backendRoot, 'src', 'app.ts')
const routesRoot = path.join(backendRoot, 'src', 'routes')
const permissionsFilePath = path.join(backendRoot, 'src', 'constants', 'auth-permissions.ts')

/**
 * 允许在全局 `requireAuth` 之前挂载的公开前缀：
 * - 这些前缀内部可能仍有局部鉴权，但“前缀本身”允许匿名进入；
 * - 新增公开路由时必须显式登记，防止误把管理端资源挂在匿名区。
 */
const EXPECTED_PUBLIC_ROUTE_PREFIXES = new Set([
  '/api/auth',
  '/api/client-auth',
  '/api/client-feedback',
  '/api/o2o',
])

const log = (message: string) => {
  console.log(`[task2-route-contract] ${message}`)
}

const readUtf8 = (filePath: string) => fs.readFileSync(filePath, 'utf8')

const extractPermissionCodes = (source: string): Set<string> => {
  const permissionArrayMatch = /export const PERMISSION_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source)
  assert.ok(permissionArrayMatch, '未找到 PERMISSION_CODES 常量定义')

  const permissionCodes = new Set<string>()
  const stringLiteralPattern = /'([^']+)'/g
  let match: RegExpExecArray | null
  while ((match = stringLiteralPattern.exec(permissionArrayMatch[1])) !== null) {
    permissionCodes.add(match[1])
  }

  assert.ok(permissionCodes.size > 0, 'PERMISSION_CODES 为空，无法执行路由权限契约校验')
  return permissionCodes
}

const extractMountedRouters = (appSource: string): MountedRouter[] => {
  const mounts: MountedRouter[] = []
  const mountPattern = /app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g
  let match: RegExpExecArray | null

  while ((match = mountPattern.exec(appSource)) !== null) {
    mounts.push({
      mountPath: match[1],
      routerName: match[2],
      sourceIndex: match.index,
    })
  }

  return mounts
}

/**
 * 提取 `router.get(...)` / `router.post(...)` 等调用体：
 * - 采用括号深度扫描，而不是简单按换行截断，避免处理多行中间件链时误判；
 * - 返回完整参数体，便于后续统一抽取路径、权限点与角色约束。
 */
const extractRouterCallBlocks = (source: string, routerName: string): Array<{ method: string; argsText: string }> => {
  const blocks: Array<{ method: string; argsText: string }> = []
  const callPattern = new RegExp(String.raw`${routerName}\.(get|post|put|patch|delete)\s*\(`, 'g')
  let match: RegExpExecArray | null

  while ((match = callPattern.exec(source)) !== null) {
    const method = match[1].toUpperCase()
    const openParenthesisIndex = callPattern.lastIndex - 1
    let depth = 0
    let cursor = openParenthesisIndex

    for (; cursor < source.length; cursor += 1) {
      const currentCharacter = source[cursor]
      if (currentCharacter === '(') {
        depth += 1
      } else if (currentCharacter === ')') {
        depth -= 1
        if (depth === 0) {
          break
        }
      }
    }

    assert.ok(depth === 0, `无法完整解析 ${routerName}.${method.toLowerCase()}(...) 的参数体`)
    blocks.push({
      method,
      argsText: source.slice(openParenthesisIndex + 1, cursor),
    })
  }

  return blocks
}

const extractStringLiterals = (argumentSource: string): string[] => {
  const literals: string[] = []
  const stringLiteralPattern = /'([^']+)'/g
  let match: RegExpExecArray | null

  while ((match = stringLiteralPattern.exec(argumentSource)) !== null) {
    literals.push(match[1])
  }

  return literals
}

const extractRouteContracts = (filePath: string, routerName: string): RouteContract[] => {
  const source = readUtf8(filePath)
  return extractRouterCallBlocks(source, routerName).map((block) => {
    const routePathMatch = /^\s*'([^']+)'/.exec(block.argsText)
    assert.ok(routePathMatch, `${path.basename(filePath)} 中存在无法解析路径的 ${routerName}.${block.method.toLowerCase()} 路由`)

    const permissions: string[] = []
    const permissionPattern = /requirePermission\(([\s\S]*?)\)/g
    let permissionMatch: RegExpExecArray | null
    while ((permissionMatch = permissionPattern.exec(block.argsText)) !== null) {
      permissions.push(...extractStringLiterals(permissionMatch[1]))
    }

    const roles: string[] = []
    const rolePattern = /requireRole\(([\s\S]*?)\)/g
    let roleMatch: RegExpExecArray | null
    while ((roleMatch = rolePattern.exec(block.argsText)) !== null) {
      roles.push(...extractStringLiterals(roleMatch[1]))
    }

    return {
      filePath,
      routerName,
      method: block.method,
      routePath: routePathMatch[1],
      permissions,
      roles,
    }
  })
}

const normalizeRouteKey = (mountPath: string, routePath: string) => {
  if (routePath === '/') {
    return mountPath
  }

  const normalizedMountPath = mountPath.endsWith('/') ? mountPath.slice(0, -1) : mountPath
  const normalizedRoutePath = routePath.startsWith('/') ? routePath : `/${routePath}`
  return `${normalizedMountPath}${normalizedRoutePath}`
}

const main = () => {
  const appSource = readUtf8(appFilePath)
  const permissionCodes = extractPermissionCodes(readUtf8(permissionsFilePath))
  const mountedRouters = extractMountedRouters(appSource)
  const authGateMatch = /app\.use\(\s*'\/api'\s*,\s*requireAuth\b/.exec(appSource)
  const authGateIndex = authGateMatch?.index ?? -1

  assert.notEqual(authGateIndex, -1, '未在 app.ts 中找到全局 requireAuth 挂载点')
  assert.ok(mountedRouters.length > 0, '未在 app.ts 中解析到任何 app.use 路由挂载信息')

  const publicMounts = mountedRouters.filter((mount) => mount.sourceIndex < authGateIndex)
  const protectedMounts = mountedRouters.filter((mount) => mount.sourceIndex > authGateIndex)

  const publicPrefixSet = new Set(publicMounts.map((mount) => mount.mountPath))
  assert.deepEqual(
    [...publicPrefixSet].sort((a, b) => a.localeCompare(b)),
    [...EXPECTED_PUBLIC_ROUTE_PREFIXES].sort((a, b) => a.localeCompare(b)),
    `匿名路由前缀与契约不一致，当前值：${[...publicPrefixSet].sort((a, b) => a.localeCompare(b)).join(', ')}`,
  )

  const routerNameToMount = new Map<string, MountedRouter>()
  mountedRouters.forEach((mount) => {
    routerNameToMount.set(mount.routerName, mount)
  })

  const routeFiles = fs.readdirSync(routesRoot)
    .filter((fileName) => fileName.endsWith('.ts'))
    .map((fileName) => path.join(routesRoot, fileName))

  const routeContracts: RouteContract[] = []
  routeFiles.forEach((filePath) => {
    const source = readUtf8(filePath)
    const routerExportMatch = source.match(/export const (\w+)\s*=\s*Router\(\)/)
    if (!routerExportMatch) {
      return
    }

    const routerName = routerExportMatch[1]
    assert.ok(routerNameToMount.has(routerName), `${path.basename(filePath)} 导出的 ${routerName} 未在 app.ts 中挂载`)
    routeContracts.push(...extractRouteContracts(filePath, routerName))
  })

  assert.ok(routeContracts.length > 0, '未解析到任何具体路由定义，无法执行权限契约校验')

  const protectedMountRouterNames = new Set(protectedMounts.map((mount) => mount.routerName))
  const governanceRoutesMissingPermissions = routeContracts.filter((route) => {
    return protectedMountRouterNames.has(route.routerName) && route.permissions.length === 0
  })
  assert.equal(
    governanceRoutesMissingPermissions.length,
    0,
    `存在挂载在全局鉴权之后但未声明权限点的路由：${governanceRoutesMissingPermissions
      .map((route) => `${route.method} ${normalizeRouteKey(routerNameToMount.get(route.routerName)?.mountPath ?? '', route.routePath)}`)
      .join('；')}`,
  )

  const roleOnlyRoutes = routeContracts.filter((route) => route.roles.length > 0 && route.permissions.length === 0)
  assert.equal(
    roleOnlyRoutes.length,
    0,
    `存在只做角色限制、未声明权限点的路由：${roleOnlyRoutes
      .map((route) => `${route.method} ${normalizeRouteKey(routerNameToMount.get(route.routerName)?.mountPath ?? '', route.routePath)}`)
      .join('；')}`,
  )

  const undefinedPermissions = routeContracts.flatMap((route) => {
    return route.permissions
      .filter((permission) => !permissionCodes.has(permission))
      .map((permission) => ({
        permission,
        route,
      }))
  })
  assert.equal(
    undefinedPermissions.length,
    0,
    `存在未在 PERMISSION_CODES 中声明的权限点：${undefinedPermissions
      .map(({ permission, route }) => `${permission} -> ${route.method} ${normalizeRouteKey(routerNameToMount.get(route.routerName)?.mountPath ?? '', route.routePath)}`)
      .join('；')}`,
  )

  log(`公开前缀 ${publicMounts.length} 个、受保护前缀 ${protectedMounts.length} 个，挂载边界通过`)
  log(`共校验 ${routeContracts.length} 条路由定义，权限点与角色契约通过`)
  log(`共识别 ${permissionCodes.size} 个权限点，未发现拼写漂移或匿名暴露问题`)
}

try {
  main()
  console.log('Task2 后端路由权限契约验证通过')
} catch (error) {
  console.error('Task2 后端路由权限契约验证失败', error)
  process.exit(1)
}
