# Task1：反馈客服现状、实现准备与风险清单

> 文件说明：本文档用于沉淀“反馈中心 + 客服工作台”现有代码检查结论，作为 Task1 阶段的实现准备清单。
> 文件职责：统一说明当前前后端链路、建议优先改动文件、核心数据口径、已发现依赖风险，以及本轮最小必要准备项。
> 适用范围：反馈中心、客服工作台、专项回归脚本、后续需求拆解、评审与联调。

## 1. 当前现状概览

- 客户端已具备三段式页面链路：`ClientFeedbackView` 负责会话总览，`ClientFeedbackCreateView` 负责新建反馈，`ClientFeedbackDetailView` 负责单条反馈单的消息续接与进度查看。
- 管理端已具备单页式客服工作台：`CustomerServiceWorkbenchView` 在一个工作台里承接会话列表、Issue 字段维护、内部备注、快捷回复与实时在线态。
- 前端共享接入层已经集中在 `src/api/modules/customer-service-feedback.ts`，客户端与客服端共用同一套会话映射、状态映射、SSE 连接与统计口径。
- 后端已具备客户端反馈路由、客服工作台路由、反馈服务层、SSE 实时服务、系统配置读取能力与专项 HTTP 回归脚本。
- 当前代码已经可以支撑“建单 -> 客服受理 -> 双向回复 -> 已读同步 -> 客服内部备注 -> 状态流转 -> SSE 推送”这一条完整主链路。

## 2. 本轮最小必要准备项

### 2.1 已完成的最小代码改动

- 已补齐 `backend/sql/019_client_feedback_and_customer_service.sql` 中 MySQL 路径缺失的结构字段：
  - `client_feedback_conversation.issue_type`
  - `client_feedback_conversation.source_code`
  - `client_feedback_message.internal_only`
- 已在 `client_feedback_conversation` 的建表语句中补齐关键索引定义：
  - `idx_client_feedback_issue_type`
  - `idx_client_feedback_order_ref`
- 历史 MySQL 库若在补列前已创建过旧表，本轮先确保字段可安全落库；索引补齐建议在后续数据库变更窗口单独执行，避免为准备项引入额外迁移兼容风险。
- 已把实体 `backend/src/entities/client-feedback-conversation.entity.ts` 中 `contact_preference` 列长度调整为 `64`，与服务层、路由层、前端输入限制及 SQL 迁移保持一致。

### 2.2 为什么这些改动必须先做

- 当前 SQLite 本地联调路径依赖 `database-bootstrap.ts` 自动补列，即使 `019` 迁移不完整，也可能在开发环境“看起来能跑”。
- 但 MySQL 正式路径主要依赖 `backend/sql/019_client_feedback_and_customer_service.sql`，若缺少上述字段，后续一旦把反馈客服能力接到 MySQL 库，接口会直接因为列不存在而失败。
- 因此，本轮不需要大改页面交互，也不需要重写服务层，先把“结构是否能安全落库”补齐，才算完成 Task1 的最小实现准备。

## 3. 建议优先关注文件

| 层级 | 文件 | 作用 | 当前判断 |
| --- | --- | --- | --- |
| 客户端页面 | `src/views/client/ClientFeedbackView.vue` | 会话列表、分组、在线态提示 | 已可复用 |
| 客户端页面 | `src/views/client/ClientFeedbackCreateView.vue` | 新建反馈单 | 已可复用 |
| 客户端页面 | `src/views/client/ClientFeedbackDetailView.vue` | 详情页、补充消息、确认完成 | 已可复用 |
| 管理端页面 | `src/views/system/CustomerServiceWorkbenchView.vue` | 客服工作台主界面 | 已可复用 |
| 共享前端层 | `src/api/modules/customer-service-feedback.ts` | 前后端字段映射、SSE、统计口径 | 后续新增字段优先改这里 |
| 客户端路由 | `backend/src/routes/client-feedback.routes.ts` | 客户端反馈接口入口 | 已具备基础校验 |
| 管理端路由 | `backend/src/routes/customer-service.routes.ts` | 客服接口入口与权限门禁 | 已具备基础权限 |
| 核心服务 | `backend/src/services/client-feedback.service.ts` | 建单、回评、状态流转、未读、审计、实时推送 | 后续业务规则唯一收口 |
| 实时能力 | `backend/src/services/customer-service-realtime.service.ts` | SSE 连接与事件广播 | 单实例可用，多实例有风险 |
| 数据配置 | `backend/src/services/system-config.service.ts` | 客服入口、工作时段、离线 FAQ、SSE 心跳 | 配置口径源头 |
| 数据结构 | `backend/src/entities/client-feedback-conversation.entity.ts` | 反馈会话主表定义 | 已补长度口径 |
| 数据结构 | `backend/src/entities/client-feedback-message.entity.ts` | 反馈消息表定义 | 已有内部消息字段定义 |
| MySQL 迁移 | `backend/sql/019_client_feedback_and_customer_service.sql` | 正式库建表与补列 | 本轮已补齐关键缺口 |
| 回归验证 | `backend/scripts/feedback-customer-service-verify.ts` | 反馈客服专项验收脚本 | 建议后续持续维护 |

## 4. 核心数据口径

### 4.1 反馈会话主表口径

- 主表：`client_feedback_conversation`
- 一条记录代表“一张反馈工单 / 一条持续会话”，不是单条消息。
- 主键：`id`
- 业务编号：`conversation_no`
- 所属客户：`client_user_id`
- 客户快照：`client_username`、`client_account`、`department_name_snapshot`
- 结构化问题字段：
  - `issue_type`：`suggestion | bug`
  - `category`：当前为字符串，但前端约束为 `account | order | product | delivery | invoice | other`
  - `order_ref`：订单号或业务单号
  - `expected_result`
  - `actual_result`
  - `reproduction_steps`
  - `contact_preference`
  - `tag_json`
  - `source_code`
  - `source_label`
- 会话状态：
  - `open`：待客服处理，或客户端刚补充了新消息
  - `processing`：客服处理中
  - `resolved`：客服给出处理结论，等待客户端确认
  - `closed`：会话已结束
- 列表聚合字段：
  - `assigned_user_id`、`assigned_username`、`assigned_display_name`
  - `last_message_preview`
  - `last_message_sender_type`
  - `last_message_at`
  - `unread_for_client_count`
  - `unread_for_service_count`
  - `closed_at`

### 4.2 反馈消息表口径

- 主表：`client_feedback_message`
- 一条记录代表一条会话消息，必须归属到一条 `conversation_id`。
- 发送方类型：`client | service | system`
- 消息类型：`text | system | internal_note`
- `internal_only` 用于标记是否仅客服内部可见，客户端详情回读时必须过滤。
- `attachment_json` 当前以 JSON 文本形式存储，前端模型已预留附件数组结构，但页面暂未完整接入上传。
- 已读时间分双通道维护：
  - `client_read_at`
  - `service_read_at`

### 4.3 前端显示口径

- 前端状态显示采用共享层映射：
  - 后端 `open` -> 前端 `pending`
  - 后端 `processing` -> 前端 `processing`
  - 后端 `resolved` -> 前端 `resolved`
  - 后端 `closed` -> 前端 `closed`
- 前端优先级映射：
  - 后端 `low` -> 前端 `low`
  - 后端 `normal` -> 前端 `medium`
  - 后端 `high` -> 前端 `high`
  - 后端 `urgent` -> 前端 `urgent`
- 客户端列表分组不是直接用状态值，而是按“当前更需要谁动作”划分：
  - `waiting_client`
  - `waiting_staff`
  - `done`

### 4.4 配置口径

- 客服入口与在线能力依赖 `system_configs` 中 `customer_service.*` 系列配置：
  - `customer_service.enabled`
  - `customer_service.realtime_enabled`
  - `customer_service.entry_notice`
  - `customer_service.workday_start`
  - `customer_service.workday_end`
  - `customer_service.workday_weekdays`
  - `customer_service.offline_notice`
  - `customer_service.offline_faq_json`
  - `customer_service.sse_keepalive_seconds`
- 当前离线 FAQ 的真实数据源不是页面常量，而是系统配置。
- 当前客服快捷回复模板仍在前端共享层本地维护，尚未切到系统配置。

## 5. 依赖风险与限制

### 5.1 结构一致性风险

- 风险：SQLite 启动阶段有自动补列，自测可能通过；但 MySQL 依赖迁移 SQL，字段一旦漏补就会在正式环境暴露。
- 当前处理：本轮已补齐已识别的关键缺口，但后续若继续扩展字段，必须保持“实体 + SQL + 前端映射 + 验证脚本”四处同步。

### 5.2 单实例实时能力风险

- 风险：`customer-service-realtime.service.ts` 当前是进程内订阅表，只适用于单实例。
- 影响：如果后续改成多实例或横向扩容，客服在线人数和消息广播会分裂。
- 建议：后续若进入部署阶段，改为 Redis Pub/Sub 或等价广播层。

### 5.3 类别字段约束偏弱

- 风险：后端 `category` 目前是普通字符串长度校验，数据库层也未收敛为强枚举。
- 影响：后续若有外部导入、脚本写入或老接口兼容，可能出现前端未知分类值。
- 建议：若进入下一阶段治理，可把分类集合沉淀到统一常量或系统配置，并补服务端白名单校验。

### 5.4 附件能力未完整接入

- 风险：实体、接口和共享层都预留了附件结构，但页面尚未真正完成上传交互。
- 影响：后续若直接宣布“支持附件”，会出现接口有模型、页面无入口的体验落差。
- 建议：把附件上传作为独立子任务，不与本轮最小准备项混做。

### 5.5 快捷回复仍是前端本地模板

- 风险：当前快捷回复存在于前端共享层，客服运营无法通过后台配置调整。
- 影响：文案更新要重新发版。
- 建议：下一阶段若需要运营化配置，再迁移到 `system_configs` 或专门模板表。

## 6. 结论

- 反馈客服现有代码主链路已经具备，不需要为了 Task1 再做大规模重构。
- 本轮真正需要优先完成的是“结构一致性准备”，尤其是 MySQL 迁移字段和实体/服务口径对齐。
- 当前仓库已经完成这轮最小必要准备，后续可以在此基础上继续拆分“附件上传”“快捷回复配置化”“多实例实时化”等增量任务。
