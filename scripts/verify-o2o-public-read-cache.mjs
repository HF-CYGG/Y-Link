import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const readBracedBody = (source, openingBraceIndex) => {
  let depth = 0
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(openingBraceIndex + 1, index)
  }
  assert.fail('无法读取缓存失效 wrapper 的完整函数体')
}

const serviceSource = read('backend/src/services/o2o-preorder.service.ts')
const routeSource = read('backend/src/routes/o2o.routes.ts')
const revisionSource = read('backend/src/services/mall-catalog-revision.service.ts')

assert.match(serviceSource, /O2O_MALL_CATALOG_FRESH_TTL_MS = 2_000/)
assert.match(serviceSource, /O2O_MALL_CATALOG_STALE_TTL_MS = 30_000/)
assert.match(serviceSource, /mallProductsRefreshInFlight/)
assert.match(serviceSource, /mallProductsRefreshRevision/)
assert.match(serviceSource, /responseBody = JSON\.stringify\(\{ code: 0, message: 'ok', data \}\)/)
assert.match(serviceSource, /createHash\('sha256'\).*digest\('base64url'\)/)
assert.match(serviceSource, /O2O_MALL_SOLD_QTY_TTL_MS = 60_000/)
assert.match(serviceSource, /mallSoldQtyRefreshInFlight/)

const invalidationWrapperMatch = /private\s+([A-Za-z_$][\w$]*)\s*\(\s*options\?\s*:\s*\{\s*soldQtyChanged\?\s*:\s*boolean\s*\}\s*\)\s*\{/.exec(serviceSource)
assert.ok(invalidationWrapperMatch, 'O2O 服务必须保留统一的目录与销量缓存失效 wrapper')
const invalidationWrapperName = invalidationWrapperMatch[1]
const wrapperOpeningBraceIndex = invalidationWrapperMatch.index + invalidationWrapperMatch[0].lastIndexOf('{')
const invalidationWrapperBody = readBracedBody(serviceSource, wrapperOpeningBraceIndex)
const catalogRevisionInvalidationIndex = invalidationWrapperBody.indexOf('invalidateMallCatalogReadCache()')
const soldQtyConditionIndex = invalidationWrapperBody.search(/if\s*\(\s*options\?\.soldQtyChanged\s*\)/)
assert.ok(
  catalogRevisionInvalidationIndex >= 0 && catalogRevisionInvalidationIndex < soldQtyConditionIndex,
  '每次成功变更都必须先无条件递增公开目录 revision，不能受 soldQtyChanged 条件影响',
)
assert.match(invalidationWrapperBody, /if\s*\(\s*options\?\.soldQtyChanged\s*\)\s*\{[\s\S]*mallSoldQtyRevision[\s\S]*mallSoldQtyCache\s*=\s*null/)
assert.equal(
  [...serviceSource.matchAll(/\binvalidateMallCatalogReadCache\(\)/g)].length,
  1,
  'O2O 服务的目录 revision 失效必须统一收口到 wrapper，避免写路径绕过同进程缓存清理',
)

const wrapperCallPattern = new RegExp(
  `this\\.${escapeRegExp(invalidationWrapperName)}\\(\\s*(?:\\{\\s*soldQtyChanged:\\s*([^}\\n]+)\\s*\\})?\\s*\\)`,
  'g',
)
const wrapperCalls = [...serviceSource.matchAll(wrapperCallPattern)]
assert.equal(wrapperCalls.length, 10, 'O2O 成功写路径必须继续通过统一 wrapper 触发目录 revision 失效')
const soldQtyChangedConditions = wrapperCalls
  .map((match) => match[1]?.replace(/\s+/g, ' ').trim())
  .filter(Boolean)
  .sort()
assert.deepEqual(
  soldQtyChangedConditions,
  ["result.status === 'verified'", 'result.timedOut === null'].sort(),
  '只有删除已核销订单或成功完成核销时才应清理销量聚合缓存',
)

assert.match(routeSource, /If-None-Match/i)
assert.match(routeSource, /res\.status\(304\)\.end\(\)/)
assert.match(routeSource, /public, max-age=2, stale-while-revalidate=30, stale-if-error=60/)
assert.match(routeSource, /public, max-age=5, stale-while-revalidate=60, stale-if-error=120/)
assert.match(routeSource, /sendPublicJsonSnapshot/)

assert.match(revisionSource, /Number\.MAX_SAFE_INTEGER/)
assert.match(revisionSource, /invalidateMallCatalogReadCache/)

for (const relativePath of [
  'backend/src/services/product.service.ts',
  'backend/src/services/tag.service.ts',
  'backend/src/services/inbound.service.ts',
  'backend/src/services/system-config.service.ts',
]) {
  assert.match(
    read(relativePath),
    /invalidateMallCatalogReadCache/,
    `${relativePath} 必须在公开目录相关写入提交后递增修订号`,
  )
}

console.log('✅ O2O 公开读缓存、singleflight、销量聚合缓存、写后失效与 ETag/304 静态契约通过')
