/** 容器本地后备工具：只允许轮换指定迁移任务凭证，不接收路径、SQL、shell 或连接参数。 */
import { issueDatabaseRescueCredential } from './database-rescue-control.js'

const [action, taskId, ...extra] = process.argv.slice(2)
if (action !== 'rotate-credential' || !taskId || !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId) || extra.length) {
  console.error('用法：database-rescue-cli rotate-credential <taskId>')
  process.exitCode = 2
} else {
  try {
    const result = issueDatabaseRescueCredential(taskId)
    // CLI stdout 是操作者明确请求的唯一明文交付通道，禁止把本次输出重定向到普通应用日志。
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    console.error('救援凭证轮换失败：任务、源文件或控制状态不满足恢复条件')
    process.exitCode = 1
  }
}
