import assert from 'node:assert/strict'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mobileRoot = path.join(repositoryRoot, 'apps/mobile')
const mobileRequire = createRequire(path.join(mobileRoot, 'package.json'))

const readJson = async (relativePath) => {
  const absolutePath = path.join(repositoryRoot, relativePath)
  return JSON.parse(await readFile(absolutePath, 'utf8'))
}

const rootManifest = await readJson('package.json')
const mobileManifest = await readJson('apps/mobile/package.json')
const rootLockfile = await readJson('package-lock.json')

assert.deepEqual(
  rootManifest.workspaces,
  ['apps/mobile', 'packages/*'],
  '根 package.json 必须声明唯一的 Mobile/shared npm workspace 范围',
)
assert.equal(
  existsSync(path.join(mobileRoot, 'package-lock.json')),
  false,
  'Mobile 不得保留与根依赖图分叉的 package-lock.json',
)
for (const specifier of ['@ylink/shared-types', '@ylink/api-client', '@ylink/validation']) {
  assert.equal(
    mobileManifest.dependencies?.[specifier],
    '*',
    `Mobile 必须通过 workspace 依赖 ${specifier}`,
  )
}
assert.equal(
  Object.hasOwn(mobileManifest.dependencies ?? {}, 'y-link'),
  false,
  'Mobile 不得把仓库根 y-link 包作为 file 依赖',
)

const expectedPackageNames = new Map([
  ['packages/shared-types/package.json', '@ylink/shared-types'],
  ['packages/api-client/package.json', '@ylink/api-client'],
  ['packages/domain/package.json', '@ylink/domain'],
  ['packages/validation/package.json', '@ylink/validation'],
  ['packages/design-tokens/package.json', '@ylink/design-tokens'],
])

for (const [manifestPath, expectedName] of expectedPackageNames) {
  const manifest = await readJson(manifestPath)
  assert.equal(manifest.name, expectedName, `${manifestPath} 的包名必须为 ${expectedName}`)
}

const apiClientManifest = await readJson('packages/api-client/package.json')
assert.equal(
  apiClientManifest.dependencies?.['@ylink/shared-types'],
  '*',
  'api-client 必须显式声明 shared-types workspace 依赖',
)

for (const workspacePath of [
  'apps/mobile',
  'packages/shared-types',
  'packages/api-client',
  'packages/domain',
  'packages/validation',
  'packages/design-tokens',
]) {
  assert.ok(
    rootLockfile.packages?.[workspacePath],
    `根 package-lock.json 缺少 workspace 条目：${workspacePath}`,
  )
}

const resolveWorkspaceEntry = (specifier, expectedDirectory) => {
  const resolvedEntry = mobileRequire.resolve(specifier)
  const realEntry = realpathSync(resolvedEntry)
  const expectedRoot = `${realpathSync(path.join(repositoryRoot, expectedDirectory))}${path.sep}`
  assert.ok(
    realEntry.startsWith(expectedRoot),
    `${specifier} 必须解析到仓库 workspace，而不是 registry 或临时副本`,
  )
  return pathToFileURL(realEntry).href
}

resolveWorkspaceEntry('@ylink/shared-types', 'packages/shared-types')
resolveWorkspaceEntry('@ylink/validation', 'packages/validation')

const apiClientUrl = resolveWorkspaceEntry('@ylink/api-client', 'packages/api-client')
const { ApiClientError } = await import(apiClientUrl)
const normalizedError = new ApiClientError('workspace-smoke', { kind: 'network' })
assert.ok(normalizedError instanceof Error, 'api-client 的标准错误必须继承 Error')
assert.equal(normalizedError.kind, 'network', 'api-client 的标准错误必须保留错误种类')

const hasMobileApp = ['app', 'src', 'app.config.ts', 'app.config.js', 'app.json', 'tsconfig.json']
  .some((entry) => existsSync(path.join(mobileRoot, entry)))

if (hasMobileApp) {
  const mobileBoundaryPath = 'src/contracts/shared-packages.ts'
  const requiredAppFiles = ['app.config.ts', 'tsconfig.json', 'app/_layout.tsx', 'app/index.tsx', mobileBoundaryPath]
  const missingAppFiles = requiredAppFiles.filter(
    (entry) => !statSync(path.join(mobileRoot, entry), { throwIfNoEntry: false })?.isFile(),
  )
  assert.equal(missingAppFiles.length, 0, `Mobile 应用缺少必要文件：${missingAppFiles.join('、')}`)

  const mobileBoundary = await import(pathToFileURL(path.join(mobileRoot, mobileBoundaryPath)).href)
  assert.equal(
    mobileBoundary.isSharedApiClientError(normalizedError),
    true,
    'Mobile Contract 边界必须实际消费 api-client 的标准错误类型',
  )
  console.log('Mobile 应用共享包 Contract 检查通过')
} else {
  console.log('Mobile 应用源码已移除，应用 Contract 检查不适用')
}

console.log('Mobile workspace 依赖模型验证通过')
