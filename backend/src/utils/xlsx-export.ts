import { once } from 'node:events'
import { PassThrough, Writable, type Transform } from 'node:stream'
import { finished } from 'node:stream/promises'
import type ExcelJS from 'exceljs'
import { loadExcelJs } from './exceljs-loader.js'

type WorkbookWriter = ExcelJS.stream.xlsx.WorkbookWriter
type WorkbookWithArchive = WorkbookWriter & {
  _openStream: (path: string) => PassThrough
  zip: Transform & {
    append: (content: PassThrough, entry: { name: string }) => void
    abort: () => void
    finalize: () => Promise<void>
  }
}

export function assertXlsxOutputOpen(output: Writable): void {
  if (output.destroyed || output.writableEnded) throw new Error('Excel 下载连接已关闭')
}

/**
 * 单表 XLSX 导出。ExcelJS 4.4.0 内置的工作表缓冲不传播 ZIP/网络背压。
 * 将工作表接入标准流，调用方在每批写入后等待排空，限制慢客户端造成的堆积。
 */
export async function writeStreamingXlsx<T>(
  output: Writable,
  onReady: (() => void) | undefined,
  populate: (workbook: WorkbookWriter, waitForRows: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const ExcelJS = await loadExcelJs()
  assertXlsxOutputOpen(output)
  onReady?.()
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
    useSharedStrings: false,
  }) as WorkbookWithArchive
  const archive = workbook.zip
  const aborted = new AbortController()
  const abort = (error: unknown) => {
    aborted.abort(error)
    output.destroy()
  }
  archive.on('error', abort)
  const responseDone = finished(output, { readable: false, cleanup: true })
  // 分页期间响应可能先关闭，保留失败状态给下一批与最终 ZIP 提交检查。
  void responseDone.catch(abort)

  let worksheetStream: PassThrough | undefined
  workbook._openStream = (path) => {
    const xml = new PassThrough()
    const write = xml.write.bind(xml)
    // ExcelJS 写工作表开头时传入内部 StringBuf，其余单元格写入字符串。
    xml.write = (chunk: unknown) =>
      write(typeof chunk === 'object' && chunk !== null && 'toBuffer' in chunk && typeof chunk.toBuffer === 'function'
        ? chunk.toBuffer() as Buffer
        : chunk)
    worksheetStream = xml
    archive.append(xml, { name: path })
    return xml
  }

  // ExcelJS 在内部调用 finalize() 而不等待它的 Promise，需接管异步压缩错误。
  const finalize = archive.finalize.bind(archive)
  archive.finalize = () => {
    const completion = finalize()
    void completion.catch(abort)
    return completion
  }

  const waitForRows = async () => {
    aborted.signal.throwIfAborted()
    assertXlsxOutputOpen(output)
    if (worksheetStream?.writableNeedDrain && !worksheetStream.writableEnded) {
      await once(worksheetStream, 'drain', { signal: aborted.signal })
    }
  }

  try {
    const result = await populate(workbook, waitForRows)
    await waitForRows()
    // ExcelJS commit 自身不处理响应 close。响应提前断开时结束等待，随后关闭生产流。
    await Promise.race([workbook.commit(), responseDone])
    await responseDone
    aborted.signal.throwIfAborted()
    return result
  } finally {
    if (!output.writableFinished) {
      archive.unpipe(output)
      archive.abort()
      worksheetStream?.destroy()
      archive.destroy()
      output.destroy()
      await responseDone.catch(() => undefined)
    }
  }
}

/** 保留服务层既有 Buffer 调用，HTTP 下载直接使用流。 */
export async function bufferXlsxExport(
  exportToStream: (output: Writable) => Promise<{ rowCount: number }>,
): Promise<{ buffer: Buffer; rowCount: number }> {
  const chunks: Buffer[] = []
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk)
      callback()
    },
  })
  const { rowCount } = await exportToStream(output)
  return { buffer: Buffer.concat(chunks), rowCount }
}
