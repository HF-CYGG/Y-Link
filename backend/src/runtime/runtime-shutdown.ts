/**
 * 运行时停机协调：业务服务可以请求计划重启，但不得直接 `process.exit()` 绕过
 * HTTP drain、Outbox/超时任务收口与数据源关闭。启动入口负责注册唯一处理器。
 */

export type RuntimeShutdownHandler = (reason: string, exitCode: number) => Promise<void>

let registeredHandler: RuntimeShutdownHandler | null = null

export function registerRuntimeShutdownHandler(handler: RuntimeShutdownHandler): () => void {
  registeredHandler = handler
  return () => {
    if (registeredHandler === handler) {
      registeredHandler = null
    }
  }
}

export async function requestRuntimeShutdown(reason: string, exitCode: number): Promise<void> {
  const handler = registeredHandler
  if (handler) {
    await handler(reason, exitCode)
    return
  }

  // 独立迁移脚本/专项测试没有装配 HTTP 入口时仍需结束当前进程；生产主入口
  // 总会注册上方处理器，因此正常 onebox 切库不会经过这个兜底。
  process.exit(exitCode)
}
