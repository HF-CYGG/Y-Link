/**
 * 模块说明：src/utils/pdf/export-voucher-pdf.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
