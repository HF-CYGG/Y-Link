# Web 安全加固与数据库救援操作

## 适用范围与当前交付状态

本文面向 Y-Link Web/onebox 的部署人员和具备管理员权限的值守人员，说明可信代理、HTTPS Cookie、独立救援页和 SQLite 自动迁移回退的操作边界。

当前安全加固工作位于普通分支 `codex/web-security-hardening`。本轮文档没有创建修复提交，不表示已合入、已发布或所有验证均已完成。本文只描述当前实现和已获得的验证证据。

不要在工单、日志、截图或本文档中写入真实密码、Bearer 凭证、数据库密码、验证码或 Token。

## 部署前的代理与 Cookie 配置

| 变量 | 真实作用 | 配置边界 |
| --- | --- | --- |
| `Y_LINK_TRUST_PROXY` | Node/Express 信任的直接反向代理地址，用于安全识别 `X-Forwarded-*`。 | 只接受逗号分隔的明确 IP/CIDR。禁止 `true`、代理跳数、`0.0.0.0/0` 和 `::/0`。onebox 默认是 `127.0.0.1,::1`；分体部署应填写实际前端代理地址。 |
| `Y_LINK_TRUSTED_EDGE_PROXIES` | Nginx 信任可传入原始 `X-Forwarded-Proto` 的上游 TLS 终止边缘。 | 只填真实边缘 IP/CIDR。未列入地址的协议头会被忽略，不能由客户端伪造 HTTPS。 |
| `Y_LINK_FORCE_SECURE_COOKIES` | 强制管理端和客户端 Cookie 带 `Secure`。 | 对公网 HTTPS 可设为 `true`；若依赖可信代理协议识别，也必须正确配置前两项。局域网纯 HTTP 保持 `false`。 |
| `Y_LINK_HSTS_MAX_AGE_SECONDS` | HTTPS 响应的 HSTS 时长。 | 仅生产环境且请求实际被识别为 HTTPS 时写入；可填 `0` 到 `63072000` 的整数。 |
| `Y_LINK_AUTOMATIC_DB_MIGRATION_ENABLED` | 是否允许创建自动 SQLite -> MySQL 迁移任务。 | 普通分体后端默认关闭；具备退出码 `75` 重启守护的 onebox 默认开启。 |
| `Y_LINK_DATA_DIR` | 迁移任务、快照、维护状态、runtime override、cutover marker 和救援控制文件根目录。 | onebox 固定在持久化卷 `/app/data`；不能放进容器临时层。 |

管理端与客户端会话 Cookie 都是 `HttpOnly + SameSite=Lax`，CSRF Cookie 可读并要求随写请求的 CSRF 请求头提交。普通浏览器会话不再从 URL query 读取访问 Token。

## HTTP、HTTPS 与救援能力

局域网 HTTP 可以兼容日常登录、Cookie 会话、查询和受权限保护的业务操作。它不是救援传输通道：

- 自动迁移任务可在普通管理端权限与 CSRF 门禁下创建，但局域网 HTTP 响应不返回明文救援凭证。
- 救援页面 API 只接受可信 HTTPS，或没有任何 `Forwarded`/`X-Forwarded-*`/`X-Real-IP` 头的真实容器或主机 loopback 连接。
- 外部 HTTP 即使通过 Nginx 反代到 `127.0.0.1`，仍是转发请求，不能借此取得本机救援权限。
- 救援接口的响应一律 `Cache-Control: no-store`，不使用普通管理员 Cookie，且按来源做一分钟窗口限流。

公网部署必须由真实 TLS 终止边缘处理 HTTPS，并通过 `Y_LINK_TRUSTED_EDGE_PROXIES` 与 `Y_LINK_TRUST_PROXY` 把“谁可以声明协议”限制到实际代理链路。不要把整个 Docker 私网、整个 RFC1918 网段或公网地址段列为可信代理。

## 独立救援入口

前端构建有独立的 `rescue.html` 入口；Nginx 将 `/database-rescue` 映射到该页面并添加 `no-store`。救援页面不加载普通 App、路由、Store 或业务 HTTP 模块，只使用 `/api/database-rescue`。

后端正常启动失败时，`backend/src/index.ts` 只启用最小救援控制面：

- `GET /health` 返回 HTTP `503`、`status=RESCUE` 和脱敏恢复原因；
- 普通业务路由统一返回维护响应；
- 救援控制面不创建账号、会话、业务表、上传服务或后台 Worker；
- 正常状态的 `/health` 只返回 `status` 和公开 `maintenance`，不暴露数据库拓扑、运行时覆盖、队列或连接池细节。

## 凭证签发与保管

救援凭证绑定单一自动迁移任务，格式和有效性由后端校验。使用规则如下：

1. 明文只会在一次签发/轮换 HTTP 响应中返回，或由容器本地 CLI stdout 输出；运行时文件只保存 SHA-256 摘要，不能从磁盘还原明文。
2. 有效期为 24 小时。重新轮换会立即替代旧凭证，因此不要把旧值继续分发给值守人员。
3. 容器内轮换命令固定为：

   ```bash
   node /app/backend/dist/runtime/database-rescue-cli.js rotate-credential <taskId>
   ```

   此 CLI 不接受路径、SQL、shell 片段或连接参数。stdout 是操作者主动请求的唯一明文交付通道；禁止重定向到普通应用日志、聊天记录或长期文件。
4. 控制文件和审计文件在非 Windows 平台以 `0600` 写入，目录以 `0700` 创建；部署卷、备份介质和终端输出仍需按组织权限策略保护。

## 受控回退操作

救援页的 Bearer 凭证仅用于同一任务的以下操作：读取状态、准备回退、提交回退。它不提供任意 SQL、文件路径、数据库连接字符串或数据库文件选择。

1. 先读取状态。只有维护只读、迁移锁、任务归属、SQLite 源文件身份和不可变快照摘要全部可验证时，才会出现 `prepare_rollback`。
2. 调用准备回退接口得到一次性 nonce。nonce 只保存摘要，有效期 60 秒。
3. 使用同一任务凭证、该 nonce 和符合格式的 `Idempotency-Key` 调用回退。服务先把恢复意图持久化，再冻结正常业务运行时；相同操作键的重试只返回原操作状态，不生成第二次回退。
4. 服务写入受控 SQLite runtime override 和 `rollback_pending` marker，进入计划重启。onebox 使用退出码 `75` 交给容器重启策略续接。

任何一步若返回稳定原因码，应保留现场并检查任务、源文件、快照、维护锁和控制文件；不要通过手改 JSON、删除 marker 或复制 SQLite 文件绕开门禁。

## 恢复协议与稳定救援

恢复意图只有以下阶段，阶段变更必须落盘：

| 阶段 | 含义 |
| --- | --- |
| `PREPARED` | 自动迁移已处于冻结且已生成快照；验证任务、源文件身份和快照后，先持久化恢复意图，再改任务、runtime override 和 cutover marker。 |
| `RESTART_READY` | 已写入受控 SQLite 覆盖与回退 marker，等待计划重启。 |
| `VERIFYING` | SQLite 重启后重新校验源文件与摘要，计入本次启动尝试。 |
| `FINALIZING` | 数据验证与最终审计完成，开始启动补数和 marker 收尾。 |
| `COMPLETED` | marker 已收尾、恢复意图完成，维护状态最后解除。 |

SQLite 恢复启动失败时，系统最多自动再请求一次计划重启。第二次失败会稳定保留在救援态，并报告 `RESCUE_RESTART_LIMIT`；不要无限重启容器。处于 `FINALIZING` 的重启只重放必要收尾，不重新将已验证的回退误判为新任务。

控制文件损坏、符号链接、超过边界大小、格式不合法或任务所有权无法证明时，系统会收敛到受限诊断。禁止删除 runtime override、maintenance state、cutover marker 或恢复意图后碰运气重启；这会损失可验证证据并可能使旧 SQLite 与新 MySQL 状态混淆。

同样禁止在恢复过程中部署旧程序、降级镜像，或使用不认识当前控制文件协议的历史版本“先把服务拉起来”。必须以当前版本的受限控制面保留恢复日志、维护锁和源文件校验。

## MySQL 已接管后的限制

只有自动迁移维护/验收窗口内才允许回到任务源 SQLite。一旦 MySQL 已正式承接业务写入，旧 SQLite 不再同步：

- 禁止清除 runtime override 后直接重启回旧 SQLite；
- 禁止将旧 SQLite 复制覆盖当前数据目录；
- 应先停止写入，再从 MySQL 备份恢复，或执行受控反向迁移；
- 管理端运行时状态中的 `rollbackSafety` 会明确说明是否仍允许直接 SQLite 回退。

这条规则防止迁移后的订单、库存、会话或审计记录静默丢失。

## 验证证据与待复核项

本轮已获得的相关证据：

- `security:findings:verify`、路由权限、写事务、O2O 和客户端认证专项验证通过，相关 fixture 使用独立 SQLite 和数据目录；
- `database-rescue-startup-verify` 覆盖数据库不可达、cutover marker 损坏、runtime override 损坏时的受限启动；
- onebox 本机 Node 烟雾、上传、O2O 公共读缓存、前端构建和文本编码检查通过；
- 真实 Docker 的默认 success、带 30 个实体序列空洞的 success、`failure-rollback`、`verifying-emergency-rollback` 与 `corrupted-cutover-marker` 已通过。后者覆盖独立网页访问、业务 API 返回 `503`、稳定救援不出现重启循环，以及容器本地凭证经真实 HTTP nonce/幂等回退与精确一次审计。
- 迁移会保留 SQLite `sqlite_sequence` 的历史高位，包括已删除 ID 留下的序列空洞；比较与迁移口径使用 BigInt 精确值，不能把该高位误当作当前最大行 ID。

2026-09-06 的最终隔离 `npm run verify:performance` 已通过：构建总产物 `4198.37 / 4200 KB`，隔离后端冷启动 `1692.65 / 3000ms`，管理端核心路径、客户端并发、Task 6 五场景与双预算均通过。该门禁现在以 50ms 健康探测记录最后失败和首次成功，未放宽起点、健康判定或阈值。真实 Docker 迁移矩阵的 18 个场景也已完成并通过，相关容器与卷已清理。根依赖锁的 Web-only 审计和后端生产审计为 0；Mobile workspace 的全量安装审计仍有 19 项告警，不能混为同一审计结论。

## 参考实现

- `backend/src/utils/http-security.ts`
- `backend/src/routes/database-rescue.routes.ts`
- `backend/src/runtime/database-rescue-control.ts`
- `backend/src/runtime/durable-control-file.ts`
- `backend/src/runtime/database-rescue-cli.ts`
- `backend/src/runtime/rescue-app.ts`
- `docker/nginx/configure-proxy-boundary.sh`
- `docker/nginx/onebox.conf`
- `docker/onebox/entrypoint.sh`
