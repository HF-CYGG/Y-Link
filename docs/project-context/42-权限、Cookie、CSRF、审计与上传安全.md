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
- 客户端鉴权：优先读取客户端 Cookie，其次兼容 Bearer，同样不支持 query token。
- `requireAdminCsrf` 仅对管理端非安全方法请求生效，且仅在 Cookie 会话来源下校验。
- `requireRole` 和 `requirePermission` 在拒绝请求时会写安全审计。
- `app.ts` 会给上传资源附加长期缓存、安全头和旧路径兼容重写逻辑。

## 关键状态/字段/快照

- 管理端鉴权上下文写入 `req.auth`。
- 客户端鉴权上下文写入 `req.clientAuth`。
- 上传兼容逻辑会把旧 `/uploads/<file>` 请求内部改写到 `products` 或 `client-feedback` 分类目录。
- 审计记录至少关心：动作类型、目标对象、操作者、请求元信息、结果状态。

## 权限与安全边界

- 角色只是兜底；大多数接口仍应以权限点为主。
- 高风险接口除了权限，还经常叠加 `admin` 角色与永久删除密码。
- Webhook、通知外发 URL、上传文件资源都应视为安全边界问题，而不是普通字符串处理。

## 常见异常与排查顺序

1. GET 正常但 POST 403：先查是否命中了 Cookie 场景的 CSRF 校验。
2. 前端显示有权限但接口 403：查后端 `requirePermission` 是否新增了权限点。
3. 历史图片 404：查旧路径兼容改写是否覆盖了该分类目录。
4. 越权访问没有审计：查中间件拒绝分支是否正确走到 `recordForbiddenAudit()`。
5. 客户端/管理端会话混淆：查使用的是哪套 Cookie 工具和哪套上下文字段。

## 验证与回归关注点

- 改权限或鉴权时回归：登录、刷新恢复、写操作、越权拦截、审计记录。
- 改上传安全时回归：新图片可访问、旧图片兼容访问、响应头正确。
- 改 CSRF 时回归：管理端写接口在 Cookie 会话下的正常提交与失败提示。
