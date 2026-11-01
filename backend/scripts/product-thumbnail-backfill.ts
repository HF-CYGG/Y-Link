/**
 * 文件说明：商品缩略图存量回填的命令行入口（本地/开发环境手动执行）。
 * 文件职责：调用 src/utils/product-thumbnail.ts 中的 backfillProductThumbnails，为 `uploads/products/` 下缺失缩略图的原图补齐 `<name>.thumb.webp`。
 * 使用方式：
 * - 预览：`npm run product:thumbnail:backfill -- --dry-run`
 * - 执行：`npm run product:thumbnail:backfill -- --concurrency=2`
 * - 指定目录：`--dir=<商品图目录>`（默认 `<当前工作目录>/uploads/products`）
 * 维护重点：
 * - 生产容器只包含编译产物，服务启动后会自动在后台回填一次，通常无需手动执行本脚本；
 * - 不读写数据库、不修改原图，可重复执行（幂等），有失败时以退出码 1 结束。
 */

import path from 'node:path'
import { backfillProductThumbnails } from '../src/utils/product-thumbnail.js'

const readArgValue = (name: string) => {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

const uploadDir = path.resolve(readArgValue('dir') ?? path.resolve(process.cwd(), 'uploads', 'products'))
const concurrency = Number(readArgValue('concurrency') ?? 2)

backfillProductThumbnails({
  uploadDir,
  dryRun: process.argv.includes('--dry-run'),
  concurrency: Number.isFinite(concurrency) ? concurrency : 2,
  log: (message) => console.log(message),
})
  .then((result) => {
    console.log(`[product-thumbnail-backfill] 扫描 ${result.scanned}，新生成 ${result.generated}，已存在 ${result.skippedExisting}，跳过非商品图 ${result.skippedInvalid}，失败 ${result.failed}`)
    process.exitCode = result.failed > 0 ? 1 : 0
  })
  .catch((error) => {
    console.error('[product-thumbnail-backfill] 执行失败：', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
