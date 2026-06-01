/**
 * 文件说明：backend/scripts/feedback-customer-service-verify.ts
 * 文件职责：提供反馈中心与客服工作台专项 HTTP 回归验证，覆盖客户端建单、附件上传、客服字段维护、双向回复、完成确认、满意度评价与 SSE 实时事件。
 * 实现逻辑：
 * - 使用独立 SQLite 运行时启动真实 Express 服务，避免污染开发库；
 * - 同时拉起客户端与客服端 SSE 订阅，再串联建单、附件上传、保存字段、回复、关闭与评价动作，验证事件与数据回读保持一致；
 * - 所有断言围绕“当前清单关注的核心链路”组织，避免把无关业务一起绑进反馈专项验收。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

interface SseEventRecord<T = unknown> {
  event: string
  data: T
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `feedback-customer-service-verify-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Aa1!`
const operatorPassword = `Cs_${verifySeed}_Bb2!`
const clientPassword = `Client_${verifySeed}_Cc3!`

process.env.APP_PROFILE = `feedback-customer-service-verify-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

function pass(message: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${message}`)
}

function readCaptchaCode(captchaSvg: string) {
  return captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
}

function toChineseDigits(value: string) {
  return value.replaceAll(/\d/g, (digit) => '零一二三四五六七八九'[Number(digit)] ?? '')
}

async function readJson<T>(response: Response): Promise<T> {
  const responseText = await response.text()
  try {
    return JSON.parse(responseText) as T
  } catch (error) {
    throw new Error(
      `接口返回的不是合法 JSON，status=${response.status} body=${responseText}\n解析错误：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function expectJsonOk<T>(
  request: () => Promise<Response>,
  scene: string,
): Promise<T extends { data: infer D } ? D : never> {
  const response = await request()
  const payload = await readJson<{ code?: number; message?: string; data?: unknown }>(response)
  assert.equal(response.status, 200, `${scene} HTTP 状态码异常：${response.status}，响应：${JSON.stringify(payload)}`)
  assert.equal(payload.code, 0, `${scene} 业务状态码异常：${JSON.stringify(payload)}`)
  return payload.data as T extends { data: infer D } ? D : never
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(inspect(error, { depth: 4, breakLength: 120 }))
}

function createTinyPngBlob() {
  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YlR5X0AAAAASUVORK5CYII=',
    'base64',
  )
  return new Blob([pngBuffer], { type: 'image/png' })
}

function createSseClient(url: string, scene: string) {
  const controller = new AbortController()
  const eventQueue: SseEventRecord[] = []
  let readyResolved = false
  let readyRejected = false
  let streamError: Error | null = null
  let closed = false

  let resolveReady: (() => void) | null = null
  let rejectReady: ((error: Error) => void) | null = null

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const pushEvent = (event: SseEventRecord) => {
    eventQueue.push(event)
  }

  const parseBlock = (block: string) => {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
    if (!lines.length) {
      return null
    }

    let eventName = 'message'
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith(':')) {
        continue
      }
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || 'message'
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart())
      }
    }

    if (!dataLines.length) {
      return null
    }

    const rawData = dataLines.join('\n')
    try {
      return {
        event: eventName,
        data: JSON.parse(rawData),
      } satisfies SseEventRecord
    } catch {
      return {
        event: eventName,
        data: rawData,
      } satisfies SseEventRecord
    }
  }

  void (async () => {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      })
      assert.equal(response.status, 200, `${scene} 连接失败，HTTP 状态码=${response.status}`)
      assert.ok(response.body, `${scene} 未返回可读流`)
      readyResolved = true
      resolveReady?.()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let delimiterIndex = buffer.indexOf('\n\n')
        while (delimiterIndex >= 0) {
          const block = buffer.slice(0, delimiterIndex)
          buffer = buffer.slice(delimiterIndex + 2)
          const parsed = parseBlock(block)
          if (parsed) {
            pushEvent(parsed)
          }
          delimiterIndex = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      const normalizedError = normalizeError(error)
      if (closed && normalizedError.name === 'AbortError') {
        return
      }
      if (!readyResolved && !readyRejected) {
        readyRejected = true
        rejectReady?.(normalizedError)
        return
      }
      streamError = normalizedError
    }
  })()

  return {
    async waitForEvent<T = unknown>(
      eventName: string,
      predicate: (data: T) => boolean = () => true,
      timeoutMs = 5000,
    ): Promise<T> {
      await ready
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const matchedIndex = eventQueue.findIndex((event) => event.event === eventName && predicate(event.data as T))
        if (matchedIndex >= 0) {
          const [matchedEvent] = eventQueue.splice(matchedIndex, 1)
          return matchedEvent.data as T
        }
        if (streamError) {
          throw streamError
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(`${scene} 在 ${timeoutMs}ms 内未收到事件 ${eventName}`)
    },
    close() {
      closed = true
      controller.abort()
    },
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { createApp } = await import('../src/app.js')
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()

  const app = createApp()
  const server = app.listen(0, '127.0.0.1')

  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()

    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.once('listening', () => resolve())
      })
    }

    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', '反馈专项回归服务端口获取失败')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const adminLogin = await expectJsonOk<{
      data: {
        token: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: 'admin',
            password: adminPassword,
          }),
        }),
      '管理端管理员登录',
    )
    const adminToken = adminLogin.token
    pass('管理员登录通过')

    const operator = await expectJsonOk<{
      data: {
        id: string
        username: string
        role: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: `feedback_cs_${verifySeed}`,
            password: operatorPassword,
            displayName: '反馈客服验证员',
            role: 'operator',
            status: 'enabled',
          }),
        }),
      '创建客服操作员',
    )
    assert.equal(operator.role, 'operator')
    pass('客服操作员创建通过')

    const operatorLogin = await expectJsonOk<{
      data: {
        token: string
        user: {
          permissions: string[]
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: operator.username,
            password: operatorPassword,
          }),
        }),
      '客服操作员登录',
    )
    const operatorToken = operatorLogin.token
    assert.ok(operatorLogin.user.permissions.includes('customer_service:view'))
    assert.ok(operatorLogin.user.permissions.includes('customer_service:reply'))
    pass('客服操作员权限读取通过')

    const registerCaptcha = await expectJsonOk<{ data: { captchaSvg: string; captchaId: string } }>(
      () => fetch(`${baseUrl}/api/client-auth/captcha`),
      '客户端注册图形验证码获取',
    )
    const clientAccount = `13${String(Date.now()).slice(-9)}`
    const clientUsername = `反馈用户${toChineseDigits(String(Date.now()).slice(-6))}`

    await expectJsonOk<{
      data: {
        user: {
          id: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-auth/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            accountType: 'personal',
            username: clientUsername,
            account: clientAccount,
            password: clientPassword,
            captchaId: registerCaptcha.captchaId,
            captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
          }),
        }),
      '客户端注册',
    )
    pass('客户端注册通过')

    const loginCaptcha = await expectJsonOk<{ data: { captchaSvg: string; captchaId: string } }>(
      () => fetch(`${baseUrl}/api/client-auth/captcha`),
      '客户端登录图形验证码获取',
    )
    const clientLogin = await expectJsonOk<{
      data: {
        token: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            account: clientAccount,
            password: clientPassword,
            captchaId: loginCaptcha.captchaId,
            captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
          }),
        }),
      '客户端登录',
    )
    const clientToken = clientLogin.token
    pass('客户端登录通过')

    const portalConfig = await expectJsonOk<{
      data: {
        enabled: boolean
        realtimeEnabled: boolean
        offlineFaqs: Array<{ question: string; answer: string }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-feedback/portal-config`, {
          headers: {
            Authorization: `Bearer ${clientToken}`,
          },
        }),
      '客户端反馈入口配置读取',
    )
    assert.equal(portalConfig.enabled, true)
    assert.equal(portalConfig.realtimeEnabled, true)
    assert.ok(portalConfig.offlineFaqs.length >= 1)
    pass('反馈入口与离线 FAQ 配置读取通过')

    const clientStream = createSseClient(
      `${baseUrl}/api/client-feedback/stream?access_token=${encodeURIComponent(clientToken)}`,
      '客户端反馈 SSE',
    )
    const serviceStream = createSseClient(
      `${baseUrl}/api/customer-service/stream?access_token=${encodeURIComponent(operatorToken)}`,
      '客服工作台 SSE',
    )

    const clientConnected = await clientStream.waitForEvent<{ eventType: string }>('connected')
    const serviceConnected = await serviceStream.waitForEvent<{ eventType: string; availability?: { isOnline?: boolean } }>('connected')
    assert.equal(clientConnected.eventType, 'connected')
    assert.equal(serviceConnected.eventType, 'connected')
    assert.equal(serviceConnected.availability?.isOnline, true)
    pass('客户端与客服端 SSE 建连通过')

    const servicePresence = await expectJsonOk<{
      data: {
        availability: {
          isOnline: boolean
          serviceConnectedCount: number
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/presence`, {
          headers: {
            Authorization: `Bearer ${operatorToken}`,
          },
        }),
      '客服在线状态读取',
    )
    assert.equal(servicePresence.availability.isOnline, true)
    assert.equal(servicePresence.availability.serviceConnectedCount, 1)
    pass('客服在线状态统计通过')

    const initialAttachment = await expectJsonOk<{
      data: {
        attachment: {
          name: string
          url: string
          mimeType: string | null
          size: number | null
        }
      }
    }>(
      () => {
        const formData = new FormData()
        formData.append('file', createTinyPngBlob(), 'feedback-create-proof.png')
        return fetch(`${baseUrl}/api/client-feedback/attachments`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientToken}`,
          },
          body: formData,
        })
      },
      '客户端上传建单附件',
    )
    assert.match(initialAttachment.attachment.url, /^\/uploads\//)
    assert.equal(initialAttachment.attachment.mimeType, 'image/png')
    pass('客户端上传建单附件通过')

    const createdConversation = await expectJsonOk<{
      data: {
        conversation: {
          id: string
          subject: string
          fields: {
            issueType: string
            category: string
          }
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-feedback/conversations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            issueType: 'bug',
            category: 'order',
            subject: '反馈中心专项回归问题',
            priority: 'high',
            content: '客户端首次提交反馈，用于验证客服链路。',
            expectedResult: '客服可正常受理并回传进度',
            actualResult: '当前需要专项回归验证',
            tags: ['专项回归', '反馈中心'],
            sourceLabel: '自动化专项验证',
            attachments: [initialAttachment.attachment],
          }),
        }),
      '客户端创建反馈会话',
    )
    const conversationId = createdConversation.conversation.id
    assert.ok(conversationId)
    assert.equal(createdConversation.conversation.fields.issueType, 'bug')
    await clientStream.waitForEvent<{ eventType: string; conversationId: string }>(
      'conversation',
      (event) => event.eventType === 'conversation_created' && event.conversationId === conversationId,
    )
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string }>(
      'conversation',
      (event) => event.eventType === 'conversation_created' && event.conversationId === conversationId,
    )
    pass('客户端建单与双端实时创建事件通过')

    const serviceList = await expectJsonOk<{
      data: {
        list: Array<{
          id: string
          unreadForServiceCount: number
        }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/conversations?page=1&pageSize=20`, {
          headers: {
            Authorization: `Bearer ${operatorToken}`,
          },
        }),
      '客服工作台会话列表读取',
    )
    const listedConversation = serviceList.list.find((item) => item.id === conversationId)
    assert.ok(listedConversation)
    assert.equal(listedConversation?.unreadForServiceCount, 1)
    pass('客服工作台会话列表读取通过')

    const serviceDetailBeforeEdit = await expectJsonOk<{
      data: {
        conversation: {
          id: string
          unreadForServiceCount: number
        }
        messages: Array<{
          senderType: string
          content: string
          attachments?: Array<{
            url: string
            mimeType: string | null
          }>
        }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/conversations/${conversationId}`, {
          headers: {
            Authorization: `Bearer ${operatorToken}`,
          },
        }),
      '客服工作台详情首次读取',
    )
    assert.equal(serviceDetailBeforeEdit.conversation.unreadForServiceCount, 0)
    assert.equal(serviceDetailBeforeEdit.messages.length, 1)
    await clientStream.waitForEvent<{ eventType: string; conversationId: string }>(
      'conversation',
      (event) => event.eventType === 'conversation_read_by_service' && event.conversationId === conversationId,
    )
    pass('客服详情读取与客服已读事件通过')

    const updatedFields = await expectJsonOk<{
      data: {
        changed: boolean
        conversation: {
          subject: string
          fields: {
            orderRef: string | null
            expectedResult: string
            actualResult: string
            tags: string[]
          }
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/conversations/${conversationId}/fields`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            subject: '反馈中心专项回归问题-已受理',
            priority: 'urgent',
            orderRef: 'ORDER-VERIFY-001',
            expectedResult: '客服工作台可展示完整进度',
            actualResult: '正在通过专项脚本校验字段保存',
            reproductionSteps: '1. 客户端提交反馈 2. 客服保存字段',
            contactPreference: '站内会话回复',
            tags: ['专项回归', '客服字段'],
            sourceLabel: '客服工作台专项验证',
          }),
        }),
      '客服保存 Issue 字段',
    )
    assert.equal(updatedFields.changed, true)
    assert.equal(updatedFields.conversation.fields.orderRef, 'ORDER-VERIFY-001')
    assert.ok(updatedFields.conversation.fields.tags.includes('客服字段'))
    await clientStream.waitForEvent<{ eventType: string; conversationId: string }>(
      'conversation',
      (event) => event.eventType === 'conversation_fields_updated' && event.conversationId === conversationId,
    )
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string }>(
      'conversation',
      (event) => event.eventType === 'conversation_fields_updated' && event.conversationId === conversationId,
    )
    pass('Issue 字段保存与双端实时字段事件通过')

    const updatedRemark = await expectJsonOk<{
      data: {
        changed: boolean
        internalRemark: {
          content: string
          updatedByDisplayName: string | null
        } | null
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/conversations/${conversationId}/internal-remark`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: '内部备注：当前专项回归用于验证新版标签结构下的协同链路。',
          }),
        }),
      '客服保存内部备注',
    )
    assert.equal(updatedRemark.changed, true)
    assert.match(updatedRemark.internalRemark?.content ?? '', /专项回归/)
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string }>(
      'conversation',
      (event) => event.eventType === 'conversation_internal_remark_updated' && event.conversationId === conversationId,
    )
    pass('内部备注保存与实时事件通过')

    const takeOverResult = await expectJsonOk<{
      data: {
        changed: boolean
        conversation: {
          assignedUserId: string | null
          assignedDisplayName: string | null
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/conversations/${conversationId}/assignee`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assigneeUserId: operator.id,
          }),
        }),
      '客服显式接单',
    )
    assert.equal(takeOverResult.changed, true)
    assert.equal(takeOverResult.conversation.assignedUserId, operator.id)
    assert.equal(takeOverResult.conversation.status, 'processing')
    await clientStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { assigneeAfterUserId?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'conversation_assignee_updated'
        && event.conversationId === conversationId
        && event.detail?.assigneeAfterUserId === operator.id,
    )
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { assigneeAfterUserId?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'conversation_assignee_updated'
        && event.conversationId === conversationId
        && event.detail?.assigneeAfterUserId === operator.id,
    )
    pass('显式接单与负责人实时事件通过')

    await expectJsonOk<{
      data: {
        conversation: {
          id: string
        }
        message: {
          senderType: string
          content: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: '客服回复：已收到你的问题，我们正在继续核对，请稍候查看处理进度。',
          }),
        }),
      '客服发送回复',
    )
    await clientStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { senderType?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'message_created'
        && event.conversationId === conversationId
        && event.detail?.senderType === 'service',
    )
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { senderType?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'message_created'
        && event.conversationId === conversationId
        && event.detail?.senderType === 'service',
    )
    pass('客服回复与双端实时消息事件通过')

    const clientDetailAfterReply = await expectJsonOk<{
      data: {
        conversation: {
          fields: {
            orderRef: string | null
            expectedResult: string
            actualResult: string
            tags: string[]
          }
          unreadForClientCount: number
        }
        messages: Array<{
          senderType: string
          content: string
        }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-feedback/conversations/${conversationId}`, {
          headers: {
            Authorization: `Bearer ${clientToken}`,
          },
        }),
      '客户端读取反馈详情',
    )
    assert.equal(clientDetailAfterReply.conversation.fields.orderRef, 'ORDER-VERIFY-001')
    assert.equal(clientDetailAfterReply.conversation.unreadForClientCount, 0)
    assert.ok(clientDetailAfterReply.messages.some((item) => item.senderType === 'service'))
    assert.ok(
      clientDetailAfterReply.messages.some(
        (item) => item.senderType === 'client' && Array.isArray(item.attachments) && item.attachments[0]?.url === initialAttachment.attachment.url,
      ),
    )
    assert.ok(!clientDetailAfterReply.messages.some((item) => /内部备注/.test(item.content)))
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string }>(
      'conversation',
      (event) => event.eventType === 'conversation_read_by_client' && event.conversationId === conversationId,
    )
    pass('客户端详情回读字段、首条附件、消息与客户端已读事件通过')

    const replyAttachment = await expectJsonOk<{
      data: {
        attachment: {
          name: string
          url: string
        }
      }
    }>(
      () => {
        const formData = new FormData()
        formData.append('file', createTinyPngBlob(), 'feedback-reply-proof.png')
        return fetch(`${baseUrl}/api/client-feedback/attachments`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientToken}`,
          },
          body: formData,
        })
      },
      '客户端上传补充说明附件',
    )
    assert.match(replyAttachment.attachment.url, /^\/uploads\//)
    pass('客户端上传补充说明附件通过')

    await expectJsonOk<{
      data: {
        message: {
          senderType: string
          content: string
          attachments?: Array<{
            url: string
          }>
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-feedback/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: '客户端补充：问题仍偶发出现，请继续协助排查。',
            attachments: [replyAttachment.attachment],
          }),
        }),
      '客户端补充反馈消息',
    )
    await clientStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { senderType?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'message_created'
        && event.conversationId === conversationId
        && event.detail?.senderType === 'client',
    )
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { senderType?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'message_created'
        && event.conversationId === conversationId
        && event.detail?.senderType === 'client',
    )
    pass('客户端补充消息与双端实时事件通过')

    const serviceDetailAfterClientReply = await expectJsonOk<{
      data: {
        conversation: {
          unreadForServiceCount: number
        }
        internalRemark: {
          content: string
        } | null
        messages: Array<{
          senderType: string
          content: string
          attachments?: Array<{
            url: string
          }>
        }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/conversations/${conversationId}`, {
          headers: {
            Authorization: `Bearer ${operatorToken}`,
          },
        }),
      '客服回读客户端补充后的详情',
    )
    assert.equal(serviceDetailAfterClientReply.conversation.unreadForServiceCount, 0)
    assert.match(serviceDetailAfterClientReply.internalRemark?.content ?? '', /标签结构/)
    assert.ok(serviceDetailAfterClientReply.messages.some((item) => item.senderType === 'client' && /问题仍偶发出现/.test(item.content)))
    assert.ok(
      serviceDetailAfterClientReply.messages.some(
        (item) => item.senderType === 'client' && Array.isArray(item.attachments) && item.attachments[0]?.url === replyAttachment.attachment.url,
      ),
    )
    pass('客服回读未读清零、内部备注、附件与消息链路通过')

    await expectJsonOk<{
      data: {
        changed: boolean
        conversation: {
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/customer-service/conversations/${conversationId}/status`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'resolved',
          }),
        }),
      '客服将反馈单更新为已解决',
    )
    await clientStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { status?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'conversation_status_changed'
        && event.conversationId === conversationId
        && event.detail?.status === 'resolved',
    )
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { status?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'conversation_status_changed'
        && event.conversationId === conversationId
        && event.detail?.status === 'resolved',
    )
    pass('客服更新已解决状态与双端实时事件通过')

    await expectJsonOk<{
      data: {
        changed: boolean
        conversation: {
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-feedback/conversations/${conversationId}/confirm-resolved`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${clientToken}`,
          },
        }),
      '客户端确认已解决',
    )
    await clientStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { status?: string; confirmedBy?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'conversation_status_changed'
        && event.conversationId === conversationId
        && event.detail?.status === 'closed'
        && event.detail?.confirmedBy === 'client',
    )
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { status?: string; confirmedBy?: string } }>(
      'conversation',
      (event) =>
        event.eventType === 'conversation_status_changed'
        && event.conversationId === conversationId
        && event.detail?.status === 'closed'
        && event.detail?.confirmedBy === 'client',
    )
    pass('客户端确认已解决与双端实时关闭事件通过')

    const submittedSatisfaction = await expectJsonOk<{
      data: {
        satisfaction: {
          level: string
          comment: string | null
        } | null
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-feedback/conversations/${conversationId}/satisfaction`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            level: 'satisfied',
            comment: '专项回归验证中，附件展示与处理闭环体验正常。',
          }),
        }),
      '客户端提交满意度评价',
    )
    assert.equal(submittedSatisfaction.satisfaction?.level, 'satisfied')
    await clientStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { satisfaction?: { level?: string } } }>(
      'conversation',
      (event) =>
        event.eventType === 'conversation_satisfaction_updated'
        && event.conversationId === conversationId
        && event.detail?.satisfaction?.level === 'satisfied',
    )
    await serviceStream.waitForEvent<{ eventType: string; conversationId: string; detail?: { satisfaction?: { level?: string } } }>(
      'conversation',
      (event) =>
        event.eventType === 'conversation_satisfaction_updated'
        && event.conversationId === conversationId
        && event.detail?.satisfaction?.level === 'satisfied',
    )
    pass('客户端满意度评价与双端实时事件通过')

    clientStream.close()
    serviceStream.close()
    // eslint-disable-next-line no-console
    console.log('\n反馈中心与客服工作台专项回归全部通过。')
  } finally {
    server.close()
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    if (fs.existsSync(sqlitePath)) {
      fs.rmSync(sqlitePath, { force: true })
    }
  }
}

try {
  await main()
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\n反馈中心与客服工作台专项回归失败：', error)
  process.exit(1)
}
