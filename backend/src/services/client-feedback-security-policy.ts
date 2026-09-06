/**
 * 反馈附件与实时通道的安全边界常量。
 *
 * 只读取明确的环境变量并进行严格校验，避免把未校验的部署配置直接带入
 * 上传、配额和长连接控制逻辑；默认值保持本地单实例部署可用。
 */

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} 必须是整数`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须在 ${minimum} 到 ${maximum} 之间`)
  }
  return value
}

export const CLIENT_FEEDBACK_ATTACHMENT_POLICY = {
  maxAttachmentsPerMessage: readBoundedInteger('YLINK_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE', 5, 1, 5),
  maxPendingAttachmentsPerClient: readBoundedInteger('YLINK_FEEDBACK_MAX_PENDING_ATTACHMENTS', 10, 1, 100),
  maxPendingBytesPerClient: readBoundedInteger('YLINK_FEEDBACK_MAX_PENDING_BYTES', 50 * 1024 * 1024, 1, 1024 * 1024 * 1024),
  maxTotalBytes: readBoundedInteger('YLINK_FEEDBACK_MAX_TOTAL_BYTES', 10 * 1024 * 1024 * 1024, 1, 1024 * 1024 * 1024 * 1024),
  minFreeBytes: readBoundedInteger('YLINK_FEEDBACK_MIN_FREE_BYTES', 512 * 1024 * 1024, 1, 10 * 1024 * 1024 * 1024),
  draftTtlMs: readBoundedInteger('YLINK_FEEDBACK_DRAFT_TTL_MS', 24 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
  orphanGraceMs: readBoundedInteger('YLINK_FEEDBACK_ORPHAN_GRACE_MS', 24 * 60 * 60 * 1000, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000),
  cleanupIntervalMs: readBoundedInteger('YLINK_FEEDBACK_CLEANUP_INTERVAL_MS', 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
  cleanupBatchSize: readBoundedInteger('YLINK_FEEDBACK_CLEANUP_BATCH_SIZE', 500, 1, 5_000),
  uploadRateLimit: readBoundedInteger('YLINK_FEEDBACK_UPLOADS_PER_WINDOW', 20, 1, 100),
  uploadRateWindowMs: readBoundedInteger('YLINK_FEEDBACK_UPLOAD_WINDOW_MS', 10 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
} as const

export const CUSTOMER_SERVICE_REALTIME_POLICY = {
  maxSubscribersPerSession: readBoundedInteger('YLINK_SSE_MAX_PER_SESSION', 3, 1, 10),
  maxSubscribersPerOwner: readBoundedInteger('YLINK_SSE_MAX_PER_OWNER', 20, 1, 100),
  maxSubscribersPerProcess: readBoundedInteger('YLINK_SSE_MAX_PER_PROCESS', 1000, 1, 10_000),
  connectionRateLimit: readBoundedInteger('YLINK_SSE_CONNECTS_PER_WINDOW', 12, 1, 100),
  connectionRateWindowMs: readBoundedInteger('YLINK_SSE_CONNECT_WINDOW_MS', 60_000, 10_000, 60 * 60 * 1000),
  connectionRateMaxEntries: readBoundedInteger('YLINK_SSE_CONNECT_RATE_MAX_ENTRIES', 2_000, 1, 20_000),
  maxPendingMessages: readBoundedInteger('YLINK_SSE_MAX_PENDING_MESSAGES', 256, 1, 10_000),
  maxPendingBytes: readBoundedInteger('YLINK_SSE_MAX_PENDING_BYTES', 4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
  revalidateIdleMs: 30_000,
  slowConsumerMaxBufferedBytes: 256 * 1024,
  slowConsumerTimeoutMs: 10_000,
  validationBatchSize: 200,
} as const
