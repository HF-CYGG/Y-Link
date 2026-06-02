/**
 * 模块说明：src/types/html2pdf.d.ts
 * 文件职责：为 `html2pdf.js` 提供项目内最小可用类型声明，保障 PDF 导出工具在 TypeScript 下具备基础类型提示。
 * 实现逻辑：
 * - 为动态导入后实际会调用到的 worker 链式 API 补齐最小声明，避免类型系统把模块视为 `any`；
 * - 声明范围刻意保持精简，只覆盖当前项目真实用到的方法与工厂签名；
 * - 该文件只服务静态类型校验，不改变运行时的第三方库行为。
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
