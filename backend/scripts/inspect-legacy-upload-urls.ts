/**
 * 文件说明：backend/scripts/inspect-legacy-upload-urls.ts
 * 文件职责：巡检数据库中仍然使用历史单层 `/uploads/<file>` 路径的商品缩略图与反馈附件记录。
 * 实现逻辑：
 * 1. 初始化当前运行环境对应的数据源，并确保基础表结构已可读取；
 * 2. 扫描 `base_product.thumbnail` 中仍为旧单层路径的商品记录；
 * 3. 扫描 `client_feedback_message.attachment_json` 中仍包含旧单层路径的消息记录；
 * 4. 输出总数与样本，便于线上排查剩余历史数据来源。
 * 维护说明：
 * - 若后续新增新的上传业务字段，请同步把该字段的巡检逻辑补入本脚本；
 * - 本脚本只做只读巡检，不会修改数据库或移动物理文件。
 */

import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { env } from '../src/config/env.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { ClientFeedbackMessage, type ClientFeedbackMessageAttachment } from '../src/entities/client-feedback-message.entity.js'

const LEGACY_UPLOAD_URL_MATCHER = /^\/uploads\/[^/]+$/
const SAMPLE_LIMIT = 20

interface LegacyProductThumbnailSample {
  id: string
  productCode: string
  productName: string
  thumbnail: string
}

interface LegacyFeedbackAttachmentSample {
  id: string
  conversationId: string
  legacyUrls: string[]
  attachmentPreview: string
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength)}...`
}

function parseAttachments(rawAttachmentJson: string): ClientFeedbackMessageAttachment[] {
  const normalizedJson = rawAttachmentJson.trim()
  if (!normalizedJson || normalizedJson === '[]') {
    return []
  }

  try {
    const parsedValue = JSON.parse(normalizedJson) as unknown
    if (!Array.isArray(parsedValue)) {
      return []
    }

    return parsedValue.filter((item): item is ClientFeedbackMessageAttachment => {
      return Boolean(item) && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string'
    })
  } catch {
    return []
  }
}

async function inspectLegacyProductThumbnails() {
  const productRepository = AppDataSource.getRepository(BaseProduct)
  const legacyProducts = await productRepository
    .createQueryBuilder('product')
    .select(['product.id', 'product.productCode', 'product.productName', 'product.thumbnail'])
    .where('product.thumbnail LIKE :legacyPrefix', { legacyPrefix: '/uploads/%' })
    .andWhere('product.thumbnail NOT LIKE :categorizedPrefix', { categorizedPrefix: '/uploads/products/%' })
    .orderBy('product.id', 'ASC')
    .getMany()

  const samples: LegacyProductThumbnailSample[] = legacyProducts.slice(0, SAMPLE_LIMIT).map((product) => ({
    id: String(product.id),
    productCode: product.productCode,
    productName: product.productName,
    thumbnail: product.thumbnail ?? '',
  }))

  return {
    count: legacyProducts.length,
    samples,
  }
}

async function inspectLegacyFeedbackAttachments() {
  const messageRepository = AppDataSource.getRepository(ClientFeedbackMessage)
  const candidateMessages = await messageRepository
    .createQueryBuilder('message')
    .select(['message.id', 'message.conversationId', 'message.attachmentJson'])
    .where('message.attachmentJson LIKE :uploadPrefix', { uploadPrefix: '%/uploads/%' })
    .orderBy('message.id', 'ASC')
    .getMany()

  const legacySamples: LegacyFeedbackAttachmentSample[] = []
  let legacyCount = 0

  candidateMessages.forEach((message) => {
    const attachments = parseAttachments(message.attachmentJson)
    const legacyUrls = attachments
      .map((attachment) => attachment.url.trim())
      .filter((url) => LEGACY_UPLOAD_URL_MATCHER.test(url))

    if (!legacyUrls.length) {
      return
    }

    legacyCount += 1
    if (legacySamples.length < SAMPLE_LIMIT) {
      legacySamples.push({
        id: String(message.id),
        conversationId: String(message.conversationId),
        legacyUrls,
        attachmentPreview: truncateText(message.attachmentJson, 180),
      })
    }
  })

  return {
    count: legacyCount,
    samples: legacySamples,
  }
}

function printSection(title: string) {
  console.log(`\n=== ${title} ===`)
}

async function run() {
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)

  try {
    const productResult = await inspectLegacyProductThumbnails()
    const feedbackResult = await inspectLegacyFeedbackAttachments()

    console.log('旧上传路径巡检结果')
    console.log(`数据库类型：${env.DB_TYPE}`)
    if (env.DB_TYPE === 'sqlite') {
      console.log(`SQLite 路径：${env.SQLITE_DB_PATH}`)
    } else {
      console.log(`MySQL 库：${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`)
    }

    printSection('商品缩略图旧路径')
    console.log(`剩余记录数：${productResult.count}`)
    if (!productResult.samples.length) {
      console.log('样本：无')
    } else {
      productResult.samples.forEach((sample, index) => {
        console.log(
          `${index + 1}. id=${sample.id} productCode=${sample.productCode} productName=${sample.productName} thumbnail=${sample.thumbnail}`,
        )
      })
    }

    printSection('反馈附件旧路径')
    console.log(`剩余消息数：${feedbackResult.count}`)
    if (!feedbackResult.samples.length) {
      console.log('样本：无')
    } else {
      feedbackResult.samples.forEach((sample, index) => {
        console.log(
          `${index + 1}. id=${sample.id} conversationId=${sample.conversationId} legacyUrls=${sample.legacyUrls.join(', ')}`,
        )
        console.log(`   attachmentJson=${sample.attachmentPreview}`)
      })
    }

    printSection('巡检结论')
    if (productResult.count === 0 && feedbackResult.count === 0) {
      console.log('当前数据库未发现旧单层上传路径残留。')
    } else {
      console.log('当前数据库仍存在旧单层上传路径，请结合样本继续清理历史数据或核查写入链路。')
    }
  } finally {
    await AppDataSource.destroy()
  }
}

await run().catch((error) => {
  console.error('旧上传路径巡检失败：', error)
  process.exitCode = 1
})
