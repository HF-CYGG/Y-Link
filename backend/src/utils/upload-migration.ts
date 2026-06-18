/**
 * 文件说明：上传资源迁移工具，用于在服务启动时把历史旧路径附件迁移到新的分类目录结构。
 * 实现逻辑：仅识别旧版单层 `/uploads/<file>` 路径，先搬运磁盘文件再更新数据库 URL，并保持重复执行时的幂等性。
 * 维护重点：新增上传业务模块或调整目录结构时，需要同步补充旧 URL 识别规则和相应的数据迁移范围。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DataSource } from 'typeorm'
import { BaseProduct } from '../entities/base-product.entity.js'
import { ClientFeedbackMessage, type ClientFeedbackMessageAttachment } from '../entities/client-feedback-message.entity.js'
import { buildUploadPublicUrl, ensureUploadCategoryDir, type UploadCategory } from './upload-storage.js'

const LEGACY_UPLOAD_URL_MATCHER = /^\/uploads\/([^/]+)$/

export interface UploadMigrationResult {
  productThumbnailUpdatedCount: number
  feedbackAttachmentUpdatedCount: number
  movedFileCount: number
}

const resolveLegacyUploadFileName = (url?: string | null) => {
  const normalizedUrl = url?.trim()
  if (!normalizedUrl) {
    return null
  }
  const match = LEGACY_UPLOAD_URL_MATCHER.exec(normalizedUrl)
  return match?.[1] ?? null
}

const moveLegacyUploadFileIfNeeded = (
  uploadsRootDir: string,
  category: UploadCategory,
  fileName: string,
): boolean => {
  const legacyFilePath = path.resolve(uploadsRootDir, fileName)
  const targetDir = ensureUploadCategoryDir(category)
  const targetFilePath = path.resolve(targetDir, fileName)

  if (fs.existsSync(targetFilePath)) {
    return false
  }
  if (!fs.existsSync(legacyFilePath)) {
    return false
  }

  fs.renameSync(legacyFilePath, targetFilePath)
  return true
}

/**
 * 商品缩略图旧路径迁移：
 * - 历史记录只存 `/uploads/<uuid>.<ext>`；
 * - 升级后统一改为 `/uploads/products/<uuid>.<ext>`。
 */
const migrateLegacyProductThumbnails = async (dataSource: DataSource, uploadsRootDir: string) => {
  const productRepository = dataSource.getRepository(BaseProduct)
  const products = await productRepository.find({
    select: {
      id: true,
      thumbnail: true,
    },
  })

  let productThumbnailUpdatedCount = 0
  let movedFileCount = 0
  for (const product of products) {
    const legacyFileName = resolveLegacyUploadFileName(product.thumbnail)
    if (!legacyFileName) {
      continue
    }

    if (moveLegacyUploadFileIfNeeded(uploadsRootDir, 'products', legacyFileName)) {
      movedFileCount += 1
    }

    product.thumbnail = buildUploadPublicUrl('products', legacyFileName)
    await productRepository.save(product)
    productThumbnailUpdatedCount += 1
  }

  return {
    productThumbnailUpdatedCount,
    movedFileCount,
  }
}

const normalizeMigratedFeedbackAttachments = (
  attachments: ClientFeedbackMessageAttachment[],
  uploadsRootDir: string,
) => {
  let changed = false
  let movedFileCount = 0

  const nextAttachments = attachments.map((attachment) => {
    const legacyFileName = resolveLegacyUploadFileName(attachment.url)
    if (!legacyFileName) {
      return attachment
    }

    if (moveLegacyUploadFileIfNeeded(uploadsRootDir, 'client-feedback', legacyFileName)) {
      movedFileCount += 1
    }

    changed = true
    return {
      ...attachment,
      url: buildUploadPublicUrl('client-feedback', legacyFileName),
    }
  })

  return {
    changed,
    movedFileCount,
    nextAttachments,
  }
}

/**
 * 反馈消息附件旧路径迁移：
 * - 历史附件保存在消息表 `attachment_json`；
 * - 仅改写仍指向旧单层路径的记录，已升级路径保持不动。
 */
const migrateLegacyFeedbackAttachments = async (dataSource: DataSource, uploadsRootDir: string) => {
  const messageRepository = dataSource.getRepository(ClientFeedbackMessage)
  const messages = await messageRepository.find({
    select: {
      id: true,
      attachmentJson: true,
    },
  })

  let feedbackAttachmentUpdatedCount = 0
  let movedFileCount = 0

  for (const message of messages) {
    const rawAttachmentJson = typeof message.attachmentJson === 'string' ? message.attachmentJson.trim() : ''
    if (!rawAttachmentJson || rawAttachmentJson === '[]') {
      continue
    }

    let attachments: ClientFeedbackMessageAttachment[]
    try {
      attachments = JSON.parse(rawAttachmentJson) as ClientFeedbackMessageAttachment[]
    } catch {
      continue
    }

    if (!Array.isArray(attachments) || attachments.length === 0) {
      continue
    }

    const normalizedResult = normalizeMigratedFeedbackAttachments(attachments, uploadsRootDir)
    if (!normalizedResult.changed) {
      continue
    }

    message.attachmentJson = JSON.stringify(normalizedResult.nextAttachments)
    await messageRepository.save(message)
    feedbackAttachmentUpdatedCount += 1
    movedFileCount += normalizedResult.movedFileCount
  }

  return {
    feedbackAttachmentUpdatedCount,
    movedFileCount,
  }
}

export const migrateLegacyUploadReferences = async (dataSource: DataSource): Promise<UploadMigrationResult> => {
  const uploadsRootDir = path.resolve(process.cwd(), 'uploads')
  ensureUploadCategoryDir('products')
  ensureUploadCategoryDir('client-feedback')

  const productMigrationResult = await migrateLegacyProductThumbnails(dataSource, uploadsRootDir)
  const feedbackMigrationResult = await migrateLegacyFeedbackAttachments(dataSource, uploadsRootDir)

  return {
    productThumbnailUpdatedCount: productMigrationResult.productThumbnailUpdatedCount,
    feedbackAttachmentUpdatedCount: feedbackMigrationResult.feedbackAttachmentUpdatedCount,
    movedFileCount: productMigrationResult.movedFileCount + feedbackMigrationResult.movedFileCount,
  }
}
