# Issue #186 库存一致性增量记录

基线：PR #191 / `codex/architecture-review-fixes` / `66b159039885ec6c7202c4dace76ee00913adfe0`。本记录只覆盖 #186 新增 diff，原架构批次与覆盖率接入的证据保持原样。

## 核实与修复

- 入库核验及已入库删除：普通明细/流水读取先建立 RR 快照，锁内库存原以 `save()` 写入，存在目标等于旧快照时跳过库存列的路径。复用现有 helper，仅对 `currentStock` 显式 UPDATE；逐明细内存递推与流水，唯一实体最后写入。冲销一次 transitions 保留重复 SKU 各明细的库位备注，审计的原有按 SKU 汇总字段保持。
- 库位：普通分布读和 upsert 的普通行查询混入锁定读流程，可能使旧基线通过、按旧数量覆盖。写路径明确请求当前分布，upsert 的旧行/缺行查询加锁；`readSkuLocationQty` 已是当前读，保持。默认列表/详情仍普通只读，不改变公开入参或 409 协议。
- 退货：原 verified 分支无条件增加商品，缺失 SKU 可静默只改商品。新增 null、查无、跨商品 SKU 的 409 门禁；合法历史 SKU 允许退货，按 `skuContributesToProductAggregate` 决定商品贡献，流水分别保留商品/SKU 前后值。

兼容影响：nullable/ON DELETE SET NULL 与旧单只读保持，缺失 SKU 的退货库存写入收紧为 409；不猜默认 SKU，不迁移旧记录，不改变其他历史无 SKU 取货核销兼容。非空孤儿负例仅在本次随机库专用连接暂时关闭并立即恢复 FK 检查，用于构造历史坏数据，不影响生产保护。

## 验收与轮次

本批新增 diff 及直接调用链完整独立深审 1 次，QA 旧入库断言修正及原失败/通过证据定向闭环 1 次，主线均裁决无阻塞；原批次 1+1 记录不变。本批不再追加审查或有效检查。

实际增量为 4 个生产 service、1 个新增专项、1 个既有回归脚本断言块、coverage 清单、23/25/32/44/52 五份上下文文档及本批 plan/记录，共 14 文件。`inventory-ledger.service.ts` 仅复用导出；manifest/lock、workflow、Sonar 阈值/排除与原始 15 文件导出件未修改。

原冻结 6 文件集合（4 个生产 service、新专项、coverage 清单）始终为 `a923a507f259f0f72baf32a8567e235b37649c3c9d77e838d08a6e72af79591b`。QA 只增加旧入库回归脚本断言修正，其 SHA-256 为 `a1b50cc0adf040c1e2895f8bd0a5b807a5bb065c84de7b509488c580419d7ce6`。02/03/04、两项构建及 coverage 覆盖的生产源码、专项、依赖、配置和环境未因该断言修正而变化；该既有脚本不在 coverage 清单中，仅其失败命令重跑。后续 plan/本记录/52 的事实更新不在运行时测试覆盖范围内，复用这些有效结果，最后补编码与 diff 检查。

## 实际命令与原始证据

证据根为本地忽略目录 `backend/data/verify-issue186-1793320096394/`；以下日志名均相对该目录，未作为远端制品发布。命令起止时间、exit、Node/npm 与快照关联保存在 `acceptance-results.jsonl`，两项共享构建来源及日志 hash 见 `build-reuse.json`。环境 Node v22.13.1、npm 10.9.2。

| 实际命令 | 结果 | 原始日志 |
| --- | --- | --- |
| `npm run build` | 主线单次执行 exit0，本 QA 未重复；有既有 chunk/plugin timing 警告 | `root-build-main.log` |
| `npm --prefix backend run build` | 主线单次执行 exit0，`tsc -p tsconfig.json` | `backend-build-main.log` |
| backend 下 `node --import tsx scripts/issue186-inventory-consistency-verify.ts --mysql` | exit0，真实 MySQL 8.4.10 / RR | `02-issue186-mysql.log` |
| `npm --prefix backend run inventory:location-stock:verify` | exit0 | `03-location-stock.log` |
| `npm --prefix backend run o2o:stock-consistency:verify` | exit0 | `04-o2o-stock.log` |
| `npm --prefix backend run inbound:verified-delete:verify` | 首次 exit1：旧断言期望 1 条聚合冲销流水，实际 2 条逐明细流水 | `05-inbound-delete.log` |
| 同上，授权修正断言后单次重跑 | exit0，保留首次失败，未修改生产语义 | `05b-inbound-delete.log` |
| `npm --prefix backend run inventory:location-sku:verify` | exit0 | `06-location-sku.log` |
| `npm run coverage:report` | exit0，新专项与原三专项均在后端执行清单；最终生成 241 个加载文件的 LCOV | `08-coverage.log` |
| backend 下 `node --import tsx scripts/issue186-inventory-consistency-verify.ts` | exit0，SQLite 逐场景证据 | `09-issue186-sqlite-case-log.log` |
| backend 下 `node --import tsx scripts/o2o-inventory-persistence-verify.ts` | exit0，SQLite 11 类原入口逐场景证据 | `10-o2o-sqlite-case-log.log` |

coverage 使用 dot 输出，未显示通过用例的逐场景完成文本，因此按已约定的最小补证分支各执行一次末两项；不是用加载文件或 MySQL 结果代替 SQLite。最终采集为 `coverage-final.lcov`、`coverage-final-backend.lcov`；报告的 34561/70053（49.3%）仅为已加载文件行率，不是 Sonar 新代码指标。首轮在 05 失败后提前复制的 `acceptance-lcov.info` / `acceptance-backend.lcov` 属于既有输出，不作为本批通过证据，完整新采集只认 08 及 `coverage-final*`。

最终 `npm run verify:text-encoding` 和 `git diff --check` 在本文、plan、52 最终落盘后执行，实际 exit 与原始日志索引存入 `final-checks.json`；本文不提前声明这两项结果。完整 14 文件快照及测试集合 hash 随后生成到 `final-snapshot.json`，不将本记录自身 hash 写回本文。

## 场景、失败分类与资源

- 真实 RR 负对照复现旧 `save()` 跳过目标等于快照的库存 UPDATE；修复后的真实服务交错中，入库 10→另一事务 9→目标 10、冲销 10→另一事务 11→目标 10 均通过。拨转第一次 10/5→8/7，第二次旧 `expectedFromQty=10` 返回 409；旧行/缺行指定库位调整、assign/remove/切主库位及 GET 无锁无写入通过。
- 三明细/两 SKU 入库及冲销实际 SQL 均断言商品 UPDATE 1 次、SKU UPDATE 2 次；冲销库位行 SELECT 1 次。商品逐条入库 20→22→23→25、冲销 25→23→22→20，SKU 与 B 库位逐条备注保持。
- current/inactive/retired 混合退货只让 current 且 active 的 SKU 贡献商品汇总；null、非空查无及跨商品 SKU 409，坏第二项和审计故障整单回滚通过。日志中的 `ISSUE186_AUDIT_FAILURE` 是预期注入的故障证据，命令 exit0。
- 05 属于“预期粒度变更后的陈旧回归断言，已定向更新”，不是基线旧失败。修订按主键排序验证原明细 2/3 对应 -2/-3、合计 -5、商品/SKU 连续快照终点回原值、预占不变、ref/supplier actor/remark；未仅修改数量，也未合并生产流水。
- 凭据模块自动加载与自动分配端口 6922 的失败为环境准备失败，未作为产品失败。改用同账户 .NET DPAPI 保护临时凭据，显式检查空闲端口 52838；未安装模块或修改全局配置，保留 `environment-initialization-history.json`、`port-recovery.json` 等原始记录。
- 自有容器 `ylink-issue186-9e67cb2e9409`，owner `9e67cb2e-9409-4aa9-b756-7ca70b374881`，仅绑定 127.0.0.1:52838，实际 `SELECT VERSION()` 为 8.4.10、隔离为 REPEATABLE-READ。随机库 `y_link_issue186_97abfec9e811499c9ce5d865148a13e1` 由专项创建并删除；删除容器前查询只剩四个系统库。已核对 ID/label 后移除容器及匿名卷。
- 已核对 owner 与绝对目标后清理四个临时 junction、自有 ASCII 子目录与加密临时凭据，不删除父目录或他人内容。清理证据为 `mysql-cleanup.json`、`filesystem-cleanup.json`；原始日志与最终 LCOV 保留。原仓分支/HEAD/五项无关未跟踪及受保护文件的收尾核对存于 `final-snapshot.json`。

## 未验证与发布状态

未执行生产负载验证，本批局部正确性修复未重跑完整性能套件；原 PR 的性能失败/定向复验历史保持。新增 diff 尚未提交或推送，不能用旧 head 的 CI/Sonar 证明本批通过；远端门禁须在后续发布后读取。schema、依赖、默认隔离、公共 API 与权限未改变。等待主线核对本批最终证据并发出发布信号，不合并、不另建 PR 或发表评论。
