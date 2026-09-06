# Web 安全加固与自动迁移恢复验收记录

日期：2026-09-06。实施分支：`codex/web-security-hardening`。主线合并基线：`78010d629bfa2f2fca386d2335cdd8b6b9623b08`。

本轮保留原有认证表单动画修复和未跟踪文件，在当前工作目录实施。安全修复已提交至 PR #57，未部署生产环境。真实数据库验证均使用隔离测试库，没有迁移生产数据或改写历史 SQL，没有新增运行时依赖。

## 2026-09-06 合入最新主线后的验证

本节对应合入 `origin/main a95d5d5`（教师统一邀请码）后的结果，优先于下方历史记录。文档冲突合并保留统一邀请码和数据库救援说明；认证服务与路由保留两侧行为。

- 前端构建（`npm run verify:performance` 的构建步骤）、`npm --prefix backend run build`：通过。
- 后端 `client-staff-invite-code:verify`、`client-staff-directory:verify`、`client-auth:department-governance:verify`：通过，覆盖统一码轮换/禁用、注册事务二次校验、并发工号唯一约束和匿名冲突提示。
- 后端 `security:hardening:verify`、`security:auth-depth:verify`、`security:findings:verify`：通过。前一项首次运行因测试耗尽同来源认证额度而在随后登录返回 429；现已将限流场景隔离到独立应用实例，并断言变换不可信转发 IP 仍无法绕过限流，修复后复跑通过。未放宽生产限流或代理规则。
- 后端 `task2:route-contract:verify`、`write-transaction:contract:verify`：通过，路由增至 176 条（14 public、133 admin、23 client、6 rescue）。
- `node scripts/verify-db-migration-completion.mjs`、`node scripts/verify-db-migration-connection-test.mjs`：通过。
- `npm run verify:performance`：前端构建通过，总产物 `4203.13 / 4200 KB`，仍超预算 `3.13 KB`；其余构建预算未报错，后续运行时性能子项因门禁停止而未执行。未修改预算。

本次只验证合并与相关兼容性，未重跑完整 Docker/MySQL 故障矩阵，也未操作已有手动迁移环境。

## 2026-09-06 提交前补充验证

本节覆盖随后新增的迁移连接测试、错误诊断和“迁移已完成”显示，优先于下方先前整合验收的性能结论。当前代码构建与下列专项通过，但生产构建总产物为 `4203.36 / 4200 KB`，超出预算 `3.36 KB`；不能将当前提交表述为性能门禁全部通过。

本次实际运行：

- `npm run build`、`npm --prefix backend run build`：通过。
- `node scripts/verify-db-migration-completion.mjs`、`node scripts/verify-db-migration-connection-test.mjs`：完成判定、组件渲染、参数失效、取消与失败路径通过。
- `npm --prefix backend run task2:route-contract:verify`、`npm --prefix backend run write-transaction:contract:verify`：通过。
- `npm run verify:text-encoding`、`git diff --check`：通过。
- `npm run verify:performance`：构建阶段通过，在包体预算阶段停止，后续运行时性能子项未执行。首次隔离调用额外设置了 `NODE_ENV=test`，导致非生产依赖被纳入产物；移除该调用参数后，重新执行正常 `npm run build` 与 `node scripts/verify-enterprise-page-performance.mjs`，确认首屏指标通过，仅总产物仍超出上述预算。未修改性能阈值或扩大本次提交范围进行性能优化。

当前手动测试环境已由用户完成 SQLite → MySQL 迁移；本次提交准备不触发再次迁移、回退、重启或数据清理。完整 Docker 故障矩阵的证据保留于下方先前验收，本次未重复执行。

按用户确认的范围，仅提交正式代码、部署配置、回归脚本和文档。本地环境、测试数据库、账号凭据、日志、截图、数据包与浏览器测试产物保持忽略；新增常见测试产物目录的 Git 忽略规则。

## 问题、修复与对应验证

| 边界 | 最终行为与主要文件 | 验证证据 |
| --- | --- | --- |
| 代理、协议、端口 | `http-security.ts` 默认不信任代理，Compose 使用明确入口地址，生产后端不映射宿主机端口；三份 Nginx 覆盖转发 IP/Host/协议 | HTTP 边界专项、边缘静态契约、真实 Nginx 伪造协议请求 |
| 页面与 API 响应头 | HTML location 显式复用页面头；代理 location 保留 API/上传专用 CSP，HSTS 由确认协议的入口统一下发 | `/`、`/login`、`/client`、救援页、404、API 和 `/health` 的真实响应 |
| Cookie CSRF | `client-auth.middleware.ts` 记录实际凭据来源，Cookie 优先；混合凭据不能绕过会话派生 CSRF | 缺失、伪造、合法、Bearer-only、混合凭据专项 |
| 前端写入重试 | `src/api/http.ts` 仅对明确的 `CLIENT_CSRF_MISSING` 补发并最多重试一次，保留幂等键 | 认证专项和客户端核心链路；普通 403/5xx/取消不自动重放 |
| 枚举、验证码、票据 | 未知账号执行等价密码散列；停用判断位于密码校验后；PNG CAPTCHA、两类独立存储、原子票据消费和 5 次失败上限 | `security:auth-depth:verify`、PNVS 和部门账号专项 |
| 身份变化和并发登录 | 敏感账号变化与会话撤销同事务；签发前锁定账号并复核密码及身份快照；事务提交后断开 SSE | SQLite 管理员/客户端/注册竞态；真实 MySQL 两类账号 owner 行锁竞态 |
| SSE 隐私与资源 | `customer-service-realtime.service.ts` 按批复核会话与权限，仅保存令牌散列；内部备注只给客服；连接、队列、频控和背压均有上限 | 私有事件零下发、撤销后零业务消息、连接与队列超限、慢消费者及反馈端到端回归 |
| 附件隐私与并发 | 客户只能读自己的有效草稿/消息附件，客服不能读草稿；配额、绑定与清理复用事务和 MySQL owner 行锁 | 跨账号/角色附件授权、SQLite 与真实 MySQL 并发配额及绑定/清理竞争 |
| 文件清理 | 建档失败回收新文件；已过期未绑定附件提交后删文件；UUID 孤儿在宽限期后还须同时排除附件表与消息引用 | `feedback:attachment-cleanup:verify`；历史路径、不确定引用保留并报告 |
| 数量、打印、导出 | `web-resource-limits.ts` 统一 O2O/供应方明细 200 条和累计 INT 边界；有效部门订单可幂等标记打印，取消/删除拒绝；保持流式导出并限制并发 | 200/201 边界、核销后打印兼容、重复审计、库存不变量、报表租约释放 |
| 路由和前端注入 | TypeScript AST 解析实际装配，区分 public/admin/client/rescue；回跳路径严格校验，图表 HTML 转义 | 173 条实际路由：14 public、130 admin、23 client、6 rescue；业务边界专项 |
| 写入冻结 | `operation-gate.ts` 覆盖完整 Promise、显式事务及所有 TypeORM 写入口；worker 暂停、排空；脱离有效租约的晚到写入拒绝 | 冻结 10 组专项、事务协调器、写事务契约、真实 MySQL 并发验证 |
| 独立启动 | `index.ts` 在业务模块加载前检查控制状态；数据库不可达/控制文件损坏时启动独立救援 HTTP | 三个真实子进程场景，503 RESCUE、普通业务拒绝且不生成 SQLite/bootstrap |
| 凭证、nonce 与日志 | `database-rescue-control.ts` 使用独立散列凭证文件、任务绑定、60 秒 nonce、幂等操作和持久恢复意图；快照异步更新不能恢复旧凭证 | 并发轮换、旧凭证/过期/缺失/损坏/错误任务拒绝；5 个落盘中断点与取消写盘中断重放 |
| 回退与收尾 | PREPARED → RESTART_READY → VERIFYING → FINALIZING → COMPLETED；维护最后解除；持续失败只自动重试一次 SQLite，之后稳定救援 | 真实容器取消、持续终态写盘失败、损坏 marker 救援及审计精确一次 |
| 全表一致性 | 30 个实体逐表记录数、内容摘要、结构、约束、关系和自增状态；BigInt 保留已删除高位 ID 空洞 | SQLite NUL/结构/精确审计增量专项；真实 MySQL 内容篡改拒绝；带 30 表序列空洞的迁移成功 |
| 一键页面与救援页面 | 真实预检、六阶段、后端允许动作、90 秒重启提示；救援独立入口和当前标签页凭证 | Vue 构建，真实 Chrome 桌面/375×812 smoke；无普通登录 API、凭证不进 URL |

关键回归不是通过放宽安全条件实现：中断续跑仍要求唯一任务所有权和已知表；写盘失败仍保持恢复意图与冻结；正式 MySQL 写入窗口后直接回旧 SQLite 仍返回 409。

## 真实 Docker/MySQL 矩阵

命令为 `npm run verify:db:migration`，通过环境变量 `Y_LINK_DB_MIGRATION_SCENARIO` 逐项执行。18 个场景最新运行均为退出码 0：

| 场景 | 结果 |
| --- | --- |
| `success` | 全表强校验、容器自动重启、MySQL 8.4/utf8mb4 实际生效、直接回旧 SQLite 禁令通过 |
| `wrong-connection` | 错误连接拒绝，源库不变 |
| `old-version` | 真实 MySQL 8.0.15 拒绝 |
| `wrong-charset` | 错误字符集拒绝 |
| `insufficient-permissions` | 权限不足拒绝 |
| `non-empty-target` | 非空目标拒绝，既有目标数据保留 |
| `duplicate-task` | 重复任务被锁阻断，首任务正常完成 |
| `content-tamper` | 记录数相同但内容不同仍校验失败 |
| `execution-interruption` | 自动拉起并安全续跑，再次强校验后切换 |
| `cutover-persistence-failure` | 切换持久化失败补偿，审计保留实际发起人 |
| `switching-emergency-rollback` | 切换窗口受控回退成功 |
| `cutover-cancel-persistence-failure` | PREPARED 后任务写盘中断保持冻结，重启重放并恢复 SQLite |
| `rollback-finalizer-persistence-failure` | 持续终态失败进入稳定救援，原库全表摘要不变，不伪造完成 |
| `task-creation-persistence-failure` | 首次任务落盘失败不遗留锁和目标密钥 |
| `corrupted-active-task` | 无法证明任务归属时禁止回退，保留现场 |
| `corrupted-cutover-marker` | 独立网页、无凭证/错误凭证拒绝、nonce/幂等与真实 HTTP 回退通过 |
| `verifying-emergency-rollback` | MySQL 验收期取消不会被 succeeded 覆盖 |
| `failure-rollback` | 两次 MySQL 启动失败后自动回 SQLite；旧 COMPLETED 日志不干扰新任务 |

本机 Docker CLI 实际位于用户安装目录，Engine 为 29.6.2、Compose 为 5.3.1。测试使用官方 `node:22-bookworm-slim` 构建参数；默认 ECR 镜像源在本机返回 EOF，未修改生产镜像默认值。每次创建唯一 project、随机测试凭据、独立网络和临时卷，并在结束后清理。

## 构建与回归命令

以下后端命令均通过 `npm --prefix backend run <脚本>` 执行，已在最终整合状态运行并通过：

```text
build
security:hardening:verify
security:findings:verify
task2:route-contract:verify
permission:regression:verify
verification:aliyun:verify
client-auth:department-governance:verify
feedback:customer-service:verify
o2o:verify
inventory:invariants:verify
reports:contract:verify
transaction-coordinator:verify
write-transaction:contract:verify
verify:db:write-freeze
verify:db:migration:foundation
verify:db:rescue:startup
verify:db:startup-control
verify:db:migration:resume
verify:db:rescue:protocol
```

另外已通过 `security:auth-depth:verify`、`security:auth-sse-final:verify`、HTTP/业务边界专项、附件 SQLite/MySQL 专项、SQLite 摘要与自增专项，以及根目录 `npm run verify:db:concurrency` 的真实 MySQL 并发验证。

根目录 `npm run build`、`npm run verify:onebox:uploads`、`npm run verify:o2o:public-read-cache`、`npm run verify:text-encoding` 与 `git diff --check` 已通过。Docker 矩阵结束后，在独立 SQLite/数据目录中顺序执行 `npm run verify:performance`、`npm run verify:unit:functional` 和 `npm run verify:onebox:smoke`，最终整合复跑全部通过。

性能实测：总产物 `4198.37 / 4200 KB`，首屏依赖图 `1143.75 / 1180 KB`，后端冷启动 `1692.65 / 3000 ms`，客户端注册 P95 `988.80 / 1200 ms`。此前失败记录保留；修复了健康检查 500 ms 采样误差以及注册测试循环首次动态导入造成的计时混入，未降低安全强度或放宽性能阈值。总产物预算剩余约 1.63 KB，后续增加页面资源时应关注该门禁。

最终收尾将四处重复的单据限制移到纯常量模块，数值和业务行为不变；修改后重新通过 `security:business-boundary:verify`、`task2:route-contract:verify` 和后端 `build`。该收尾不涉及迁移、前端产物或并发实现，没有重复运行已经通过的完整 Docker 与性能矩阵。

## 依赖与验证边界

- 根目录 `npm audit --package-lock-only --workspaces=false --json` 和后端 `npm audit --package-lock-only --json` 均返回 0 项告警；`qs` 为 6.16.0、`fflate` 为 0.8.3，保留主线已有升级。没有使用 `audit fix --force`。
- Web 锁文件结果不等于整个 Mobile workspace 无告警；此前全安装审计仍有 Mobile 范围告警，未在本次 Web 范围内无差别升级。
- 浏览器救援 smoke 使用本机受控 API mock，仅证明页面、响应错误、允许动作和凭证边界；真实后端凭证、nonce、回退和容器重启由上述 Docker 场景验证。客户端反馈页真实断网后的视觉重连流程未单独浏览器重演，已做生产 onOpen 同步契约与双端 SSE 回归。
- SSE 连接表、通用验证码票据、进程导出上限仍是单实例设施。多实例运行前需要会话路由及跨实例事件协调；本次没有引入新的消息总线或共享缓存依赖。
- Windows 文件权限受操作系统 ACL 约束；Linux 容器控制文件使用 0600、目录 0700。没有对生产站点、1Panel/OpenResty 的实际公网 TLS 配置做部署验收。

原始本机证据位于 `.local-dev/security-hardening/`：`docker-matrix-results.jsonl`、`docker-<场景>.log`、`final-backend-results.jsonl`、`final-*.log`、各工作包报告及 `rescue-browser-smoke-report.json`。失败与修复过程保留在运行记录中，结果以每项最新运行及本验收记录为准。
