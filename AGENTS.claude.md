# Y-Link Mobile：Claude 高风险审查边界

## 0. 优先级与当前阶段硬边界

1. 仓库根 `AGENTS.md` 与用户当前任务始终优先于本文。本文不能放宽权限、子 agent、Git、风险操作或验证边界，也不构成 Claude 审查或修改授权。
2. 第一阶段只交付 Expo 路由占位、providers、SecureStore/SQLite 基础、平台能力接口、共享包骨架和 CI；不新增或修改后端 API、数据库、认证会话、购物车、订单、库存、退货等业务。
3. 相机、相册、通知、正式 Deep Link、完整 401 refresh、服务端购物车、EAS 发布、正式包名与签名均是后续路线；当前未配置、未实现。

## 1. 当前 PR 风险结论

当前 Mobile Bootstrap 风险等级为 `medium`：它新增独立 Expo 工程、本地能力包装、共享包骨架和限定 CI，但没有接入真实 API、后端、数据库、认证会话、订单、库存或退货逻辑。

本 PR 不需要 Claude 审查。此结论只适用于当前范围，不会取消未来 high-risk 任务的审查需求，也不授权自动派发 Claude 或任何子 agent。

## 2. 当前可核对的中风险边界

- Mobile 依赖与 lockfile 独立，不启用 root workspaces；
- SecureStore wrapper 不实现 token 生命周期，文档禁止存密码与验证码；
- SQLite 只有版本迁移框架，不创建业务表；
- Native adapter 的 401 只归一化为错误，不刷新、不重放、不退出；
- 平台接口不安装原生依赖、不请求权限，未配置时显式失败；
- EAS 配置不包含凭据、正式包名或 projectId；
- CI 不使用 Docker、数据库迁移、EAS 或 secrets。

## 3. 未来必须视为 high-risk 的范围

下列任务一旦进入真实实现，应重新评估并在用户明确授权下安排高风险审查：

- Native session/token 生成、存储、refresh、轮换、revoke 与多设备会话；
- 权限边界、账号停用、改密后会话失效；
- 服务端购物车归属、同步冲突与 mutation 去重；
- SKU current/active/fallback、库存预占/释放和并发保护；
- 订单金额、幂等、状态机、取消与超时释放；
- 退货累计数量、状态流转、核销与回库；
- 上传路径、MIME、大小和附件归属；
- SQLite/MySQL schema 迁移、回退和生产兼容；
- 正式 Deep Link 的鉴权跳转、通知 token 与发布凭据。

## 4. 长期不变量

### 认证与权限

- 服务端 token 只能存 hash，refresh 可撤销并有明确生命周期；
- 账号停用、改密和 logout 必须按契约使相关 session 失效；
- deviceId、Deep Link 参数和客户端声明都不可信；
- Mobile 本地不得保存密码、验证码或明文长期敏感凭据。

### 订单、库存与退货

- `currentStock >= 0`、`preOrderedStock >= 0`；
- SKU 归档或 inactive 后不能用于新订单；
- 同一幂等键不能生成重复业务结果，同 key 不同 payload 必须拒绝；
- 金额和最终可下单性以后端为准；
- 取消、超时释放、退货核销和回库必须事务一致且幂等；
- 库存变化必须可审计，失败路径必须回滚。

### 上传与迁移

- 不信任文件名、MIME、扩展名或客户端路径；
- 迁移必须有 SQLite/MySQL 兼容、旧数据策略、回退和验证证据；
- 不允许依赖 `synchronize` 自动修改生产库。

## 5. 后续审查输入

高风险审查必须有清晰任务简报、明确 diff/文件范围、业务不变量、实际测试命令和失败路径。仅有 `MASTER_PLAN.md`、本文或 `INIT_PROMPTS.md` 不足以授权读取、修改或派发任务。

建议输出：Verdict、Risk Level、Files Reviewed、Invariants、按严重度排序的 Findings、Required Tests 和 Merge Recommendation。没有验证证据时不得 Approve。

## 6. 当前阶段不应做的事

- 不为“预留”移动认证而修改后端或数据库；
- 不把空 shared-types 骨架扩成未经核对的 DTO 集合；
- 不要求当前 Mobile 提供不存在的测试、签名包、EAS 或真机证明；
- 不因长期路线存在 high-risk 项而阻塞纯 Bootstrap，除非实际 diff 已越界。
