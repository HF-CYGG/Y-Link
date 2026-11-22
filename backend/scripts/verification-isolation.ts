/** 验证入口专用：在任何应用模块求值前隔离配置/持久路径，连接或写入前核对实际最终目标。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { DataSource } from 'typeorm'

export type VerificationTarget = { type: 'sqlite'; database: string } | {
  type: 'mysql'; host: string; port: number; user: string; password: string; database: string
}
const hash = (value: unknown) => createHash('sha256').update(String(value ?? '')).digest('hex')
const inside = (root: string, target: string) => { const relative = path.relative(root, path.resolve(target)); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) }
type ExpectedTarget = { type: 'sqlite'; database: string } | { type: 'mysql'; host: string; port: number; user: string; database: string; passwordHash: string }

export function createVerificationIsolation(label: string) {
  assert.match(label, /^[a-z0-9-]+$/)
  const parent = fs.realpathSync(os.tmpdir()), rootDir = fs.mkdtempSync(path.join(parent, `ylink-verify-${label}-`))
  const token = randomBytes(24).toString('hex'), ownerFile = path.join(rootDir, '.verification-owner')
  const envFile = path.join(rootDir, 'empty.env'), profile = `verify-${label}-${randomBytes(12).toString('hex')}`
  fs.writeFileSync(ownerFile, token, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(envFile, '', { flag: 'wx', mode: 0o600 })
  // cwd 派生的上传/备份同样落自有目录；tsx 子导入保留原后端装饰器编译配置。
  fs.copyFileSync(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), path.join(rootDir, 'tsconfig.json'))
  const cwdBefore = process.cwd()
  let expected: ExpectedTarget | undefined
  const applyBoundary = () => {
    Object.assign(process.env, { ENV_FILE: envFile, APP_PROFILE: profile, Y_LINK_DATA_DIR: rootDir,
      Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true', REDIS_URL: '', Y_LINK_MULTI_INSTANCE: 'false', ALIYUN_DYPNS_MNS_ENABLED: 'false' })
    process.chdir(rootDir)
  }
  applyBoundary()
  process.env.Y_LINK_DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  const seal = (target: VerificationTarget) => {
    assert.equal(expected, undefined, '验证目标只能固化一次')
    applyBoundary() // 覆盖旧入口自身的固定profile/数据根；随后只能读取新空ENV_FILE。
    if (target.type === 'sqlite') {
      expected = { type: 'sqlite', database: path.resolve(target.database) }
      Object.assign(process.env, { DB_TYPE: 'sqlite', SQLITE_DB_PATH: expected.database })
    } else {
      assert.ok(target.host && Number.isInteger(target.port) && target.port > 0 && target.port <= 65535 && target.user && target.database)
      expected = { type: 'mysql', host: target.host, port: target.port, user: target.user, database: target.database, passwordHash: hash(target.password) }
      Object.assign(process.env, { DB_TYPE: 'mysql', DB_HOST: target.host, DB_PORT: String(target.port), DB_USER: target.user, DB_PASSWORD: target.password, DB_NAME: target.database })
    }
    process.env.Y_LINK_VERIFICATION_CONTEXT = JSON.stringify({ rootDir, envFile, profile, token, target: expected })
  }
  const assertTarget = async (source: DataSource) => {
    assert.ok(expected, '必须在应用模块导入前固化验证目标')
    await assertVerificationContext(source, { rootDir, envFile, profile, token, target: expected })
  }
  const cleanup = () => {
    if (!fs.existsSync(rootDir)) return
    const resolved = fs.realpathSync(rootDir)
    assert.equal(path.dirname(resolved), parent)
    assert.equal(resolved, rootDir)
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), token)
    if (process.cwd() === rootDir) process.chdir(cwdBefore)
    fs.rmSync(resolved, { recursive: true, force: true })
  }
  process.once('exit', () => { try { cleanup() } catch { console.error('[verification-isolation] 自有临时目录未能清理，未触碰其他路径') } })
  return { rootDir, uploadsDir: path.join(rootDir, 'uploads'), envFile, seal, assertTarget, cleanup }
}

type Context = { rootDir: string; envFile: string; profile: string; token: string; target: Record<string, unknown> }
async function assertVerificationContext(source: DataSource, context: Context) {
  const fail = () => { throw new Error('VERIFICATION_TARGET_MISMATCH') }
  if (process.env.ENV_FILE !== context.envFile || process.env.APP_PROFILE !== context.profile
    || process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE !== 'true' || process.env.REDIS_URL !== '') fail()
  if (fs.readFileSync(path.join(context.rootDir, '.verification-owner'), 'utf8') !== context.token) fail()
  const options = source.options as unknown as Record<string, unknown>, target = context.target
  if (options.type !== target.type) fail()
  if (target.type === 'sqlite') {
    if (path.resolve(String(options.database)) !== target.database) fail()
  } else if (options.host !== target.host || Number(options.port) !== target.port || options.username !== target.user
    || options.database !== target.database || hash(options.password) !== target.passwordHash) fail()
  const { appDataPaths } = await import('../src/config/app-data-paths.js')
  if (appDataPaths.rootDir !== context.rootDir || process.cwd() !== context.rootDir) fail()
  for (const value of Object.values(appDataPaths)) if (!inside(context.rootDir, value)) fail()
  if (!inside(context.rootDir, path.resolve('uploads')) || !inside(context.rootDir, path.resolve('data', 'backup'))) fail()
}

/** 仅用于测试父进程派生的 schema worker；不修改应用的正常配置读取优先级。 */
export async function assertInheritedVerificationTarget(source: DataSource) {
  const context = JSON.parse(process.env.Y_LINK_VERIFICATION_CONTEXT ?? 'null') as Context | null
  assert.ok(context && context.rootDir && context.target, '缺少父验证进程的独占目标证明')
  await assertVerificationContext(source, context)
}
