/**
 * 模块说明：本批验收的临时SQLite路径适配。
 * 文件职责：显式任务英文根存在时，为每个脚本/进程返回独占子目录；未提供时保留原脚本默认路径。
 * 维护说明：不修改工作目录、连接配置或业务库；不删除任何目录，不绕过原脚本的环境/清理门禁。
 */
import path from 'node:path'
export function resolveIssueVerificationRoot(fallback: string): string {
  const supplied = process.env.YLINK_ISSUES_VERIFY_ROOT
  if (!supplied) return fallback
  const base = path.resolve(supplied)
  if (!/^[\x20-\x7e]+$/.test(base) || !path.isAbsolute(supplied)) throw new Error('本任务验证根必须是英文绝对路径')
  const name = path.basename(process.argv[1] ?? 'verification').replace(/[^a-zA-Z0-9_-]/g,'-')
  return path.join(base,'backend-regressions',`${name}-${process.pid}`)
}
