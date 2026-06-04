/**
 * 模块说明：src/utils/error-dialog.ts
 * 文件职责：统一承接关键操作失败弹窗与普通错误轻提示，避免业务页面重复拼装错误展示。
 * 实现逻辑：
 * - 复用 `buildRequestErrorDisplayInfo` 生成用户可读原因、处理建议与排查信息；
 * - 关键提交类错误用 MessageBox 展示，避免一行 toast 被忽略；
 * - 普通加载类错误仍使用 ElMessage，减少对列表刷新、表单校验等轻量场景的打扰。
 * 维护说明：
 * - 这里不处理鉴权跳转和请求重试，只负责展示；
 * - 新增敏感字段时不得写入 diagnosticText，避免复制排查信息时泄露凭证。
 */

import { h } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  buildRequestErrorDisplayInfo,
  normalizeRequestError,
  type RequestErrorDisplayInfo,
} from '@/utils/error'

interface CriticalErrorDialogOptions {
  title?: string
  fallback?: string
  operation?: string
}

let latestDialogKey = ''
let latestDialogAt = 0

const copyDiagnosticText = async (info: RequestErrorDisplayInfo) => {
  try {
    await navigator.clipboard.writeText(info.diagnosticText)
    ElMessage.success('排查信息已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选中排查信息复制')
  }
}

const buildDialogContent = (info: RequestErrorDisplayInfo) => {
  return h('div', { class: 'space-y-4 text-left text-sm leading-6 text-slate-700' }, [
    h('div', { class: 'rounded-2xl bg-rose-50 px-4 py-3 text-rose-700' }, [
      h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-rose-500' }, '失败原因'),
      h('p', { class: 'mt-1 whitespace-pre-wrap text-[15px] font-semibold text-rose-800' }, info.message),
    ]),
    h('div', { class: 'rounded-2xl bg-slate-50 px-4 py-3 text-slate-700' }, [
      h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-slate-400' }, '建议处理'),
      h('p', { class: 'mt-1 whitespace-pre-wrap' }, info.suggestion),
    ]),
    h('div', { class: 'rounded-2xl border border-slate-200 bg-white px-4 py-3' }, [
      h('div', { class: 'flex items-center justify-between gap-3' }, [
        h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-slate-400' }, '排查信息'),
        h(
          'button',
          {
            type: 'button',
            class: 'rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-teal-300 hover:text-teal-700',
            onClick: () => void copyDiagnosticText(info),
          },
          '复制',
        ),
      ]),
      h('pre', { class: 'mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-950 p-3 text-xs leading-5 text-slate-100' }, info.diagnosticText),
    ]),
  ])
}

export const showCriticalErrorDialog = async (error: unknown, options: CriticalErrorDialogOptions = {}) => {
  const info = buildRequestErrorDisplayInfo(error, options.fallback, {
    title: options.title,
    operation: options.operation,
  })
  const dialogKey = `${info.title}|${info.message}|${info.status ?? ''}|${info.code ?? ''}`
  const now = Date.now()

  if (dialogKey === latestDialogKey && now - latestDialogAt < 800) {
    return
  }
  latestDialogKey = dialogKey
  latestDialogAt = now

  await ElMessageBox.alert(buildDialogContent(info), info.title, {
    type: 'error',
    confirmButtonText: '我知道了',
    closeOnClickModal: false,
    closeOnPressEscape: true,
    customClass: 'ylink-critical-error-dialog',
  }).catch(() => undefined)
}

export const showRequestErrorMessage = (error: unknown, fallback = '请求失败，请稍后重试') => {
  ElMessage.error(normalizeRequestError(error, fallback).message)
}
