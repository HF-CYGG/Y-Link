import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsxCliPath = path.join(projectRoot, 'backend', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const verifyScriptPath = path.join(projectRoot, 'scripts', 'verify-product-sku-matrix-current.ts')

const result = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', path.join(projectRoot, 'tsconfig.app.json'), verifyScriptPath], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
  },
})

process.exit(result.status ?? 1)
