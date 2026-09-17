/**
 * 模块说明：xlsx（zip）上传文件的解压体积防护。
 * 文件职责：在交给 exceljs 整包解压建模之前做安全预检，拒绝压缩炸弹、ZIP64、加密与条目过多的文件。
 * 实现逻辑：
 * - 定位 End of Central Directory 后遍历中央目录，按条目的本地头找到压缩数据；
 * - 对每个条目用 inflateRawSync 的 maxOutputLength 限制真实输出并累计，不信任目录里声明的解压大小；
 * - 任一条件不满足立即抛 400，不会把超大内容读进内存。
 * 维护说明：只做安全预检，不负责业务解析；上限由调用方按导入模板规模传入。
 */

import { inflateRawSync } from 'node:zlib'
import { BizError } from './errors.js'

export interface XlsxArchiveLimits {
  maxEntries: number
  maxTotalUncompressedBytes: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const EOCD_MIN_LENGTH = 22
const MAX_ZIP_COMMENT_LENGTH = 0xffff

const reject = (message: string): never => {
  throw new BizError(message, 400)
}
const rejectInvalid = (): never => reject('Excel 文件内容无法识别，请确认文件未损坏后重试')

const findEndOfCentralDirectory = (buffer: Buffer): number => {
  const lowerBound = Math.max(0, buffer.length - EOCD_MIN_LENGTH - MAX_ZIP_COMMENT_LENGTH)
  for (let offset = buffer.length - EOCD_MIN_LENGTH; offset >= lowerBound; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return rejectInvalid()
}

export function assertXlsxArchiveWithinLimits(buffer: Buffer, limits: XlsxArchiveLimits): void {
  if (buffer.length < EOCD_MIN_LENGTH) rejectInvalid()
  const tooLargeMessage = `Excel 文件解压后超过 ${Math.floor(limits.maxTotalUncompressedBytes / 1024 / 1024)}MB，请删除多余内容（如图片）后重试`
  const eocd = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) reject('不支持 ZIP64 格式的 Excel 文件')
  if (entryCount > limits.maxEntries) reject(`Excel 文件内部条目过多（${entryCount} 个），请用导入模板重新保存后上传`)
  if (directoryOffset + directorySize > eocd) rejectInvalid()

  let cursor = directoryOffset
  let totalBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) rejectInvalid()
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    cursor += 46 + nameLength + extraLength + commentLength

    if (flags & 0x1) reject('不支持加密的 Excel 文件')
    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) reject('不支持 ZIP64 格式的 Excel 文件')
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) rejectInvalid()
    // 数据长度以中央目录为准：本地头在使用数据描述符（flags bit 3）时可能记为 0。
    const dataStart = localHeaderOffset + 30 + buffer.readUInt16LE(localHeaderOffset + 26) + buffer.readUInt16LE(localHeaderOffset + 28)
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) rejectInvalid()
    const data = buffer.subarray(dataStart, dataEnd)

    let entryBytes = 0
    if (method === 0) {
      entryBytes = data.length
    } else if (method === 8) {
      const remaining = limits.maxTotalUncompressedBytes - totalBytes
      try {
        entryBytes = inflateRawSync(data, { maxOutputLength: Math.max(1, remaining) }).length
      } catch (error) {
        if (error instanceof RangeError) reject(tooLargeMessage)
        rejectInvalid()
      }
    } else {
      reject('Excel 文件使用了不支持的压缩方式')
    }
    totalBytes += entryBytes
    if (totalBytes > limits.maxTotalUncompressedBytes) reject(tooLargeMessage)
  }
}
