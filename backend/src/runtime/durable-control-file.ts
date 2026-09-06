/**
 * 控制文件持久化：区分缺失与损坏，单文件 fsync + 原子替换；多文件一致性由恢复日志保证。
 * 写入失败保留原文件，绝不先删正式文件再重试 rename。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type ControlFileInspection<T> =
  | { state: 'absent' }
  | { state: 'healthy'; value: T }
  | { state: 'corrupted' }

export function inspectControlFile<T>(filePath: string, validate: (value: unknown) => T | null): ControlFileInspection<T> {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) return { state: 'corrupted' }
    const value = validate(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown)
    return value === null ? { state: 'corrupted' } : { state: 'healthy', value }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'corrupted' }
  }
}

function syncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
  } catch (error) {
    // Windows 不支持对目录句柄 fsync；文件本身仍先 FlushFileBuffers 再原子 rename。
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export function writeControlFile(filePath: string, payload: unknown): void {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const tempFile = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  const fd = fs.openSync(tempFile, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // 中断遗留的随机临时文件不会作为正式状态读取；rename 失败也不清除旧状态。
  fs.renameSync(tempFile, filePath)
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600)
  syncDirectory(directory)
}

export function removeControlFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
    syncDirectory(path.dirname(filePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function appendControlAudit(filePath: string, event: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(filePath, 'a', 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
