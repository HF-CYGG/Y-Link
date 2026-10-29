/** 仅供本批次浏览器验收：启动新建的独立 SQLite，凭据仅写任务临时目录。 */
import { createRestockTestRuntime, taskRoot } from './restock-test-runtime.js'
import path from 'node:path'

const port = Number(process.env.RESTOCK_UI_BACKEND_PORT || '5417')
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RESTOCK_UI_BACKEND_PORT 必须为1024至65535的任务独立端口')
const runtime = await createRestockTestRuntime({ fixture: true })
const listener = await runtime.listen(port)
const latestPickupAt = new Date(Math.ceil((Date.now() + 120000) / 60000) * 60000).toISOString()
await runtime.clientFeedbackService.createRestockRequest({ productId: String(runtime.products.multi.id), skuId: String(runtime.products.multiEmptySku.id), quantity: 2, latestPickupAt, clientRequestId: 'ui_short_deadline' }, runtime.otherClient.auth)
console.log(`[补货 UI fixture] ${listener.baseUrl}；隔离库 ${runtime.runtimeDir}；凭据 ${path.join(taskRoot, 'ui-fixture.json')}`)
const stop = async () => { listener.server.closeAllConnections(); await new Promise<void>((resolve) => listener.server.close(() => resolve())); await runtime.close(); process.exit(0) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
