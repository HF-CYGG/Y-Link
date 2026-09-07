# PR #49 评论与冲突修复实施计划

**目标：** 在现有 PR 工作目录合入 main 809a6df，修复未解决评审问题并验证双端兼容。
**方案：** 保留主线注册、维护与安全治理；整合 Mobile 会话、错误码和事务撤销。分文件归属并行处理后由主线验证。
**技术栈：** TypeScript、Express、TypeORM、SQLite/MySQL、现有验证脚本。

## 约束

- 不新增 worktree、依赖、Native Auth Client 或 UI 功能；不改 refresh STRICT CUR/PREV。
- 仅本地实现和验证；提交、推送、评论回复与 PR 状态变更另需明确授权。
- 使用隔离测试数据库，不修改真实业务数据，不输出凭据。

## 任务

- [x] 语义解决 package、index、认证中间件、错误类型、票据与服务冲突，保留 main 薄启动与鉴权安全边界。
- [x] 复测 Web logout 分流，确认 Mobile session 撤销且不清 Web Cookie。
- [x] 测试并修复 Mobile HTTP 429 到 42900、retryAfterSeconds 与 Retry-After 的映射，保留 Web 与维护错误数据。
- [x] 在改密回归中记录新密码 scrypt 所处事务状态，先复现锁内派生，再移到事务前；保留锁内旧密码最终验证。
- [x] 维护期 captcha GET、活动时间、后台清理接入写准入与排空，测试冻结前/后及恢复和停止。
- [x] 合并主线身份变更撤销与一次性重置票据策略，回归注册、资料、改密和重置。
- [x] 同步 62 契约版本交付状态及 42 Bearer/Cookie 说明。
- [x] 运行专项回归、backend check/build、路由与安全契约、SQLite/MySQL Mobile G-1～G-7、Web build、编码及 diff 检查；只记录本轮结果。

## 补充复核与验证记录

- 独立复核发现并修复两处合并语义缺口：认证结果与会话签发之间发生改密/身份变更时拒绝陈旧签发；Mobile SSE 事件及空闲复核按 Mobile 会话表验证。
- 新密码派生占用事务、陈旧认证签发和 Mobile SSE 误断连均先以失败用例复现，再验证修复通过。
- 10 个原始冲突均已语义整合；不使用整批 ours/theirs 覆盖。主线新增救援启动、一次性票据、身份变更撤销、安全响应数据等行为均保留。

| 验证命令 | 本轮结果与边界 |
| --- | --- |
| `npm --prefix backend run build` | 通过，最终后端 TypeScript 构建 |
| `npm --prefix backend run mobile-auth:review:verify` | 通过：Web/Mobile 改密事务、维护冻结/排空、真实 Express HTTP 边界、SQLite SSE 来源回归 |
| `npm --prefix backend run mobile-auth:contract:verify` | SQLite 通过，包含登录安全快照竞争、G-1～G-7、Web logout、重置票据与资料撤销 |
| `npm run verify:db:concurrency` | 真实 Docker MySQL 8.4.10 通过，包含新增登录竞争用例与 Mobile G-1～G-7；10 路 refresh 为 success=2 / failed=8 / generation=2，无重放误审计；隔离容器已清理 |
| `npm --prefix backend run task2:route-contract:verify` | 通过，AST 193 条路由；幂等 logout 单独验证 Bearer 读取，不放宽 Mobile 前缀 |
| `npm --prefix backend run security:auth-depth:verify` | 通过 |
| `npm --prefix backend run security:auth-sse-final:verify` | 通过，认证撤销并发及原有 Web/Admin SSE 全部场景 |
| `npm --prefix backend run write-transaction:contract:verify` | 通过 |
| `npm --prefix backend run security:hardening:verify` | 本轮通过；反向代理伪造头测试出现 express-rate-limit 警告，断言通过 |
| `npm --prefix backend run verify:mysql:schema-contract` | 本轮通过 |
| `npm --prefix backend run client-auth:registration-policy:verify` | 本轮通过 |
| `npm run build` | 通过；最终性能套件也重新执行前端构建并通过，有既有大 chunk 提示 |
| `npm run verify:performance` | 未通过：总产物 4213.91 KB > 4200 KB；在构建预算阶段退出，后续运行时性能阶段未执行，未扩大范围调整预算或前端打包 |
| `npm run verify:db:migration:timeout` | 通过，最终执行 elapsed=141ms |
| `npm run verify:db:migration` | 最终代码重建 onebox 的 success 场景通过：31 张实体表夹具、维护期 HTTP 503/code 50301、自动重启、MySQL/utf8mb4 与业务数据一致性；测试容器及临时卷已清理，未执行完整故障矩阵 |
| `npm --prefix backend run verify:db:write-freeze` | 最终代码通过，覆盖准入、事务租约、超时、worker 排空与恢复、shutdown |
| `npm run verify:text-encoding` | 通过 |
| `git diff --check` / `git diff --cached --check` | 通过；无未解决冲突 |

HTTP 回归使用真实路由和错误中间件，风控存储及撤销服务边界采用进程内替身；SSE 回归使用真实 SQLite 与可控 Response/定时器。未对生产数据库、真实 Native 设备或外部发布执行验证。没有以本地结果代替远端 CI。

提交状态：本地 merge 保持未提交；未推送、未回复/解决 GitHub review thread、未改变 PR 状态。自动审批曾拒绝附加 GitHub Actions 验证入口（超出当前请求且可能增加 CI 成本），已改用本地 npm 验证脚本，未实施该 CI 修改。

## 本轮主要修改文件与原因

- `backend/src/services/client-auth.service.ts`、`mobile-auth.service.ts`、`mobile-session.service.ts`：改密派生移出写事务、签发安全快照复核、身份变更/改密/重置跨端撤销；Mobile 维护租约与清理生命周期。
- `backend/src/middleware/client-auth.middleware.ts`、`error-handler.ts`、`backend/src/utils/errors.ts`、`backend/src/routes/mobile-auth.routes.ts`、`backend/src/services/auth-security.service.ts`、`backend/src/app.ts`：Bearer/Cookie、维护响应数据、Mobile 429 协议及限流边界整合。
- `backend/src/services/client-user-manage.service.ts`、`backend/src/utils/ephemeral-ticket-store.ts`：保留主线身份治理和一次性票据消费，整合 Mobile 撤销。
- `backend/src/services/database-maintenance-mode.service.ts`、`backend/src/index.ts`、`backend/src/runtime/business-runtime.ts`：验证码 GET 写准入、薄启动/救援启动与清理 worker 启停整合。
- `backend/src/services/customer-service-realtime.service.ts`：补齐 Mobile SSE 独立会话来源复核。
- `backend/scripts/mobile-auth-contract-verify.ts`、新增四项 Mobile review 回归脚本、路由/认证/SSE 既有回归脚本及 `backend/package.json`：为本轮问题提供可重复验证入口。
- `docs/project-context/42-权限、Cookie、CSRF、审计与上传安全.md`、`62-Mobile-Auth-Contract.md`：同步真实来源优先级、契约版本与已实现边界。

最后核对：远端 main 为 `809a6df`、PR head 仍为 `a454882`；工作目录原有 HEAD 未改变，MERGE_HEAD 为 `809a6df`。暂存区还包含从 main 正常合入的其他改动，不应将其全算成本轮评论修复新写代码。原始工作目录保持 main 且没有改动。
