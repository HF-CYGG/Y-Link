# Y-Link 权限、Cookie、CSRF、审计与上传安全

## 适用范围

- 适用于管理端/客户端鉴权、Cookie 与 Bearer 兼容、CSRF、越权审计、上传资源安全与历史路径兼容。
- 适用于定位“为什么 GET 可以、POST 403、为什么图片路径还能兼容旧链接”的问题。

## 最后核对来源

- `backend/src/middleware/auth.middleware.ts`
- `backend/src/middleware/client-auth.middleware.ts`
- `backend/src/app.ts`
- `backend/src/utils/admin-auth-cookie.ts`
- `backend/src/utils/client-auth-cookie.ts`
- `backend/src/services/audit.service.ts`
- `backend/src/utils/safe-network.ts`
- `backend/src/utils/http-security.ts`
- `backend/src/routes/database-rescue.routes.ts`

## 真实入口

- 管理端鉴权中间件：`auth.middleware.ts`
- 客户端鉴权中间件：`client-auth.middleware.ts`
- 上传静态资源与安全响应头：`app.ts`

## 前端链路

- 管理端和客户端前端都不应把 token 放在 URL query 中。
- 管理端在 Cookie 会话下写操作必须带可读 CSRF Cookie 对应的请求头。
- 前端权限显隐只是体验兜底，最终决定权在后端路由中间件。

## 后端链路

- 管理端鉴权：优先读取 HttpOnly Cookie，其次兼容 Bearer，不再接受 query token。
- 客户端鉴权：无 `Authorization` 时读取客户端 Cookie；只要 `Authorization` 头存在即独占认证决策，要求 Bearer 格式，Mobile access 按前缀分派，格式错误、无效或撤销均直接失败，绝不回退 Cookie。历史无前缀 Bearer 仍按 Web `client_user_session` 兼容解析；Bearer 成功时优先于同请求中的 Cookie。
- `requireAdminCsrf` 仅对管理端非安全方法请求生效，且仅在 Cookie 会话来源下校验。
- `requireRole` 和 `requirePermission` 在拒绝请求时会写安全审计。
- `app.ts` 会给上传资源附加长期缓存、安全头和旧路径兼容重写逻辑。
- 管理端与客户端图形验证码由 `captcha.service.ts` 共用生成链路：`svg-captcha` 使用包内字体绘制字符路径，`sharp` 转为 140×40 PNG，不依赖容器系统字体。答案仍由 `node:crypto` 生成；旧 `captchaSvg` 字段仅包装 PNG，不返回答案文本或字形路径。
- 图形验证码为一次性票据：首次校验无论对错都立即作废，前端答错后必须重新获取（管理端登录页已在“验证码”类错误时换新图）。
- 管理端会话除 `AUTH_TOKEN_TTL_HOURS` 绝对时效外，还有 `AUTH_SESSION_IDLE_TIMEOUT_MINUTES` 空闲超时（默认 720 分钟，0 关闭）：按 `lastAccessAt` 判定，HTTP 鉴权与客服 SSE 复核共用 `utils/admin-session-idle.ts`。标签页可见时每 60 秒心跳续期，隐藏或关闭超过时长后需重新登录。
- body-parser 解析错误（畸形 JSON、超限、编码不支持等）在 `error-handler.ts` 按 4xx 返回；兜底 500 与审计写入失败日志只记录名称/消息/堆栈或驱动错误码（`utils/safe-error-log.ts`），不得展开错误对象属性，避免原始请求体中的密码进入日志。通知外发 Worker、反馈附件清理、迁移续跑等后台任务的错误日志同样走该工具（SQL 参数可能带通知正文、客户姓名或目标库连接信息）。
- 登录失败锁定与“需要图形验证码”判定按规范账号主体计数：管理端用库中真实用户名（`authService.resolveLoginRiskSubject`），客户端 Web/Mobile 用 `uid:<用户ID>`（`clientAuthService.resolveLoginRiskSubject`），账号不存在时才退回输入原文。MySQL 常用排序规则大小写、重音、全角不敏感，按输入计数会让 `Ádmin`、全角 `ａｄｍｉｎ` 各得一份失败额度；客户端同一账号的手机号、邮箱、用户名、工号也必须共用一个桶。

## 代理、HTTPS 与救援传输边界

- Node 只通过 `Y_LINK_TRUST_PROXY` 信任明确的直接反向代理 IP/CIDR；Nginx 边缘层另以 `Y_LINK_TRUSTED_EDGE_PROXIES` 限定可影响 `X-Forwarded-Proto` 的上游地址。两者不是“信任全部内网”的开关。
- 管理端与客户端会话 Cookie 都是 `HttpOnly + SameSite=Lax`；对应 CSRF Cookie 可读、同为 `SameSite=Lax`，写请求必须附带相应 CSRF 头。Cookie 的 `Secure` 由可信 HTTPS 请求判定，或由 `Y_LINK_FORCE_SECURE_COOKIES=true` 强制开启。
- 局域网纯 HTTP 可在不强制 Secure Cookie 的部署中兼容普通登录和业务操作，但不能伪造 HTTPS。救援凭证签发和 `/api/database-rescue` 只接受可信 HTTPS，或没有任何转发头的真实容器/主机 loopback 连接。
- 因此，外部 HTTP 即便被 Nginx 转到 `127.0.0.1`，也不属于“本机救援”。该边界防止外部请求借 loopback 代理获得救援能力。
- 生产 HTTPS 请求才会按 `Y_LINK_HSTS_MAX_AGE_SECONDS` 写 HSTS；普通局域网 HTTP 不会因伪造转发头获得 HSTS。

## 关键状态/字段/快照

- 管理端鉴权上下文写入 `req.auth`。
- 客户端鉴权上下文写入 `req.clientAuth`。
- 上传兼容逻辑会把旧 `/uploads/<file>` 请求内部改写到 `products` 或 `client-feedback` 分类目录。
- 审计记录至少关心：动作类型、目标对象、操作者、请求元信息、结果状态。
- 审计业务类别由 `backend/src/constants/audit-action-catalog.ts` 统一维护：登录与认证、订单与出库、入库与供货、商品与库存、客服与消息、通知中心、用户与权限、系统配置、数据维护与数据库、其他。归类先查精确动作目录再按前缀匹配，未命中归入“其他”；类别筛选在 SQL 中翻译为精确 `IN` 与前缀 `LIKE ... ESCAPE '!'` 组合，列表与导出共用 `buildListQuery()`。`GET /api/audit-logs/filter-options`（`audit_logs:view + admin`）下发“类别 → 操作类型”、目标对象中文名与通知事件筛选项。每个业务类别在目录中声明重要程度 `level`（`critical` 高风险：用户与权限、数据维护与数据库；`high` 重要：登录与认证、系统配置；`normal` 常规业务：订单与出库、入库与供货、商品与库存；`low` 一般：客服与消息、通知中心、其他），随列表记录 `categoryLevel` 与筛选项下发，前端 `src/views/system/category-importance.ts` 映射为红/橙/主色/灰标签并展示图例。
- 操作日志未选择业务类别与操作类型时，默认排除 `notification.rule.matched`、`notification.external.dispatch`、`notification.event.process` 三类通知内部处理记录（导出同口径，数据不删不改）；选择“通知中心”或具体动作时仍可完整查询，按事件聚合的视图见审计日志页“通知事件”页签。

## 权限与安全边界

- 角色只是兜底；大多数接口仍应以权限点为主。
- 高风险接口除了权限，还经常叠加 `admin` 角色与永久删除密码。
- 供货方删除本人已入库送货单沿用 `inbound:create` 与供应商所有权校验，并叠加 Cookie CSRF、送货单号、永久删除密码和账号维度频控；服务层会再次校验密码，不能只依赖路由。
- 已入库删除的成功审计与库存冲销同事务提交；业务拒绝在回滚后独立记录失败原因，频控拒绝也留痕，任何审计详情都不得记录提交密码或配置密码。
- 两类账号注销/恢复仅允许 `users:deactivate + admin`，永久删除仅允许 `users:permanent_delete + admin`。永久删除密码只在服务层以固定长度摘要做恒定时间比较；错误密码、逐字账号确认失败、业务阻断和频控拒绝均写脱敏失败审计，日志、审计与事件不得出现密码、Token 或 Cookie。
- 使用 `AuthUserContext` 的公开管理端数据库写事务都必须先通过 `lockActiveSysAccountForBusiness()` 锁定并复核操作账号，再按稳定顺序锁目标账号、配置、业务单、商品、SKU 等业务对象；当前覆盖账号与客户端账号治理、本人改密、教职工目录、系统配置和统一邀请码、JSON 导入导出、标签、通知已读，以及订单、入库、O2O、商品/SKU/库存、客服和通知规则写链路。即使 HTTP 方法或服务方法名表现为读取，只要会写已读状态、审计或其它持久状态，也必须遵守同一锁序；客服详情的已读更新与 JSON 导出审计均属于该范围。注销/永久删除与已进入服务层的旧请求因此共享“账号 → 业务对象”锁序，账号状态提交后旧请求不得继续落库；供应方同样属于 `SysUser`，路由必须把已认证的真实 `auth` 透传到服务层，不能只信任路由鉴权时的旧快照。涉及外部网络的验证码/通知测试发送、纯文件上传与备份不应为复用本契约而持有数据库账号锁跨慢操作，需分别在其既有权限、审计和安全边界内治理。
- 公开 GET 默认保持纯读：系统配置的订单流水、O2O、客服、验证码与客户端部门读取，以及通知规则列表都不得在缺配置时惰性插入或升级数据；默认补齐和历史默认升级由启动初始化或显式写事务负责。缺配置时系统配置读取明确报错，通知规则列表可返回不落库的内存默认视图。
- Webhook、通知外发 URL、上传文件资源都应视为安全边界问题，而不是普通字符串处理。
- 验证码与通知邮件网关模板统一经 `utils/provider-template.ts` 渲染：按请求头 `Content-Type` 对替换值做 JSON 转义或 URL 编码，占位符一次性替换不二次展开；客服消息摘要、显示名等客户可控内容不能直接拼入请求体。验证码邮箱目标额外拒绝双引号、反斜杠、尖括号与控制字符。
- 全局永久删除口令在所有入口都必须限速：系统账号/客户端账号/供货方已入库删除沿用原限流器，供货方永久删除、O2O 订单删除与批量清理、出库单永久删除使用 `utils/permanent-delete-guard.ts` 的账号级限流（5 分钟 5 次）与脱敏失败审计。供货方永久删除在服务层先校验归属、状态与确认单号，再核对口令，避免成为全局口令的试错预言机。
- 客户端业务写接口（反馈新建/追加消息、预订单提交/撤单）经 `authSecurityService.guardClientBusinessWrite` 按客户端账号限频，超限 429 并写 `client.auth.guard.business_write` 审计，防止刷量淹没站内信与飞书/邮件外发。
- 管理员不能通过 `PUT /api/users/:id` 修改本人密码，必须走校验旧密码的 `/api/auth/change-password`。
- 所有手机/邮箱发码入口（注册/找回、已登录资料改绑、补认证）共用 `guardVerificationCodeSendRequest`：每 IP 8 次/10 分钟、每目标 5 次/10 分钟，另有每目标 10 次/24 小时上限，防止已登录账号绕开图形验证码对任意号码持续短信轰炸。资料改绑发码的目标由用户任填，额外有每账号 10 次/24 小时上限（`guardClientProfileVerificationSend`），防止单账号轮换号码刷短信费。
- multipart 上传依赖 `multer` 必须不低于 2.3.0（2.2.0 存在中断上传泄漏文件句柄、构造字段名/数组下标导致解析拒绝服务等公开漏洞，反馈附件上传对所有客户账号开放）。所有 multer 实例显式限制 `files/fields/parts`，图片上传另限单字段 1KB；商品 YZ 导入的 `resolutions` 字段沿用默认 1MB。
- 反馈附件上传的账号级频控（默认 20 次/10 分钟）在 multer 接收文件之前计次，失败的上传同样消耗额度，避免单个账号用校验失败的大图反复占满全局图片处理队列；`createClientAttachment` 不再重复计次。
- 前端 `resolveFeedbackAttachmentUrl` 只输出 http/https 地址，`javascript:`、`data:` 等协议视为无效附件地址，不依赖服务端附件地址白名单兜底。
- 救援 Bearer 不复用管理端或客户端会话，响应始终 `no-store`，并按来源做一分钟窗口限流。救援 API 不接受 SQL、文件路径、数据库连接参数或普通 Cookie 登录态。

## 常见异常与排查顺序

1. GET 正常但 POST 403：先查是否命中了 Cookie 场景的 CSRF 校验。
2. 前端显示有权限但接口 403：查后端 `requirePermission` 是否新增了权限点。
3. 历史图片 404：查旧路径兼容改写是否覆盖了该分类目录。
4. 越权访问没有审计：查中间件拒绝分支是否正确走到 `recordForbiddenAudit()`。
5. 客户端/管理端会话混淆：查使用的是哪套 Cookie 工具和哪套上下文字段。

## 验证与回归关注点

- 改权限或鉴权时回归：登录、刷新恢复、写操作、越权拦截、审计记录。
- 新增审计动作或调整审计类别后运行 `npm --prefix backend run audit:catalog:verify`：扫描源码中全部 `actionType` 必须已登记类别与中文名，并验证类别筛选、“其他”兜底、默认隐藏、组合筛选与导出口径一致。
- 改上传安全时回归：新图片可访问、旧图片兼容访问、响应头正确。
- 改 CSRF 时回归：管理端写接口在 Cookie 会话下的正常提交与失败提示。
- 改图形验证码时执行 `npm --prefix backend run captcha:rendering:verify`，覆盖无系统字体的真实 PNG 渲染、兼容字段、作用域隔离和一次性校验。
- 升级 `multer`、`sharp` 等上传链路依赖后执行 `npm --prefix backend audit --omit=dev`，并回归 `task4:upload-security:verify` 与 `feedback:customer-service:verify`。
