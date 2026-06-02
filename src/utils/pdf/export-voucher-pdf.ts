/**
 * 模块说明：src/utils/pdf/export-voucher-pdf.ts
 * 文件职责：封装凭证类页面导出 PDF 的共享工具，统一处理 `html2pdf.js` 动态加载与导出参数组装。
 * 实现逻辑：
 * - 调用时按需动态导入 `html2pdf.js`，避免非导出场景把 PDF 依赖提前打入首屏链路；
 * - 统一接收源节点、文件名、边距、缩放和方向等参数，减少各页面重复拼装导出配置；
 * - 工具层只负责导出执行，不关心具体业务凭证内容，由调用页面提供最终 DOM 节点。
 */

import type { Html2PdfFactory } from 'html2pdf.js'

export interface ExportVoucherPdfOptions {
  sourceElement: HTMLElement
  filename: string
  marginMm?: number
  scale?: number
  orientation?: 'portrait' | 'landscape'
}

const resolveHtml2PdfFactory = async () => {
  const module = await import('html2pdf.js')
  const defaultFactory = module.default as Html2PdfFactory | undefined

  if (typeof defaultFactory === 'function') {
    return defaultFactory
  }

  throw new Error('PDF 导出模块加载失败')
}

export const exportVoucherPdf = async (options: ExportVoucherPdfOptions) => {
  const factory = await resolveHtml2PdfFactory()
  const margin = options.marginMm ?? 8
  const scale = options.scale ?? 2
  const orientation = options.orientation ?? 'portrait'

  await factory()
    .set({
      margin,
      filename: options.filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: {
        scale,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
      },
      jsPDF: {
        unit: 'mm',
        format: 'a4',
        orientation,
        compress: true,
      },
      pagebreak: {
        mode: ['css', 'legacy'],
      },
    })
    .from(options.sourceElement)
    .save(options.filename)
}
