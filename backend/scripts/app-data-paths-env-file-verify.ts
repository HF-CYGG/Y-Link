import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

interface ResolvedPaths {
  rootDir: string
  runtimeOverrideFile: string
  migrationTaskDir: string
}

function resolvePathsInCleanProcess(environment: NodeJS.ProcessEnv): ResolvedPaths {
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "const { appDataPaths } = await import('./src/config/app-data-paths.ts'); process.stdout.write(JSON.stringify(appDataPaths));",
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: environment,
      encoding: 'utf8',
    },
  )
  assert.equal(child.status, 0, child.stderr || '子进程解析应用数据目录失败')
  return JSON.parse(child.stdout) as ResolvedPaths
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'y-link-app-data-paths-'))
const backendRoot = path.resolve(import.meta.dirname, '..')
const profileName = `verify-app-data-paths-${process.pid}-${Date.now()}`
const profileFile = path.join(backendRoot, `.env.${profileName}`)
try {
  const processConfiguredRoot = path.join(tempRoot, 'process-data')
  const processEnvironment = {
    ...process.env,
    Y_LINK_DATA_DIR: processConfiguredRoot,
    Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
  }
  delete processEnvironment.ENV_FILE
  delete processEnvironment.APP_PROFILE
  const processPaths = resolvePathsInCleanProcess(processEnvironment)
  assert.equal(processPaths.rootDir, path.resolve(processConfiguredRoot))

  const profileConfiguredRoot = path.join(tempRoot, 'profile-data')
  await writeFile(
    profileFile,
    `Y_LINK_DATA_DIR=${profileConfiguredRoot.replaceAll('\\', '/')}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
    },
  )
  const profileEnvironment = {
    ...process.env,
    APP_PROFILE: profileName,
    Y_LINK_DATA_DIR: processConfiguredRoot,
    Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
  }
  delete profileEnvironment.ENV_FILE
  const profilePaths = resolvePathsInCleanProcess(profileEnvironment)
  assert.equal(profilePaths.rootDir, path.resolve(profileConfiguredRoot))

  const envConfiguredRoot = path.join(tempRoot, 'env-file-data')
  const envFile = path.join(tempRoot, 'custom.env')
  await writeFile(
    envFile,
    `Y_LINK_DATA_DIR=${envConfiguredRoot.replaceAll('\\', '/')}\n`,
    'utf8',
  )

  const envFileEnvironment = {
    ...process.env,
    APP_PROFILE: profileName,
    ENV_FILE: envFile,
    Y_LINK_DATA_DIR: processConfiguredRoot,
    Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
  }
  const envFilePaths = resolvePathsInCleanProcess(envFileEnvironment)
  assert.equal(envFilePaths.rootDir, path.resolve(envConfiguredRoot))
  assert.equal(
    envFilePaths.runtimeOverrideFile,
    path.join(path.resolve(envConfiguredRoot), 'runtime', 'database-runtime-override.json'),
  )
  assert.equal(
    envFilePaths.migrationTaskDir,
    path.join(path.resolve(envConfiguredRoot), 'database-migration', 'tasks'),
  )

  console.log('[app-data-paths-env-file-verify] 进程环境、profile 与 ENV_FILE 路径优先级均通过')
} finally {
  await rm(profileFile, { force: true })
  await rm(tempRoot, { recursive: true, force: true })
}
