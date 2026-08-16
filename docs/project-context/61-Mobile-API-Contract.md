# Y-Link Mobile / Web API Contract 地图

> 优先级：仓库根 `AGENTS.md` 与用户当前任务始终优先于本文。
>
> 当前边界：本文只记录 Contract Foundation 已核对的纯 TypeScript DTO 与传输无关 API modules；不代表 Mobile 已接入真实接口，也不授权实现 Native token/session、服务端购物车、下单幂等改造、库存/退货状态机、附件上传、SSE 或 UI。

## 1. 事实来源与真源边界

本轮以当前运行代码为事实来源，核对顺序为：

1. 后端 route 的 schema、method、path 和 HTTP 响应；
2. service 实际构造并返回的 DTO；
3. entity 的状态枚举、可空性和持久化字段；
4. 现有 Web API 类型与页面消费方式。

正式跨端客户端类型 package 是 `@ylink/shared-types`，源码真源位于 `packages/shared-types/src/index.ts`。`@ylink/api-client` 的 `packages/api-client/src/modules/*` 只描述 method、path、query、body 和 response type，不依赖 Vue、React、Pinia、Zustand 或 Router。

现有 Web 仍使用原来的 `src/api/http.ts`、Cookie 和 CSRF 行为。已迁移的 Web 文件只 import/re-export 共享类型，未切换请求 adapter、URL 或响应转换逻辑。

## 2. 通用响应与分页

- HTTP JSON 信封：`ApiResponse<T> = { code, message, data }`；adapter 成功时向 module 返回解包后的 `data`。
- `PaginationQueryInput`：调用方可选传 `page`、`pageSize`。
- `PaginationListResult<T>`：后端 O2O/反馈列表的 `{ page, pageSize, total, list }`。
- `PaginationResult<T>`：现有 Web 列表层的 `{ page, pageSize, total, records }`。
- Web 的 `getMyO2oPreorders()` 继续把后端 `list` 转换为 `records`，页面数据结构没有改变。

页码、总数和业务列表内容必须以后端响应为准；UI 不应根据当前数组长度推算服务端总数。

## 3. Auth Contract

### 3.1 可共享类型

- `ClientAccountType`：`personal | department`。
- `ClientSafeProfile`：安全展示资料，不含密码、Cookie、token 或验证码。
- `ClientAuthSuccessResult`：`expiresAt`、`user`、`verificationChannel`、`authMode: 'cookie'`。
- `ClientAuthCapabilities`：验证码渠道、注册验证模式、找回密码开关与部门树。
- `ClientCaptchaResult`、验证码发送输入/结果、注册/登录/找回/改密/资料修改输入。
- `ClientStaffDirectoryLookupResult`：当前只存在于后端 service，尚无公开 HTTP route。

### 3.2 Profile UI 可用字段

| 字段 | UI 口径 |
| --- | --- |
| `account`、`username`、`realName` | 可直接展示；是否允许修改仍以后端能力为准 |
| `mobile`、`email` | 可展示；验证状态分别看 `mobileVerifiedAt`、`emailVerifiedAt` |
| `departmentName` | 当前后端无部门时返回空字符串 |
| `accountType`、`staffNo`、`staffVerified` | 可用于资料说明，不得据此绕过后端权限或注册校验 |
| `status` | 只展示 `enabled | disabled` 的服务端状态 |
| `lastLoginAt` | 可展示，不用于客户端自行判断会话有效性 |

### 3.3 会话边界

当前 Web 登录是 Cookie 会话，成功响应不包含 Bearer token。Native 最终如何获取、刷新、撤销和持久化会话尚未确定。`api-client` 的认证 module 不实现 refresh、session revoke 或自动 logout；401 继续由 adapter 归一化为标准 HTTP 错误，并保留 `TODO(mobile-auth)`。

不得为 `ClientStaffDirectoryLookupResult` 虚构 Mobile endpoint。验证码、找回密码 `resetToken` 和 Cookie 均不得写入日志或普通业务缓存。

## 4. Catalog / O2O Contract

### 4.1 Product UI 可用字段

| 字段 | UI 口径 |
| --- | --- |
| `id`、`productCode`、`productName` | 商品标识与展示名称 |
| `thumbnail`、`detailContent`、`tags` | 可直接展示，空值需正常降级 |
| `defaultPrice`、`originalPrice`、`discountRate`、`discountedPrice` | 展示后端返回字符串，不自行重算折扣结果 |
| `limitPerUser` | 可作为提示，不代表最终可下单数量 |
| `currentStock`、`preOrderedStock`、`availableStock`、`soldQty` | 可展示服务端快照，不作为提交成功保证 |
| `o2oRecommended` | 可作为推荐标记 |
| `skus` | 当前服务端必返数组；无规格时为空数组 |

### 4.2 SKU UI 可用字段

| 字段 | UI 口径 |
| --- | --- |
| `id`、`productId`、`skuCode` | SKU 标识 |
| `specValues`、`specText` | 可直接展示规格，不从文本反推业务字段 |
| 四个价格字段 | 展示后端结果，不在 UI 重算最终成交价 |
| 三个库存字段 | 展示服务端快照，不承诺预占成功 |
| `isActive`、`isCurrent` | 控制当前可选状态时仍需以后端提交校验为准 |
| `thumbnail`、`sortOrder`、`o2oRecommended` | 展示与排序辅助字段 |

`O2oMallStorefrontConfig` 的 `businessHoursText`、`mallAnnouncementText` 均可展示，但不应被解释为库存、核销或履约承诺。

## 5. Order Contract

### 5.1 状态

- `O2oOrderStatus`：`pending | verified | cancelled`。
- `O2oOrderBusinessStatus`：服务端业务处理状态集合；UI 不得从核销状态自行推导。
- `statusReport`：后端输出 `scenario`、`cancelReason`、`timeoutReached`、`timeoutSoon`，用于稳定展示“待核销、临近超时、手动撤回、超时取消、已核销”等语义。

UI 应优先展示 `statusReport`，不要仅根据本机时间和 `status` 重建取消原因或最终状态。

### 5.2 Summary UI 可用字段

- 订单标识：`id`、`showNo`、`customerOrderShowNo`、`verifyCode`；
- 状态：`status`、`businessStatus`、`statusReport`；
- 金额/数量：`totalAmount`、`totalQty`、`expireInSeconds`；
- 归属快照：`clientOrderType`、`departmentNameSnapshot`、`staffNoSnapshot`；
- 履约信息：`timeoutAt`、`hasCustomerOrder`、`isSystemApplied`、`merchantMessage`；
- 售后摘要：`returnRequestCount`、`pendingReturnRequestCount`、`latestReturnRequest`；
- 创建时间：`createdAt`。

### 5.3 Detail / Item UI 可用字段

- `O2oPreorderDetail.order`：完整订单头、改单次数、取货联系人、备注、核销时间等；
- `customerProfile`：订单所属客户端资料快照；
- `items`：商品/SKU 快照、`unitPrice`、`lineAmount`、`subTotal`、`qty`、`returnedQty`、`availableReturnQty`；
- `amountSummary`：`totalAmount`、`totalQty`、`totalItemCount`；
- `returnRequests`：服务端返回的退货申请详情；
- `storefront`、`qrPayload`：门店展示信息与服务端二维码载荷。

`totalAmount`、`unitPrice`、`lineAmount`、`subTotal`、`amountSummary` 当前均为服务端必返。UI 可做纯展示格式化，但不得替换服务端金额结算。

## 6. Return Contract

- `O2oReturnRequestStatus`：`pending | verified | rejected`。
- `O2oReturnRequestDetail`：申请号、核销码、状态、来源订单状态、原因、总数量、处理/核销/拒绝信息、二维码载荷和明细。
- `O2oReturnRequestItem`：商品/SKU 标识与快照、申请数量。

UI 可展示 `status`、`reason`、`rejectedReason`、`totalQty` 和 item `qty`。最终可退数量必须使用订单明细的 `availableReturnQty` 并在提交后接受服务端再次校验；不得用 `qty - returnedQty` 作为最终业务结论。

## 7. Feedback Contract

共享类型记录的是后端原始客户端 JSON DTO，而不是现有 Web 为页面映射出的 UI model。当前 module 覆盖：

- portal config；
- 我的会话列表；
- 创建会话；
- 会话详情；
- 追加消息；
- 确认已解决；
- 撤回；
- 满意度提交。

附件上传与 SSE 本轮不纳入 `api-client`：Native 文件体表示、上传生命周期、流式连接和重连策略仍需单独设计。`internal_note` 虽属于后端消息枚举，但客户端 UI 不得自行创建或展示内部备注；必须遵守服务端返回与可见性过滤。

## 8. API Module Map

| Module | Method / Path | Body / Query | Response |
| --- | --- | --- | --- |
| `client-auth` | `GET /client-auth/captcha` | - | `ClientCaptchaResult` |
| `client-auth` | `GET /client-auth/capabilities` | - | `ClientAuthCapabilities` |
| `client-auth` | `POST /client-auth/verification-code/send` | `ClientVerificationCodeSendInput` | `ClientVerificationCodeSendResult` |
| `client-auth` | `POST /client-auth/register` | `ClientRegisterInput` | `ClientRegisterResult` |
| `client-auth` | `POST /client-auth/login` | `ClientLoginInput` | `ClientAuthSuccessResult` |
| `client-auth` | `POST /client-auth/forgot-password/verify` | `ClientForgotPasswordVerifyInput` | `ClientForgotPasswordVerifyResult` |
| `client-auth` | `POST /client-auth/forgot-password/reset` | `ClientResetPasswordInput` | `boolean` |
| `client-auth` | `GET /client-auth/me` | - | `ClientSafeProfile` |
| `client-auth` | `POST /client-auth/logout` | - | `boolean` |
| `client-auth` | `POST /client-auth/change-password` | `ClientChangePasswordInput` | `boolean` |
| `client-auth` | `PATCH /client-auth/profile` | `ClientUpdateProfileInput` | `ClientSafeProfile` |
| `client-auth` | `POST /client-auth/profile/verification-code/send` | `ClientProfileVerificationCodeSendInput` | `ClientProfileVerificationCodeSendResult` |
| `catalog` | `GET /o2o/mall/products` | - | `O2oMallProductsResult` |
| `catalog` | `GET /o2o/mall/storefront` | - | `O2oMallStorefrontConfig` |
| `orders` | `GET /o2o/mall/preorders` | `O2oMyOrderListQuery` | `O2oMyOrderListResult` |
| `orders` | `POST /o2o/mall/preorders` | `SubmitO2oPreorderPayload` | `O2oPreorderDetail` |
| `orders` | `GET /o2o/mall/preorders/:id` | - | `O2oPreorderDetail` |
| `orders` | `GET /o2o/mall/preorders/:id/summary` | - | `O2oPreorderSummary` |
| `orders` | `POST /o2o/mall/preorders/:id/customer-order-print` | - | `O2oPreorderDetail` |
| `orders` | `POST /o2o/mall/preorders/:id/cancel` | - | `O2oPreorderDetail` |
| `orders` | `PATCH /o2o/mall/preorders/:id` | `UpdateMyO2oPreorderPayload` | `O2oPreorderDetail` |
| `orders` | `POST /o2o/mall/preorders/:id/returns` | `SubmitO2oReturnRequestPayload` | `O2oReturnRequestDetail` |
| `feedback` | `GET /client-feedback/portal-config` | - | `ClientFeedbackPortalConfig` |
| `feedback` | `GET /client-feedback/conversations` | `ClientFeedbackListQuery` | `ClientFeedbackListResult` |
| `feedback` | `POST /client-feedback/conversations` | `CreateClientFeedbackConversationInput` | `ClientFeedbackConversationMutationResult` |
| `feedback` | `GET /client-feedback/conversations/:id` | - | `ClientFeedbackConversationDetail` |
| `feedback` | `POST /client-feedback/conversations/:id/messages` | `AppendClientFeedbackMessageInput` | `ClientFeedbackConversationMutationResult` |
| `feedback` | `PATCH /client-feedback/conversations/:id/confirm-resolved` | - | `ClientFeedbackConversationCloseResult` |
| `feedback` | `PATCH /client-feedback/conversations/:id/withdraw` | - | `ClientFeedbackConversationCloseResult` |
| `feedback` | `POST /client-feedback/conversations/:id/satisfaction` | `SubmitClientFeedbackSatisfactionInput` | `ClientFeedbackSatisfactionResult` |

`cart.ts` 只保留 `not-designed` placeholder。当前 Web Pinia 购物车是客户端本地状态，不是服务端购物车 Contract。

## 9. Adapter 安全边界

- 实际文件保持 `native-fetch-adapter.ts` 与 `web-adapter.ts` 两个独立入口；
- Native 只接受相对 API path，并校验最终 URL 不跨 origin；
- 默认超时 15 秒，主动取消与超时分别归一化为 `aborted`、`timeout`；
- `Idempotency-Key` 只有调用方显式提供时才发送，orders module 不从 `clientRequestId` 自动生成请求头；
- token 只允许通过 `getAccessToken` 回调注入，不持久化、不打印；Native adapter 会丢弃业务 module 传入的任意大小写 `Authorization` header；
- 401 不刷新、不重放、不执行 logout/session revoke；
- Web adapter 只接收外部 bridge，不导入或改写 `src/api/http.ts`。

## 10. Antigravity 使用边界

Antigravity 可以把本文和 `@ylink/shared-types` 作为字段命名、可空性与展示口径参考。Mobile 已通过根 npm workspace 正式解析 `@ylink/shared-types` 与 `@ylink/api-client`，但只能使用 package 名称，不能用跨目录相对路径导入 `packages/*`。在 Native 会话方案与真实接口接入任务获批前：

- 可以基于已确认字段设计 Feature Mock 和展示组件，并从 `@ylink/shared-types` 导入纯类型；
- 不得由 UI 自行计算最终可下单数量、最终订单金额、最终退货数量或库存预占结果；
- 不得直接从页面、Store 或 mock 调用 `@ylink/api-client` 发起真实 API；
- 不得把 `authMode: 'cookie'` 当作最终 Native 登录方案；
- 不得实现服务端购物车、refresh/replay、附件上传或 SSE；
- 不得发明 staff directory HTTP route 或新的正式 DTO 字段。

共享 package 消费基础已经建立；下一步仍必须单独设计并审查 Native Auth Contract。该契约获批前不开始真实 Mobile API 接入，也不把当前 `api-client` 的可解析性解释为会话方案已经确定。
