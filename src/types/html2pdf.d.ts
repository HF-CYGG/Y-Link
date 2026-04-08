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
