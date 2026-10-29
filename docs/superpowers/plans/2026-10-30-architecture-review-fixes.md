# 架构报告核实与局部修复计划

**目标：** 在 main `88c98de308922175e07eee59333ff4b83b155664` 上修复 #182、#183、#184，保留鉴权、统计、库存的现有接口和业务语义。

**实现边界：** 沿用现有服务、事务、TypeORM 和 SQLite/MySQL；不改 schema、依赖、锁文件、AGENTS 或默认隔离级别，不重复接入 Redis，不提交、推送或创建 PR。

## 写入所有权

- 鉴权负责人：#182 的鉴权源码和专项测试。
- 统计负责人：#183 的工作台/报表源码和专项测试。
- 库存与集成负责人：#184 的 O2O 服务、必要库存 helper、`o2o-inventory-persistence-verify.ts`、`verify-db-concurrency.ts`，以及本计划、核查报告、项目上下文 52 与统一结果记录。
- 三组源码/测试不重叠，manifest/lockfile 冻结；实现期间不运行测试/build、不启动端口或使用测试库。

## 实现与不变量

- [x] #182：利用已加载的 lastAccessAt 在普通鉴权 60 秒窗口前置跳过 touch；保留数据库条件、心跳 1 秒间隔、每请求真实鉴权、撤销/停用/到期、维护态和 SSE。
- [x] #183：由服务器本地日历产生真实桶边界，在数据库按边界聚合，限制返回行数；合并同过滤 COUNT/SUM。保留 DST、空桶、366 天、金额和全量汇总语义。
- [x] #184：同根库存 save 改为显式库存列 UPDATE，元数据不回写，updatedAt 继续由 TypeORM 管理；维持商品→SKU→分库位锁序。
- [x] #184：核销在共享实体映射中逐明细累计，商品/SKU 按唯一实体落库；分库位只批量读取一次，再按原明细顺序计算扣减和逐行备注，流水快照不合并。
- [x] #184：保留下单只预占、取消只释放、核销双扣、两种来源退货、历史缺 SKU、正式单不二次扣库、CAS/幂等和失败整单回滚。
- [x] 完成源码/测试后形成完整 diff 与新文件哈希，交主线安排一次独立完整深审，集中修复已裁决问题。

## 统一验收（已按必要范围执行）

唯一执行负责人为库存/集成负责人；所有组冻结源码后执行，主线裁决结果。复用相同源码快照与环境的有效结果。

- [x] 后端构建：`npm --prefix backend run build`。
- [x] 编码：`npm run verify:text-encoding`。
- [x] 鉴权/统计：backend 目录分别运行 `node --import tsx scripts/auth-activity-throttle-verify.ts`、`node --import tsx scripts/reporting-query-performance-verify.ts`，并运行各自专用门禁参数下的真实 MySQL 模式；保留仓库权限、路由和安全门禁。
- [x] O2O：`npm --prefix backend run o2o:verify`、`o2o:stock-consistency:verify`、`inventory:location-stock:verify`，以及 `node --import tsx scripts/o2o-inventory-persistence-verify.ts`（backend 目录）。
- [x] 共享库位 helper 直接回归：`npm --prefix backend run order:inventory:verify`；原静态契约基线失败保留，按主线裁决运行 `order:content-edit:verify` 替代真实手工链路覆盖。
- [x] MySQL：`npm --prefix backend run verify:db:concurrency`，以及新增库存专项的受控 MySQL 模式；要求独立 MySQL 8.4、任务容器/随机库归属明确，绝不连接业务库。
- [x] 库存场景：RR 建立旧快照→另一事务提交变化→锁定当前值→目标恰等于旧快照；多商品反序、同商品多 SKU/重复明细、旧记录缺 SKU、各入口、库位备注、元数据/updatedAt、重复动作及中途故障回滚。
- [x] 性能：`npm run verify:performance`；其已包含根 build，保留该阶段完整通过证据后不重复根 build。性能计时与 MySQL 压测串行执行。
- [x] 失败后只重跑失败项及直接受影响回归；至多一次原 finding 定向复核，不追加全面审查。

## 环境与证据

- 工作目录：`C:\Users\闫奕衡\.codex\worktrees\architecture-review-fixes\Y-Link`；分支 `codex/architecture-review-fixes`。
- Node 22.13.1 / npm 10.9.2；根和 backend 的 `npm ci --prefer-offline --no-audit --no-fund` 分别退出 0，安装 274/435 包；未复制环境文件或业务数据。
- 根锁 SHA256：`C7D63D5398558D5BD28A3E5906E3B204B491744F8F838DBFD9F0A8677D54D0F9`；backend 锁：`F3D3BD2619778E826D1A9D9A8F973A923E26662A50832008FF99217BB5C45513`，安装前后相同。
- 原生 sparse checkout 排除 `/apps/`，本批不含 Mobile；未改检出配置。
- 沙箱内 Git 访问新目录受限，提升权限后正常；不修改全局 Git 配置。
- SQLite 测试数据使用任务专用 ASCII 根 `F:\Y-Link\.tmp-architecture-review-fixes` 下随机子目录，执行方登记归属并只清理自身产物。

实际命令/退出状态与失败、复验依据统一见 `docs/reviews/2026-10-30-gemini-architecture-review.md` 和本地忽略的原始日志目录。完整深审1/1、定向复核1/1已用完；不再加全审/全测。运行中仅库存专项测试前提经裁决修订，生产与其他专项未变，已有有效结果复用。所有 Issue 保持开放/In review，尚未提交或发布。最终中文更新后只复核编码及 diff 空白检查。
