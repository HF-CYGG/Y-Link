/**
 * 模块说明：src/types/html2pdf.d.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

declare module 'html2pdf.js' {
  export interface Html2PdfWorker {
    set: (options: Record<string, unknown>) => Html2PdfWorker
    from: (source: HTMLElement) => Html2PdfWorker
    save: (filename?: string) => Promise<void>
  }

  export interface Html2PdfFactory {
    (): Html2PdfWorker
  }

  const html2pdf: Html2PdfFactory
  export default html2pdf
}
