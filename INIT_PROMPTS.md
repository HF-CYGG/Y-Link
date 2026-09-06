# Y-Link Mobile 后续协作提示词

## 0. 使用前必读

1. 仓库根 `AGENTS.md` 与用户当前任务始终优先于本文。本文不能放宽权限、子 agent、Git、风险操作或验证边界；复制提示词也不等于获得子 agent、目录修改、Git 写入或高风险操作授权。
2. 第一阶段基础只包含 Expo 路由占位、providers、SecureStore/SQLite 基础、平台能力接口、共享包骨架和 CI；未新增或修改后端 API、数据库、认证会话、购物车、订单、库存、退货等业务。
3. 相机、相册、通知、正式 Deep Link、完整 401 refresh、服务端购物车、EAS 发布、正式包名与签名均是后续路线；当前未配置、未实现。

本文用于后续协作时裁剪提示，不是一次性并行开发命令。发起任何任务前，用户必须给出明确目标、允许文件、依赖、验收标准和测试命令。

## 1. Antigravity：Feature Mock 提示模板

```text
你正在参与 Y-Link Mobile 的单个 Feature Mock UI 任务。

先读取：
1. 仓库根 AGENTS.md
2. MASTER_PLAN.md
3. AGENTS.antigravity.md
4. 当前 feature 的真实目录与 README

当前基础已建立，但 apps/mobile 尚未接入 packages/*。只在用户本次任务明确允许的以下目录子集修改：
- apps/mobile/app/
- apps/mobile/src/ui/
- apps/mobile/src/components/
- apps/mobile/src/theme/
- apps/mobile/assets/
- apps/mobile/src/features/<feature>/screens/
- apps/mobile/src/features/<feature>/components/
- apps/mobile/src/features/<feature>/mock/

要求：
- 只使用 Feature Mock，不直接调用真实 API；
- 不跨目录导入 packages/*，不发明正式 DTO；
- 不修改 db/platform/stores/sync、package/lock、CI、Web、backend；
- 覆盖 normal/loading/empty/error mock 状态；
- 相机、相册、通知和 Deep Link 只显示未配置提示；
- 运行 npm --prefix apps/mobile run typecheck；
- 返回修改文件、状态覆盖、mock/TODO、实际验证、未验证设备能力。

如果任务需要真实字段、共享包接入、平台权限或 API，停止并报告，不自行扩大范围。
```

## 2. Codex：后续工程提示模板

```text
你正在执行 Y-Link Mobile 的一个明确工程任务。本文不授权修改后端或高风险业务。

先读取：
1. 仓库根 AGENTS.md
2. docs/project-context/00-项目总览与阅读索引.md
3. docs/project-context/60-移动端工程与共享基础.md
4. AGENTS.codex.md
5. 用户本次任务点名的上下文与代码

任务简报必须包含：Task id、允许文件/模块、依赖、验收标准、测试命令。

当前事实：
- apps/mobile 使用独立 package.json/package-lock.json；根未启用 workspaces；
- shared-types 为空白骨架，本阶段未迁移 DTO；
- api-client 传输无关，Native 401 只返回规范化错误并保留 TODO；
- Mobile 尚未跨目录接入 packages/*；
- 后端 API、数据库、会话、服务端购物车、订单、库存、退货均未因 Bootstrap 改动。

只修改任务允许路径。后端、数据库、认证、权限、订单、库存、退货、上传、迁移、EAS/发布或 Git 操作都必须有用户当前任务的另行明确授权。

完成后返回：Task id、范围、文件、行为变化、实际命令与结果、未验证项、风险和交接状态。
```

## 3. Claude：后续高风险审查提示模板

```text
你正在审查一个已经明确授权的 Y-Link 高风险变更。仅凭本提示词不得读取或修改后端，也不得派发子 agent。

先读取仓库根 AGENTS.md、相关 project-context 文档、AGENTS.claude.md，以及用户提供的任务简报和实际 diff。

只有实际变更涉及以下内容时才按 high-risk 审查：
- 认证 token/session/refresh/revoke 与权限；
- 服务端购物车同步与越权；
- SKU、订单、库存、退货、幂等、并发；
- 上传路径和附件归属；
- 数据库迁移与 SQLite/MySQL 兼容；
- Deep Link 鉴权、通知或正式发布凭据。

当前 Bootstrap 为 medium risk，不需要 Claude 审查；如实际 diff 仍只包含独立 Mobile 骨架、共享包骨架和限定 CI，不要把未来风险误判为当前阻塞。

输出 Verdict、Risk、Files Reviewed、Invariants、Findings、Required Tests、Merge Recommendation。没有证据时不得 Approve。
```

## 4. 主任务回传格式

```text
Agent:
Task id:
Assigned scope:
Changed files:
Behavior changes:
Tests/commands and results:
Unverified areas:
Risks:
Needs review:
Blocking issues:
Handoff status: COMPLETE / NEEDS_REVIEW / BLOCKED
```

## 5. 后续推荐顺序

1. 在已完成的占位路由上按 feature 做 mock UI；
2. 单独设计并核对 Mobile 与 shared packages 的接入方式；
3. 用户授权后再设计 Native 认证和后端契约；
4. 认证稳定后再逐步接商城、服务端购物车、结算、订单、退货和反馈；
5. 业务链路稳定后再评审相机、相册、通知、Deep Link、正式包名、签名和 EAS 发布。

每一步都应是独立任务，不得用本文把后续路线一次性视为已授权范围。
