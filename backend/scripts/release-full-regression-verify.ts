/**
 * 文件说明：backend/scripts/release-full-regression-verify.ts
 * 文件职责：提供发布前后端全功能 HTTP 回归验证，覆盖管理端、客户端、上传与静态读取核心链路。
 * 实现逻辑：使用独立 SQLite 运行时启动真实 Express 服务，再通过 fetch 串联鉴权、商品、预订、上传与静态访问断言。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const runtimeRoot = path.resolve(backendRoot, '.local-dev')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const uploadsRoot = path.resolve(backendRoot, 'uploads')

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `release-full-regression-${verifySeed}.sqlite`)
const adminPassword = process.env.Y_LINK_VERIFY_ADMIN_PASSWORD?.trim() || 'Release@123456'

process.env.APP_PROFILE = `release-full-regression-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

const uploadedFilePaths = new Set<string>()

function pass(message: string) {
  console.log(`✅ ${message}`)
}

function toAbsoluteUploadPath(uploadUrl: string) {
  const normalizedRelativePath = uploadUrl.replace(/^\//, '').split('/').join(path.sep)
  return path.resolve(backendRoot, normalizedRelativePath)
}

function readCaptchaCode(captchaSvg: string) {
  return captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
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
  assert.equal(response.status, 200, `${scene} HTTP 状态码异常：${response.status}`)
  assert.equal(payload.code, 0, `${scene} 业务状态码异常：${JSON.stringify(payload)}`)
  return payload.data as T extends { data: infer D } ? D : never
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[]
  }
  if (value && typeof value === 'object' && Array.isArray((value as { list?: unknown[] }).list)) {
    return (value as { list: T[] }).list
  }
  return []
}

async function main() {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.mkdirSync(sqliteRoot, { recursive: true })
  fs.mkdirSync(uploadsRoot, { recursive: true })

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
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', '回归服务端口获取失败')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const health = await expectJsonOk<{ data: { status: string } }>(
      () => fetch(`${baseUrl}/health`),
      '健康检查',
    )
    assert.equal(health.status, 'UP')
    pass('后端健康检查通过')

    const adminLogin = await expectJsonOk<{
      data: {
        token: string
        user: {
          username: string
          role: string
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
            username: 'admin',
            password: adminPassword,
          }),
        }),
      '管理端登录',
    )
    assert.equal(adminLogin.user.username, 'admin')
    assert.equal(adminLogin.user.role, 'admin')
    const adminToken = adminLogin.token
    pass('管理端登录链路通过')

    const adminProfile = await expectJsonOk<{ data: { username: string; permissions: string[] } }>(
      () =>
        fetch(`${baseUrl}/api/auth/me`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端当前用户信息读取',
    )
    assert.equal(adminProfile.username, 'admin')
    assert.ok(adminProfile.permissions.includes('products:manage'))
    pass('管理端鉴权态读取通过')

    const createdOperator = await expectJsonOk<{
      data: {
        id: string
        username: string
        role: string
        status: string
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
            username: `release_operator_${verifySeed}`,
            password: 'Operator1234',
            displayName: '发布回归操作员',
            role: 'operator',
            status: 'enabled',
          }),
        }),
      '管理端新增操作员',
    )
    assert.equal(createdOperator.role, 'operator')
    assert.equal(createdOperator.status, 'enabled')
    pass('管理端用户新增通过')

    const createdSupplier = await expectJsonOk<{
      data: {
        id: string
        username: string
        role: string
        status: string
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
            username: `release_supplier_${verifySeed}`,
            password: 'Supplier1234',
            displayName: '发布回归供货方',
            role: 'supplier',
            status: 'enabled',
          }),
        }),
      '管理端新增供货方',
    )
    assert.equal(createdSupplier.role, 'supplier')
    pass('管理端供货方新增通过')

    const adminUsers = await expectJsonOk<{
      data: {
        list: Array<{ id: string; username: string }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/users?page=1&pageSize=20&keyword=release_`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端用户列表读取',
    )
    assert.ok(adminUsers.list.some((item) => item.id === createdOperator.id))
    assert.ok(adminUsers.list.some((item) => item.id === createdSupplier.id))
    pass('管理端用户列表读取通过')

    const resetOperatorPassword = await expectJsonOk<{
      data: {
        id: string
        username: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/users/${createdOperator.id}/reset-password`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            newPassword: 'Operator5678',
          }),
        }),
      '管理端重置操作员密码',
    )
    assert.equal(resetOperatorPassword.id, createdOperator.id)
    pass('管理端重置用户密码通过')

    const disabledOperator = await expectJsonOk<{
      data: {
        id: string
        status: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/users/${createdOperator.id}/status`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'disabled',
          }),
        }),
      '管理端停用操作员',
    )
    assert.equal(disabledOperator.status, 'disabled')
    pass('管理端用户状态更新通过')

    const enabledOperator = await expectJsonOk<{
      data: {
        id: string
        status: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/users/${createdOperator.id}/status`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'enabled',
          }),
        }),
      '管理端重新启用操作员',
    )
    assert.equal(enabledOperator.status, 'enabled')
    pass('管理端用户启用恢复通过')

    /**
     * 上传链路采用真实 multipart/form-data：
     * - 既验证 `multer` 接入是否可用；
     * - 也验证返回的静态访问 URL 可被后续业务直接消费。
     */
    const uploadBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgM2PumoAAAAASUVORK5CYII=',
      'base64',
    )
    const uploadForm = new FormData()
    uploadForm.append('file', new Blob([uploadBuffer], { type: 'image/png' }), 'release-verify.png')

    const uploadResult = await expectJsonOk<{ data: { url: string } }>(
      () =>
        fetch(`${baseUrl}/api/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
          body: uploadForm,
        }),
      '管理端图片上传',
    )
    assert.match(uploadResult.url, /^\/uploads\/.+\.png$/)
    const uploadedFilePath = toAbsoluteUploadPath(uploadResult.url)
    uploadedFilePaths.add(uploadedFilePath)
    assert.ok(fs.existsSync(uploadedFilePath), '上传文件未落盘')
    pass('管理端图片上传通过')

    const uploadedFileResponse = await fetch(`${baseUrl}${uploadResult.url}`)
    const uploadedFileBody = Buffer.from(await uploadedFileResponse.arrayBuffer())
    assert.equal(uploadedFileResponse.status, 200)
    assert.equal(uploadedFileResponse.headers.get('content-type'), 'image/png')
    assert.deepEqual(uploadedFileBody, uploadBuffer)
    pass('上传后的静态资源读取通过')

    const createdProduct = await expectJsonOk<{
      data: {
        id: string
        productName: string
        thumbnail: string | null
        o2oStatus: string
        currentStock: number
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/products`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            productName: `发布回归商品-${verifySeed}`,
            pinyinAbbr: 'FBHG',
            defaultPrice: 28,
            isActive: true,
            o2oStatus: 'listed',
            currentStock: 8,
            limitPerUser: 3,
            thumbnail: uploadResult.url,
          }),
        }),
      '管理端新增商品',
    )
    assert.equal(createdProduct.productName, `发布回归商品-${verifySeed}`)
    assert.equal(createdProduct.thumbnail, uploadResult.url)
    assert.equal(createdProduct.o2oStatus, 'listed')
    assert.equal(createdProduct.currentStock, 8)
    pass('管理端商品新增通过')

    const createdTag = await expectJsonOk<{
      data: {
        id: string
        tagName: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/tags`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tagName: `发布回归标签-${verifySeed}`,
            tagCode: `REL${String(Date.now()).slice(-6)}`,
          }),
        }),
      '管理端新增标签',
    )
    assert.equal(createdTag.tagName, `发布回归标签-${verifySeed}`)
    pass('管理端标签新增通过')

    const tagList = await expectJsonOk<{ data: Array<{ id: string }> }>(
      () =>
        fetch(`${baseUrl}/api/tags`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端标签列表读取',
    )
    assert.ok(tagList.some((item) => item.id === createdTag.id))
    pass('管理端标签列表读取通过')

    const productList = await expectJsonOk<{ data: unknown }>(
      () =>
        fetch(`${baseUrl}/api/products`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端商品列表读取',
    )
    const adminProducts = asArray<{ id: string }>(productList)
    assert.ok(adminProducts.some((item) => item.id === createdProduct.id))
    pass('管理端商品列表读取通过')

    const orderSerialConfigs = await expectJsonOk<{
      data: {
        list: Array<{
          orderType: 'department' | 'walkin'
          start: number
          current: number
          width: number
        }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/system-configs/order-serial`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '系统配置订单流水读取',
    )
    const departmentSerial = orderSerialConfigs.list.find((item) => item.orderType === 'department')
    const walkinSerial = orderSerialConfigs.list.find((item) => item.orderType === 'walkin')
    assert.ok(departmentSerial && walkinSerial, '订单流水配置缺失')
    pass('系统配置订单流水读取通过')

    const updatedOrderSerialConfigs = await expectJsonOk<{
      data: {
        list: Array<{
          orderType: 'department' | 'walkin'
          start: number
          current: number
          width: number
        }>
        changed: boolean
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/system-configs/order-serial`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            department: {
              start: departmentSerial.start,
              current: departmentSerial.current + 1,
              width: departmentSerial.width,
            },
            walkin: {
              start: walkinSerial.start,
              current: walkinSerial.current,
              width: walkinSerial.width,
            },
          }),
        }),
      '系统配置订单流水更新',
    )
    assert.equal(updatedOrderSerialConfigs.changed, true)
    pass('系统配置订单流水更新通过')

    const o2oRuleConfigs = await expectJsonOk<{
      data: {
        autoCancelEnabled: boolean
        autoCancelHours: number
        limitEnabled: boolean
        limitQty: number
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/system-configs/o2o-rules`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '系统配置 O2O 规则读取',
    )
    assert.ok(Number.isInteger(o2oRuleConfigs.autoCancelHours))
    pass('系统配置 O2O 规则读取通过')

    const updatedO2oRuleConfigs = await expectJsonOk<{
      data: {
        config: {
          autoCancelEnabled: boolean
          autoCancelHours: number
          limitEnabled: boolean
          limitQty: number
        }
        changed: boolean
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/system-configs/o2o-rules`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            autoCancelEnabled: o2oRuleConfigs.autoCancelEnabled,
            autoCancelHours: Math.min(168, o2oRuleConfigs.autoCancelHours + 1),
            limitEnabled: o2oRuleConfigs.limitEnabled,
            limitQty: o2oRuleConfigs.limitQty,
          }),
        }),
      '系统配置 O2O 规则更新',
    )
    assert.equal(updatedO2oRuleConfigs.config.autoCancelHours, Math.min(168, o2oRuleConfigs.autoCancelHours + 1))
    pass('系统配置 O2O 规则更新通过')

    const verificationProviderConfigs = await expectJsonOk<{
      data: {
        mobile: {
          enabled: boolean
        }
        email: {
          enabled: boolean
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/system-configs/verification-providers`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '系统配置验证码渠道读取',
    )
    assert.equal(typeof verificationProviderConfigs.mobile.enabled, 'boolean')
    assert.equal(typeof verificationProviderConfigs.email.enabled, 'boolean')
    pass('系统配置验证码渠道读取通过')

    const clientDepartmentConfigs = await expectJsonOk<{
      data: {
        tree: Array<{ id: string; label: string; children: unknown[] }>
        options: string[]
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/system-configs/client-departments`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '系统配置客户端部门读取',
    )
    const releaseDepartmentName = `发布回归部门-${verifySeed}`
    const mergedDepartmentOptions = [...new Set([...clientDepartmentConfigs.options, releaseDepartmentName])]
    const updatedClientDepartmentConfigs = await expectJsonOk<{
      data: {
        config: {
          tree: Array<{ id: string; label: string; children: unknown[] }>
          options: string[]
        }
        changed: boolean
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/system-configs/client-departments`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            options: mergedDepartmentOptions,
          }),
        }),
      '系统配置客户端部门更新',
    )
    assert.ok(updatedClientDepartmentConfigs.config.options.includes(releaseDepartmentName))
    pass('系统配置客户端部门更新通过')

    const supplierLogin = await expectJsonOk<{
      data: {
        token: string
        user: {
          username: string
          role: string
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
            username: createdSupplier.username,
            password: 'Supplier1234',
          }),
        }),
      '供货方登录',
    )
    assert.equal(supplierLogin.user.role, 'supplier')
    const supplierToken = supplierLogin.token
    pass('供货方登录链路通过')

    const inboundOrder = await expectJsonOk<{
      data: {
        order: {
          id: string
          showNo: string
          verifyCode: string
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/inbound/supplier/submit`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${supplierToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            remark: '发布前入库回归',
            items: [{ productId: createdProduct.id, qty: 3 }],
          }),
        }),
      '供货方提交送货单',
    )
    assert.equal(inboundOrder.order.status, 'pending')
    pass('供货方送货单提交通过')

    const inboundSupplierList = await expectJsonOk<{ data: Array<{ id: string }> }>(
      () =>
        fetch(`${baseUrl}/api/inbound/supplier/list`, {
          headers: {
            Authorization: `Bearer ${supplierToken}`,
          },
        }),
      '供货方送货单列表读取',
    )
    assert.ok(inboundSupplierList.some((item) => item.id === inboundOrder.order.id))
    pass('供货方送货单列表读取通过')

    const inboundVerifyDetail = await expectJsonOk<{
      data: {
        order: {
          id: string
          showNo: string
          verifyCode: string
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/inbound/detail/${inboundOrder.order.verifyCode}`, {
          headers: {
            Authorization: `Bearer ${supplierToken}`,
          },
        }),
      '供货方按核销码读取送货单详情',
    )
    assert.equal(inboundVerifyDetail.order.id, inboundOrder.order.id)
    pass('供货方按核销码读取详情通过')

    const inboundShowNoDetail = await expectJsonOk<{
      data: {
        order: {
          id: string
          showNo: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/inbound/detail/show-no/${inboundOrder.order.showNo}`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端按送货单号读取详情',
    )
    assert.equal(inboundShowNoDetail.order.id, inboundOrder.order.id)
    pass('管理端按送货单号读取详情通过')

    const verifiedInboundOrder = await expectJsonOk<{
      data: {
        order: {
          id: string
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/inbound/admin/verify`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            verifyCode: inboundOrder.order.verifyCode,
          }),
        }),
      '管理端核销入库',
    )
    assert.equal(verifiedInboundOrder.order.status, 'verified')
    pass('管理端入库核销通过')

    const inboundAdminList = await expectJsonOk<{ data: Array<{ id: string; status: string }> }>(
      () =>
        fetch(`${baseUrl}/api/inbound/admin/list?limit=20`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端入库单列表读取',
    )
    assert.ok(inboundAdminList.some((item) => item.id === inboundOrder.order.id && item.status === 'verified'))
    pass('管理端入库单列表读取通过')

    const submittedOrder = await expectJsonOk<{
      data: {
        order: {
          id: string
          showNo: string
          totalQty: number | string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/orders/submit`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            idempotencyKey: `release-order-${verifySeed}`,
            orderType: 'walkin',
            issuerName: '发布回归管理员',
            customerName: '现场客户',
            items: [
              {
                productId: createdProduct.id,
                qty: 1,
                unitPrice: 28,
              },
            ],
          }),
        }),
      '管理端提交出库单',
    )
    assert.equal(submittedOrder.order.id.length > 0, true)
    pass('管理端出库提交通过')

    const orderList = await expectJsonOk<{
      data: {
        list: Array<{ id: string; showNo: string }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/orders?page=1&pageSize=20&keyword=${encodeURIComponent(submittedOrder.order.showNo)}`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端出库列表读取',
    )
    assert.ok(orderList.list.some((item) => item.id === submittedOrder.order.id))
    pass('管理端出库列表读取通过')

    const orderDetail = await expectJsonOk<{
      data: {
        order: {
          id: string
          showNo: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/orders/${submittedOrder.order.id}`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端出库详情读取',
    )
    assert.equal(orderDetail.order.showNo, submittedOrder.order.showNo)
    pass('管理端出库详情读取通过')

    const deletedOrder = await expectJsonOk<{
      data: {
        id: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/orders/${submittedOrder.order.id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            confirmShowNo: submittedOrder.order.showNo,
          }),
        }),
      '管理端删除出库单',
    )
    assert.equal(deletedOrder.id, submittedOrder.order.id)
    pass('管理端删除出库单通过')

    const restoredOrder = await expectJsonOk<{
      data: {
        id: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/orders/${submittedOrder.order.id}/restore`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端恢复出库单',
    )
    assert.equal(restoredOrder.id, submittedOrder.order.id)
    pass('管理端恢复出库单通过')

    const registerCaptcha = await expectJsonOk<{ data: { captchaSvg: string; captchaId: string } }>(
      () => fetch(`${baseUrl}/api/client-auth/captcha`),
      '客户端注册图形验证码获取',
    )
    const clientAccount = `13${String(Date.now()).slice(-9)}`
    const clientPassword = 'Client1234'
    const clientUsername = `回归用户${String(Date.now()).slice(-6)}`
    const clientRegister = await expectJsonOk<{
      data: {
        id: string
        mobile: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-auth/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: clientUsername,
            account: clientAccount,
            password: clientPassword,
            captchaId: registerCaptcha.captchaId,
            captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
          }),
        }),
      '客户端注册',
    )
    assert.ok(clientRegister.id)
    assert.equal(clientRegister.mobile, clientAccount)
    pass('客户端注册链路通过')

    const loginCaptcha = await expectJsonOk<{ data: { captchaSvg: string; captchaId: string } }>(
      () => fetch(`${baseUrl}/api/client-auth/captcha`),
      '客户端登录图形验证码获取',
    )
    const clientLogin = await expectJsonOk<{
      data: {
        token: string
        user: {
          mobile: string
        }
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
    assert.equal(clientLogin.user.mobile, clientAccount)
    pass('客户端登录链路通过')

    const clientProfile = await expectJsonOk<{
      data: {
        mobile: string
        realName: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-auth/me`, {
          headers: {
            Authorization: `Bearer ${clientToken}`,
          },
        }),
      '客户端当前用户信息读取',
    )
    assert.equal(clientProfile.mobile, clientAccount)
    assert.equal(clientProfile.realName, clientUsername)
    pass('客户端鉴权态读取通过')

    const mallProducts = await expectJsonOk<{ data: unknown }>(
      () => fetch(`${baseUrl}/api/o2o/mall/products`),
      '客户端商城商品读取',
    )
    const visibleProducts = asArray<{ id: string; thumbnail?: string | null }>(mallProducts)
    const mallProduct = visibleProducts.find((item) => item.id === createdProduct.id)
    assert.ok(mallProduct, '客户端商城未读取到刚创建的上架商品')
    assert.equal(mallProduct?.thumbnail ?? null, uploadResult.url)
    pass('客户端商城商品展示通过')

    const preorder = await expectJsonOk<{
      data: {
        order: {
          id: string
          showNo: string
          verifyCode: string
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/o2o/mall/preorders`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            items: [{ productId: createdProduct.id, qty: 2 }],
            remark: '发布前全功能回归',
          }),
        }),
      '客户端提交预订单',
    )
    assert.equal(preorder.order.status, 'pending')
    pass('客户端下单链路通过')

    const myOrders = await expectJsonOk<{ data: unknown }>(
      () =>
        fetch(`${baseUrl}/api/o2o/mall/preorders`, {
          headers: {
            Authorization: `Bearer ${clientToken}`,
          },
        }),
      '客户端订单列表读取',
    )
    const clientOrders = asArray<{ id: string }>(myOrders)
    assert.ok(clientOrders.some((item) => item.id === preorder.order.id))
    pass('客户端订单列表读取通过')

    const verifyDetail = await expectJsonOk<{
      data: {
        order: {
          id: string
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/o2o/verify/${preorder.order.verifyCode}`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端核销详情读取',
    )
    assert.equal(verifyDetail.order.id, preorder.order.id)
    assert.equal(verifyDetail.order.status, 'pending')
    pass('管理端核销详情读取通过')

    const consoleOrders = await expectJsonOk<{ data: unknown }>(
      () =>
        fetch(`${baseUrl}/api/o2o/orders?limit=20`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端 O2O 订单列表读取',
    )
    const consoleOrderItems = asArray<{ id: string }>(consoleOrders)
    assert.ok(consoleOrderItems.some((item) => item.id === preorder.order.id))
    pass('管理端 O2O 订单列表读取通过')

    const verifiedOrder = await expectJsonOk<{
      data: {
        order: {
          id: string
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/o2o/verify`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            verifyCode: preorder.order.verifyCode,
          }),
        }),
      '管理端核销订单',
    )
    assert.equal(verifiedOrder.order.id, preorder.order.id)
    assert.equal(verifiedOrder.order.status, 'verified')
    pass('管理端核销链路通过')

    const verifiedClientOrder = await expectJsonOk<{
      data: {
        order: {
          id: string
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/o2o/mall/preorders/${preorder.order.id}`, {
          headers: {
            Authorization: `Bearer ${clientToken}`,
          },
        }),
      '客户端订单详情回读',
    )
    assert.equal(verifiedClientOrder.order.id, preorder.order.id)
    assert.equal(verifiedClientOrder.order.status, 'verified')
    pass('客户端订单状态回读通过')

    const managedClientUsers = await expectJsonOk<{
      data: {
        list: Array<{
          id: string
          mobile: string
          status: string
        }>
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-users?page=1&pageSize=20&keyword=${clientAccount}`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端客户端用户列表读取',
    )
    const managedClientUser = managedClientUsers.list.find((item) => item.mobile === clientAccount)
    assert.ok(managedClientUser, '管理端未检索到刚注册的客户端用户')
    pass('管理端客户端用户列表读取通过')

    const updatedClientUser = await expectJsonOk<{
      data: {
        id: string
        realName: string
        departmentName: string
        status: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-users/${managedClientUser!.id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: `${clientUsername}-已治理`,
            mobile: clientAccount,
            email: `${verifySeed}@example.com`,
            departmentName: releaseDepartmentName,
            status: 'enabled',
          }),
        }),
      '管理端更新客户端用户资料',
    )
    assert.equal(updatedClientUser.departmentName, releaseDepartmentName)
    pass('管理端更新客户端用户资料通过')

    const resetClientUserPassword = await expectJsonOk<{
      data: {
        id: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-users/${managedClientUser!.id}/reset-password`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            newPassword: 'Client5678',
          }),
        }),
      '管理端重置客户端用户密码',
    )
    assert.equal(resetClientUserPassword.id, managedClientUser!.id)
    pass('管理端重置客户端用户密码通过')

    const disabledClientUser = await expectJsonOk<{
      data: {
        id: string
        status: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-users/${managedClientUser!.id}/status`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'disabled',
          }),
        }),
      '管理端停用客户端用户',
    )
    assert.equal(disabledClientUser.status, 'disabled')
    pass('管理端停用客户端用户通过')

    const enabledClientUser = await expectJsonOk<{
      data: {
        id: string
        status: string
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/client-users/${managedClientUser!.id}/status`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'enabled',
          }),
        }),
      '管理端重新启用客户端用户',
    )
    assert.equal(enabledClientUser.status, 'enabled')
    pass('管理端重新启用客户端用户通过')

    const showNoVerifyDetail = await expectJsonOk<{
      data: {
        order: {
          id: string
          showNo: string
          status: string
        }
      }
    }>(
      () =>
        fetch(`${baseUrl}/api/o2o/verify/show-no/${preorder.order.showNo}`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端按展示单号读取核销详情',
    )
    assert.equal(showNoVerifyDetail.order.id, preorder.order.id)
    assert.equal(showNoVerifyDetail.order.showNo, preorder.order.showNo)
    assert.equal(showNoVerifyDetail.order.status, 'verified')
    pass('管理端按展示单号读取订单详情通过')

    const deletedTag = await expectJsonOk<{ data: boolean }>(
      () =>
        fetch(`${baseUrl}/api/tags/${createdTag.id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        }),
      '管理端删除标签',
    )
    assert.equal(deletedTag, true)
    pass('管理端删除标签通过')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }

    for (const uploadedFilePath of uploadedFilePaths) {
      if (fs.existsSync(uploadedFilePath)) {
        fs.rmSync(uploadedFilePath, { force: true })
      }
    }

    if (fs.existsSync(sqlitePath)) {
      fs.rmSync(sqlitePath, { force: true })
    }
  }
}

try {
  await main()
  console.log('\n发布前后端全功能回归通过')
} catch (error) {
  console.error('\n发布前后端全功能回归失败')
  console.error(error)
  process.exit(1)
}
