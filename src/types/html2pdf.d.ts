/**
 * 模块说明：F:/Y-Link/src/types/html2pdf.d.ts
 * 文件职责：html2pdf 类型声明补丁。
 * 实现逻辑：补充第三方库在项目中的 TypeScript 类型，消除编译告警。
 * 维护说明：升级依赖后需核对声明是否仍匹配。
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
