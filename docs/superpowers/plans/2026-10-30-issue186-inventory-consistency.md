# Issue #186 库存一致性修复计划

## 合同与基线

- 沿用 PR #191、普通分支 `codex/architecture-review-fixes`，本批基线为 `66b159039885ec6c7202c4dace76ee00913adfe0`。
- 风险 P1，唯一实现、集成与统一验收负责人为本工程执行体；主线裁决风险并安排本批新增 diff 的独立审查。
- 三项均已由代码路径确认；本批已在隔离 MySQL 8.4.10 / REPEATABLE READ 真实复现旧 `save()` 负对照，并通过修复后的服务交错、库位与历史 SKU 回归，不复用上一批结果代替本批实证。
- 保持 schema、依赖、默认隔离级别、业务 API、权限与状态协议；不改原仓无关内容、AGENTS、workflow 凭据边界或 Sonar 阈值/排除规则。原 15 文件导出的 diff/txt 保留原样，另记本批增量证据。

## 原始证据与最小设计

以下原始代码位置基于本批基线 `66b1590`；最终实现与原始运行日志见本批增量记录。

1. 入库核验在 `inbound.service.ts:1268` 普通读取明细，之后锁商品/SKU，`:1351-1352` 仍以 `save()` 写库存；已入库删除在 `:790/:832` 普通读后，`:939-942` 循环 save 并规整库位。保留总量、现货/预占、原始流水、角色、确认单号、密码及单据状态校验。逐明细按现有稳定顺序在内存递推商品/SKU 与流水快照，最后复用 `persistLockedInventoryStocks` 仅写 `currentStock`；冲销一次调用 transitions，逐明细归属扣减库位备注。审计字段与事务边界保留。
2. `inventory-master-data.service.ts:309` 在商品锁前普通读 SKU；`:528` 用普通分布读校验 `expectedFromQty`。`sku-location-stock.service.ts:102` 固定普通读取分布，`:226` upsert 仍以快照判断旧行/缺行。新增显式写事务当前读选项，默认仍为普通只读；拨转、单条/批量 assign/remove、切主库位的分布及基线计算统一采用锁内当前行，upsert 查询加锁。`readSkuLocationQty` 已使用锁定读，保留它的当前读性质，修复其后 upsert 的旧快照缺口；直接指定库位调账同时覆盖。列表/详情 GET 不获得写锁。
3. `o2o-preorder.service.ts:4566-4568` 未拒绝缺失 SKU，`:4605-4610` verified 来源退货无条件增加商品。库存写入前明确拒绝 null、非空但不存在及跨商品 SKU，返回 409，整单无部分生效。历史 SKU 实体仍存在且停用/退役时允许合法退货，复用 `skuContributesToProductAggregate`：SKU 正常回补，只有 current 且 active 的 SKU 才增加商品汇总；流水同时保留商品与 SKU 前后值。

兼容影响：明细 SKU 列 nullable 与 ON DELETE SET NULL 继续支持旧单只读及历史留存；这不授予缺失 SKU 的退货库存写入能力。本批收紧的是退货核销写入门禁，不推断默认 SKU，不迁移历史数据，不改其他历史无 SKU 核销规则。

## 唯一写入范围

- 生产：`backend/src/services/inbound.service.ts`、`inventory-master-data.service.ts`、`sku-location-stock.service.ts`、`o2o-preorder.service.ts`。
- `inventory-ledger.service.ts` 只复用现有导出，不修改；若需要改其职责或公共接口，先报主线。
- 新专项：`backend/scripts/issue186-inventory-consistency-verify.ts`，SQLite 默认模式和明确门禁的 MySQL 8.4 模式。
- QA 定向修正：`backend/scripts/inbound-verified-delete-verify.ts` 的重复 SKU 冲销断言块，按原明细检查两条连续流水、预占及引用/操作者/备注；不把生产行为改回聚合流水。
- 覆盖率：`scripts/run-coverage-report.mjs` 的后端清单纳入新专项，不扩大排除。
- 文档：本计划、`docs/reviews/2026-10-30-issue186-inventory-consistency.md`，及 project-context 的 23/25/32/44/52，仅同步实际行为与验收。

## 必须保持的不变量

- 商品汇总只计 current 且 active 的 SKU；现货非负、预占约束、主库位倒算、先主库位后按编码扣其他库位均保持。
- 拨转只搬件数，总现货与预占不变，不新增库存流水；现有 `expectedFromQty`/主库位基线冲突返回 409，审计只反映实际变更。
- 每条库存明细的 before/after 连续，重复 SKU 不合并掉流水或备注；元数据不随库存实体旧快照回写。
- 库存、库位、订单/退货状态、流水和事务内成功审计共同提交或回滚；幂等与重复操作门禁保留。

## 批次节奏与验收

- [x] 一次完成实现、必要专项和文档，冻结新增 diff 与内容 hash；开发中未运行业务测试、build 或 coverage。
- [x] 新增 diff 及直接调用链完整独立深审 1 次，无阻塞；QA 旧断言修正及原失败/修后通过证据定向闭环 1 次，无阻塞。旧批次的 1+1 记录保留，未重新全审原 PR。
- [x] 新专项 SQLite 与真实隔离 MySQL 8.4.10：入库旧快照 10、另一真实事务出库至 9、入库目标 10；冲销旧快照 10、另一真实事务补至 11、冲销目标 10。负对照及修复后交错均有实际日志。
- [x] MySQL 拨转 A=10/B=5，第一笔拨 2 后为 8/7，第二笔旧 `expectedFromQty=10` 返回 409；旧行/缺行、指定库位调整、assign/remove/切主库位及 GET 只读通过。
- [x] 历史停用、退役、当前 SKU 混合退货；商品/SKU 流水口径、重复门禁、null/失效/跨商品、坏第二项及审计失败整单回滚通过。
- [x] `inventory:location-stock:verify`、`o2o:stock-consistency:verify`、`inventory:location-sku:verify` 通过。`inbound:verified-delete:verify` 首次因旧聚合流水断言失败，授权定向修正后同命令单次重跑通过；原失败保留，不归为基线失败。
- [x] 根/后端 build 各由主线单次执行 exit0，直接共享原始日志；完整 `npm run coverage:report` exit0，纳入新专项及原三专项。dot 输出未呈现逐场景完成信息，因此按约定仅各补一次新专项及原 O2O 专项的 SQLite 模式，均 exit0。

最终 `npm run verify:text-encoding` 与 `git diff --check` 在三份状态文档最终落盘后各执行一次，真实 exit 和日志存于本批忽略证据目录的 `final-checks.json`，本文不预记尚未执行结果。

本批是现有事务内的局部正确性修复与现成 helper 复用，不调整入口、装配、依赖或职责边界，未重跑完整 performance；根 build 只执行一次。新专项实际 SQL 断言证明三明细/两 SKU 的入库与冲销各写商品 1 次、SKU 2 次，冲销库位行只查询 1 次，逐明细快照和备注保持。

MySQL 仅使用自有实例与随机库，SQLite 使用自有 ASCII 随机目录。已核对 owner 并清理容器/匿名卷、四个临时 junction、ASCII 子目录与加密临时凭据；日志与最终 LCOV 保留在 `backend/data/verify-issue186-1793320096394`，不改 ignore。最终范围 14 文件：原 6 文件代码集合未变，新增旧入库回归脚本单独记录测试 hash；最终完整快照在状态文档落盘后生成，避免自引用。

提交、正常推送与 PR 更新在统一验收后按主线明确发布信号执行；本批不合并，不另建 PR 或发表评论。Issue #186 实际开发时 In progress，推送审查时 In review，合并前保持开放。
