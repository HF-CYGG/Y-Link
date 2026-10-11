export interface Html2pdfShortenerReport {
  sourceSha256: string
  transformedSha256: string
  originalLength: number
  transformedLength: number
  savedBytes: number
  moduleCount: number
  literalCount: number
  directCalls: number
  boundCalls: number
  structuralHash: string
}

export declare function shortenHtml2pdfModuleIds(source: string): {
  code: string
  report: Html2pdfShortenerReport
}

/** 仅供回归测试对变异夹具检查闭合结构；生产转换须调用带哈希门禁的入口。 */
export declare function validateHtml2pdfModuleIdClosure(source: string): {
  code: string
  report: Html2pdfShortenerReport
}
