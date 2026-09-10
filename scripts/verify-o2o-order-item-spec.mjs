/**
 * 模块说明：scripts/verify-o2o-order-item-spec.mjs
 * 文件职责：以仓库统一方式驱动 O2O 明细规格展示口径校验（issue #62）。
 * 实现逻辑：复用 backend 内置的 tsx CLI 执行 TypeScript 校验脚本，避免为验证单独引入新依赖。
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsxCliPath = path.join(projectRoot, 'backend', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const verifyScriptPath = path.join(projectRoot, 'scripts', 'verify-o2o-order-item-spec-current.ts')

const result = spawnSync(
  process.execPath,
  [tsxCliPath, '--tsconfig', path.join(projectRoot, 'tsconfig.app.json'), verifyScriptPath],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  },
)

process.exit(result.status ?? 1)
