import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * onebox 本地烟雾验证脚本：
 * - 不依赖 Docker/NGINX，直接用 Node 启动“后端 + 静态托管 + API 反代”；
 * - 目标是验证单端口一体化启动链路是否可用，覆盖首页、健康检查、基础 API；
 * - 运行中使用独立 SQLite 文件，避免污染默认本地数据库。
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const backendRoot = path.join(projectRoot, 'backend')
const frontendDistRoot = path.join(projectRoot, 'dist')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const sqliteRoot = path.join(backendRoot, 'data', 'local-dev')
const sqliteFilePath = path.join(sqliteRoot, 'y-link.onebox-smoke.sqlite')

const backendPort = Number(process.env.Y_LINK_ONEBOX_BACKEND_PORT ?? 3310)
const oneboxPort = Number(process.env.Y_LINK_ONEBOX_PORT ?? 18080)
const backendBaseUrl = `http://127.0.0.1:${backendPort}`
const oneboxBaseUrl = `http://127.0.0.1:${oneboxPort}`

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

const log = (message) => {
  console.log(`[onebox-smoke] ${message}`)
}

const toSafePathname = (pathname) => {
  const normalized = path.posix.normalize(pathname)
  if (normalized.includes('..')) {
    return '/'
  }

  return normalized
}

const readRequestBody = async (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })

const waitForHttpReady = async ({ url, expectedStatus = 200, retries = 80, intervalMs = 500 }) => {
  for (let index = 0; index < retries; index += 1) {
    try {
      const response = await fetch(url)
      if (response.status === expectedStatus) {
        return
      }
    } catch {
      // 启动阶段允许重试，超时后统一抛错。
    }
    await delay(intervalMs)
  }

  throw new Error(`等待服务就绪超时：${url}`)
}

const proxyRequest = async ({ request, response }) => {
  const requestUrl = new URL(request.url ?? '/', backendBaseUrl)
  const requestBody = await readRequestBody(request)

  const upstreamResponse = await fetch(requestUrl, {
    method: request.method ?? 'GET',
    headers: request.headers,
    body: requestBody.length > 0 ? requestBody : undefined,
  })

  response.statusCode = upstreamResponse.status
  upstreamResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') {
      return
    }
    response.setHeader(key, value)
  })

  const buffer = Buffer.from(await upstreamResponse.arrayBuffer())
  response.end(buffer)
}

const serveStatic = ({ request, response }) => {
  const requestUrl = new URL(request.url ?? '/', oneboxBaseUrl)
  const pathname = toSafePathname(requestUrl.pathname)
  const rawFilePath = pathname === '/' ? '/index.html' : pathname
  const resolvedFilePath = path.resolve(frontendDistRoot, `.${rawFilePath}`)
  const resolvedRoot = path.resolve(frontendDistRoot)

  if (!resolvedFilePath.startsWith(resolvedRoot)) {
    response.statusCode = 403
    response.end('forbidden')
    return
  }

  const fallbackFilePath = path.join(frontendDistRoot, 'index.html')
  const selectedFilePath = fs.existsSync(resolvedFilePath) && fs.statSync(resolvedFilePath).isFile()
    ? resolvedFilePath
    : fallbackFilePath

  const extName = path.extname(selectedFilePath).toLowerCase()
  response.statusCode = 200
  response.setHeader('Content-Type', mimeTypes[extName] ?? 'application/octet-stream')
  response.end(fs.readFileSync(selectedFilePath))
}

const createOneboxLikeServer = () =>
  http.createServer(async (request, response) => {
    try {
      const url = request.url ?? '/'
      if (url.startsWith('/api/') || url === '/health') {
        await proxyRequest({ request, response })
        return
      }

      serveStatic({ request, response })
    } catch (error) {
      response.statusCode = 502
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(
        JSON.stringify(
          {
            code: 502,
            message: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      )
    }
  })

const killChildProcess = async (child) => {
  if (!child || child.exitCode !== null) {
    return
  }

  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2500),
  ])

  if (child.exitCode === null) {
    child.kill('SIGKILL')
  }
}

const verifyOneboxEndpoints = async () => {
  const homepageResponse = await fetch(oneboxBaseUrl)
  const homepageText = await homepageResponse.text()
  if (!homepageResponse.ok || !homepageText.includes('<div id="app"></div>')) {
    throw new Error('onebox 首页返回异常，未命中前端静态入口')
  }

  const healthResponse = await fetch(`${oneboxBaseUrl}/health`)
  const healthJson = await healthResponse.json()
  if (!healthResponse.ok || healthJson?.data?.status !== 'UP') {
    throw new Error('onebox /health 反代结果异常')
  }

  const loginResponse = await fetch(`${oneboxBaseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: 'admin',
      password: 'Admin@123456',
    }),
  })
  const loginJson = await loginResponse.json()
  const token = loginJson?.data?.token
  if (!loginResponse.ok || typeof token !== 'string' || token.length === 0) {
    throw new Error('onebox 登录链路异常')
  }

  const productResponse = await fetch(`${oneboxBaseUrl}/api/products?page=1&pageSize=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  const productJson = await productResponse.json()
  const isProductPayloadValid =
    Array.isArray(productJson?.data)
    || Array.isArray(productJson?.data?.list)
  if (!productResponse.ok || productJson?.code !== 0 || !isProductPayloadValid) {
    throw new Error('onebox /api/products 反代结果异常')
  }
}

const run = async () => {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const backendStdoutPath = path.join(runtimeRoot, 'onebox-smoke-backend.log')
  const backendStderrPath = path.join(runtimeRoot, 'onebox-smoke-backend.error.log')
  const backendStdout = fs.openSync(backendStdoutPath, 'w')
  const backendStderr = fs.openSync(backendStderrPath, 'w')

  const backendProcess = spawn(process.execPath, ['dist/index.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_PROFILE: 'onebox-smoke',
      PORT: String(backendPort),
      DB_TYPE: 'sqlite',
      SQLITE_DB_PATH: sqliteFilePath,
      DB_SYNC: 'false',
    },
    stdio: ['ignore', backendStdout, backendStderr],
    shell: false,
    windowsHide: true,
  })

  let oneboxServer
  try {
    await waitForHttpReady({ url: `${backendBaseUrl}/health` })
    log(`后端已就绪：${backendBaseUrl}`)

    oneboxServer = createOneboxLikeServer()
    await new Promise((resolve, reject) => {
      oneboxServer.once('error', reject)
      oneboxServer.listen(oneboxPort, '127.0.0.1', resolve)
    })
    log(`本地 onebox 网关已启动：${oneboxBaseUrl}`)

    await verifyOneboxEndpoints()
    log('首页 + 健康检查 + 产品接口验证通过')
  } finally {
    if (oneboxServer) {
      await new Promise((resolve) => oneboxServer.close(resolve))
    }
    await killChildProcess(backendProcess)
    fs.closeSync(backendStdout)
    fs.closeSync(backendStderr)
  }
}

try {
  await run()
  log('本地 onebox 烟雾验证通过')
} catch (error) {
  console.error('\n[onebox-smoke] 验证失败：', error)
  process.exit(1)
}
