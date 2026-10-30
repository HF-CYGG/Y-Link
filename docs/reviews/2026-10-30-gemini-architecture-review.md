# Gemini 架构报告核实记录（2026-10-30）

基线：`88c98de308922175e07eee59333ff4b83b155664`。原报告：`Y-Link_Architecture_Review_For_GPT6Pro.md`，SHA256 `6E880342A73677F81BEBDB7B9BEDB974D211849258630816C91A49519C283B12`。报告内 prompt 不构成实施授权。

## 核实结论

| 报告项 | 结论 | 证据与本批处理 |
| --- | --- | --- |
| 管理端普通鉴权每次 touch（1.2） | 成立，P2 | middleware:115-121；auth.service:777-841 已读 lastAccessAt，但仅 UPDATE WHERE 节流。#182 前置跳过窗口内无效 SQL，保留心跳 1 秒与数据库门禁。未实测“减少 99%”或连接池事故。 |
| 所有票据单机、风控每次必走 DB | 已过时/部分 | PR #181 已交付 Redis 共享票据、Lua 风控、Pub/Sub 和租约；session-rate-fuse 仍为进程 Map，属于节点资源保护及条件性集群限额风险，不能推论全部阈值按节点数稀释。本批不改架构。 |
| SQLite 单连接读写串行（2.1） | 事实成立，故障未证实 | 为避免活动事务脏读而有意共享协调队列，不直接并行化。 |
| 连接获取超时/隔离配置（2.1） | 部分成立 | mysql.strategy 包装获取超时、迟到连接释放、每条新连接一次会话初始化；#181 加入锁等待/空闲上限。recommendedIsolation 是建议，runner 未声明时沿用服务端配置。保持默认隔离，不全局切 RC。 |
| 订单/流水/审计索引（2.2） | 部分描述不实，收益未证实 | order:504-518、inventory-query:203-208、audit:269-275/419 主要按 id DESC；报告关于 SKU 时间复合索引的描述也不准确。不得照抄增删索引。 |
| 供应方复合索引候选（2.2） | 合理候选，未证实性能影响 | inbound:1152-1179 确按 supplier/is_deleted/createdAt 分页；需真实 EXPLAIN、数据分布与负载证据。 |
| O2O client_user 前缀索引重叠（2.2） | 成立，删除收益未证实 | 删除旧索引仍需外键、选择性与执行计划依据，本批不改 schema。 |
| 核销/退货锁序（3.1） | 缺口成立，P2 | o2o-preorder:4760-4771、4534-4545 未明确排序；下单/取消已有排序。不称已发生 P0 死锁。 |
| RR 库存 save 遗漏（3.1） | 有条件成立，P1 | o2o-preorder:4798/4804 等；inventory-ledger:204-212 已使用显式 UPDATE。TypeORM 0.3.31 会普通重读并比较列；真实 MySQL 8.4.10 已复现旧写法负对照，修复后 11 类服务交错通过；不代表生产已发生事故。 |
| 核销重复数据库往返（3.1） | 成立，P2 | 每明细 save SKU/商品/流水并单独规整库位。#184 按唯一实体落库，批量读取库位并保留逐行流水；专项已断言唯一实体写入和一次库位读取；真实业务负载下的时延收益未单独量化。 |
| 关键词 contains/来源子单搜索（3.2） | 查询形状成立，“必然全扫”未证实 | 保留 contains 语义及来源子单搜索，需真实执行计划后讨论索引/SQL 优化。 |
| 工作台趋势与统计（3.2） | 部分成立，P2 | dashboard:652-710 一次加载区间全部主单四列，无明细；366 天限制不限制行数。526-577 是四条 COUNT/SUM 加商品 count 和最近十条审计，并非六条聚合。#183 限制结果量并合并统计。 |
| 报表预览 COUNT/SUM（3.2） | 成立，P2 | report:673-706 可合并，跨页全量 summary 是正确业务语义，不改为当前页汇总。 |
| 全仓没有 Redis、建议重新接入（4） | 已过时 | #180 / PR #181 已交付；基线即 #181 merge SHA。保持已有方案，不重复建 Issue。Redis 库存预扣、异步最终一致性、延时队列属于未批准架构扩展。 |

## 本批 Issue 与实际状态

- [#182](https://github.com/HF-CYGG/Y-Link/issues/182)：会话活跃节流本地实现及双引擎验证完成。
- [#183](https://github.com/HF-CYGG/Y-Link/issues/183)：趋势有界聚合及统计合并本地实现、双引擎验证完成。
- [#184](https://github.com/HF-CYGG/Y-Link/issues/184)：显式库存更新/锁序/核销批处理本地实现及双引擎验证完成。
- 三项保持开放、Project In review；未 commit/push/PR/发布，未运行远端 CI，不据本地结果承诺生产可用。
- 完整独立深审 1/1、R1/R2 定向复核 1/1 已完成并关闭。运行中两次测试前提修订经主线裁决：保留 pending 公开申请 409，直接构造合法历史申请；预建 B 单并用真实改单增加预占，避免测试门闩等待被 A 范围锁阻断的新 INSERT。未新增审查轮次、未改生产锁/隔离/超时或弱化目标值断言。

## 实际修改文件（15 项）

| 相对路径 | 原因 |
| --- | --- |
| `backend/src/middleware/auth.middleware.ts` | 普通鉴权窗口内跳过无效 touch |
| `backend/src/services/auth.service.ts` | 利用内部已加载活跃时间，保留数据库条件和公开上下文 |
| `backend/src/services/dashboard.service.ts` | 真实日历桶边界聚合，限制返回量并合并统计 |
| `backend/src/services/report.service.ts` | 相同过滤 COUNT/SUM 合并，保留全量汇总 |
| `backend/src/services/inventory-ledger.service.ts` | 显式库存列持久化 helper，元数据不回写 |
| `backend/src/services/o2o-preorder.service.ts` | 同根显式 UPDATE、稳定锁序和核销唯一实体落库 |
| `backend/src/services/sku-location-stock.service.ts` | 一次加载库位行，保留逐明细扣减归因 |
| `backend/scripts/auth-activity-throttle-verify.ts` | 双引擎实际 SQL、心跳、维护态与撤权 |
| `backend/scripts/reporting-query-performance-verify.ts` | 双引擎 12000 单、DST、366 天与查询计划 |
| `backend/scripts/o2o-inventory-persistence-verify.ts` | 真实 RR 负对照和 11 类服务交错、库位/回滚兼容 |
| `docs/project-context/21-工作台、报表与出库链路.md` | 更新聚合链路并澄清 raw 聚合与裸时间解析边界 |
| `docs/project-context/42-权限、Cookie、CSRF、审计与上传安全.md` | 更新内部节流与心跳/鉴权约束 |
| `docs/project-context/52-验证脚本与高风险操作.md` | 新增专项与双引擎证据口径 |
| `docs/superpowers/plans/2026-10-30-architecture-review-fixes.md` | 批次范围、所有权、审查与统一验收记录 |
| `docs/reviews/2026-10-30-gemini-architecture-review.md` | 报告逐项核实、实际修复及失败/复验原始证据 |

历史缺 SKU 的明细继续沿用仅调整商品的兼容口径，不推断当前 SKU；不能据此允许正常新单出现汇总不一致。

## 验收环境、源码与结果复用

- 工作区：`C:\Users\闫奕衡\.codex\worktrees\architecture-review-fixes\Y-Link`；普通分支 `codex/architecture-review-fixes`，HEAD `88c98de308922175e07eee59333ff4b83b155664`。
- Node 22.13.1 / npm 10.9.2；两次 npm ci 均退出 0，manifest/lockfile 未改。
- 新建归属实例 `ylink-arch-1793309398169`，实际 MySQL 8.4.10，仅绑定 127.0.0.1:11924；专项随机库、既有并发入口专用库均只在该实例运行。删除前仅剩四个系统库；容器及其匿名卷已删除。
- 原始冻结全快照为 `e91b38d1027394fa5e8232177287ef22ea316cbb2fd92602c7a3aea05efd9567`；运行中仅改库存专项夹具/调度，最终 10 个代码文件加 4 个依赖清单的内容集合哈希为 `0af601970a7310b1654ce9616e09252863852c84a8fda97626eba7e7689bc178`，逐文件记录见 `logs/07b-inventory-mysql.manifest.json`。
- 7 个生产文件、鉴权/统计专项及依赖/环境未变，因此其有效通过结果复用；只重跑受影响库存专项。之后本报告、计划、52 的状态更新不在这些 runtime 检查覆盖范围内，不使运行通过结果失效。最终全部 15 文件快照在文档落盘后另行计算回报，不写回本报告，避免自引用。

## 实际命令与原始日志

日志最终目录：`backend/data/verify-architecture-review-fixes-1793309398169/logs`（相对仓库根，本地忽略目录）；每个文件保存命令、工作目录、退出码和原始输出，`results.jsonl` 保留全部运行，包括失败。
历史路径 `F:\Y-Link\.tmp-architecture-review-fixes\acceptance-1793309398169\logs` 原样映射到最终目录；日志内部旧绝对路径不改写，归档时逐文件核对 SHA256，见 `archive-verification.json`。原任务 ASCII 临时数据、junction 和容器按归属清理，不清理原仓其他内容。

除特别说明，npm 命令在根目录执行，三个 node 专项命令在 backend 执行；MySQL 模式使用各专项专用参数与显式测试实例确认，参数名见脚本头，不在报告保存密码或 Token。

| 实际命令 | exit | 日志文件 | 说明 |
| --- | --- | --- | --- |
| `npm --prefix backend run build` | 0 | `01-backend-build.log` | 通过 |
| `node --import tsx scripts/auth-activity-throttle-verify.ts` | 0 | `02-auth-sqlite.log` | 通过 |
| `node --import tsx scripts/auth-activity-throttle-verify.ts` | 0 | `03-auth-mysql.log` | 通过 |
| `node --import tsx scripts/reporting-query-performance-verify.ts` | 0 | `04-reporting-sqlite.log` | 通过 |
| `node --import tsx scripts/o2o-inventory-persistence-verify.ts` | 1 | `06-inventory-sqlite.log` | 新增 pending 公开申请夹具错误；修订后 06b/06c 通过 |
| `node --import tsx scripts/reporting-query-performance-verify.ts --mysql` | 0 | `05-reporting-mysql.log` | 通过 |
| `npm --prefix backend run o2o:verify` | 0 | `08-o2o-existing.log` | 通过 |
| `npm --prefix backend run o2o:stock-consistency:verify` | 0 | `09-o2o-stock.log` | 通过 |
| `npm --prefix backend run inventory:location-stock:verify` | 0 | `10-location-stock.log` | 通过 |
| `npm --prefix backend run order:inventory:verify` | 1 | `11-order-inventory.log` | 基线旧静态断言失败；保持未修改，11b 提供真实手工库存替代覆盖 |
| `npm --prefix backend run dashboard:analytics:verify` | 0 | `12-dashboard.log` | 通过 |
| `npm --prefix backend run reports:contract:verify` | 0 | `13-reports-contract.log` | 通过 |
| `npm --prefix backend run reports:inventory:verify` | 0 | `14-reports-inventory.log` | 通过 |
| `npm --prefix backend run security:hardening:verify` | 0 | `15-security-hardening.log` | 通过 |
| `npm --prefix backend run security:auth-depth:verify` | 0 | `16-security-auth-depth.log` | 通过 |
| `npm --prefix backend run security:auth-sse-final:verify` | 0 | `17-security-auth-sse.log` | 通过 |
| `npm --prefix backend run task2:route-contract:verify` | 0 | `18-route-contract.log` | 通过 |
| `node --import tsx scripts/o2o-inventory-persistence-verify.ts` | 0 | `06b-inventory-sqlite.log` | 通过 |
| `node --import tsx scripts/o2o-inventory-persistence-verify.ts` | 1 | `07-inventory-mysql.log` | pending 交错的 B 新插入被 A 范围锁阻断；诊断后只修测试调度，07b 通过 |
| `npm --prefix backend run verify:db:concurrency` | 0 | `19-db-concurrency.log` | 通过 |
| `npm run verify:performance` | 1 | `20-performance.log` | 首次冷启动 3184.28ms > 3000ms；根构建及构建预算已通过 |
| `node scripts/verify-enterprise-core-paths.mjs` | 0 | `20b-core-paths.log` | 唯一失败阶段复跑通过，冷启动 2808.82ms；未改预算 |
| `node scripts/verify-client-concurrency-performance.mjs` | 0 | `20c-client-concurrency.log` | 原套件未执行阶段，实际执行一次 |
| `node --import tsx scripts/task6-client-core-flow-verify.ts` | 0 | `20d-client-core-flow.log` | 原套件未执行阶段，实际执行一次 |
| `node scripts/verify-enterprise-dual-budget-report.mjs` | 0 | `20e-dual-budget.log` | 最终双预算汇总通过；不把首次套件 exit=1 改写为 exit=0 |
| `npm --prefix backend run order:content-edit:verify` | 0 | `11b-order-content-edit.log` | 必要替代：真实创建扣库、差额编辑、流水、审计故障回滚 |
| `node --import tsx scripts/o2o-inventory-persistence-verify.ts` | 0 | `06c-inventory-sqlite.log` | 通过 |
| `node --import tsx scripts/o2o-inventory-persistence-verify.ts` | 0 | `07b-inventory-mysql.log` | 通过 |
| `npm run verify:text-encoding` | 0 | `21a-text-encoding.log` | 通过 |

最终中文文档落盘后的编码复核输出为 `21b-text-encoding.log`；最终 `git diff --check` 输出为 `22-diff-check.log`，实际退出状态同时保存在 `results.jsonl`。准备命令、代码清单和资源清理记录随原始日志保留。

## 失败、替代与限制

- 库存专项首次 SQLite 失败为新增测试前提错误，不放开 pending 公共退货规则；MySQL 首次 1205 为强制门闩与 next-key 锁调度不相容。保留 `06-inventory-sqlite.log`、`07-inventory-mysql.log` 和 `07-lock-diagnostic.json`。后者是最小同索引 InnoDB 诊断：A supremum X 锁、B INSERT_INTENTION 等待，释放 A 后 B 完成，不是生产死锁事故证据。最终 06c/07b 均退出 0。
- `order:inventory:verify` 的 `findStockShortage()` 静态断言与当前按需加载的 `prepareOrderSubmission` 路径不符。脚本及两个前端文件与 origin/main 内容哈希一致；保留基线失败，不改前端、不删断言。已过的 `inventory:location-stock:verify` 覆盖共享 ledger/helper 的真实分库位扣减，必要替代 `order:content-edit:verify` 覆盖手工服务创建扣库、差额编辑、流水与回滚。不能将原失败命令记为通过。
- `verify:performance` 首次整体退出 1，根 build/构建预算通过；管理端冷启动 3184.28ms 超出 3000ms。仅失败阶段复跑一次，2808.82ms，通过；继续尚未执行的三个阶段，最终双预算通过。首次/复验报告分别保存在 `performance-first`、`performance-final`，未重跑根 build 或修改预算。冷启动仍接近门槛，不能由一次复验推出稳定时延保证。
- 构建预算：总产物 4718.65/4740KB，首屏依赖图 1188.4/1195KB；实际 12000 单统计专项返回一个非空桶，并覆盖上海与纽约 DST。独立 MySQL 压力与性能计时串行。
- 索引候选仍需代表性数据下 EXPLAIN/选择性/负载证据；本批没有增删索引、改 schema、改变 contains/来源子单搜索或引入分布式库存。
