/**
 * 模块说明：src/utils/error-dialog.ts
 * 文件职责：保留关键错误提示的历史调用入口，并把展示层统一转交给全局 AppAlert。
 * 实现逻辑：旧页面仍可调用 showCriticalErrorDialog / showRequestErrorMessage，内部不再弹 MessageBox，而是生成顶部 Alert 提示。
 * 维护说明：确认框、输入框仍由业务页面直接使用 ElMessageBox，本文件只处理提示展示，不处理用户确认流程。
 */

import {
  showAppError,
  showCriticalAppError,
} from '@/utils/app-alert'
import { normalizeRequestError } from '@/utils/error'

interface CriticalErrorDialogOptions {
  title?: string
  fallback?: string
  operation?: string
}

export const showCriticalErrorDialog = async (error: unknown, options: CriticalErrorDialogOptions = {}) => {
  showCriticalAppError(error, options)
}

export const showRequestErrorMessage = (error: unknown, fallback = '请求失败，请稍后重试') => {
  showAppError(normalizeRequestError(error, fallback).message, fallback)
}
