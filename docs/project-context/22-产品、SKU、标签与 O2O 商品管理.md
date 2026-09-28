# Y-Link 产品、SKU、标签与 O2O 商品管理

## 适用范围

- 适用于产品中心、SKU 规格组、标签管理、库存聚合和 O2O 商品展示字段的改动与排障。
- 适用于回答“产品中心改了为什么商城展示变了、SKU 改了为什么总库存变了”的问题。

## 最后核对来源

- `src/views/product-center/*`
- `src/views/base-data/*`
- `src/api/modules/product.ts`
- `src/api/modules/tag.ts`
- `src/utils/o2o-price.ts`
- `backend/src/routes/product.routes.ts`
- `backend/src/routes/tag.routes.ts`
- `backend/src/services/product.service.ts`

## 真实入口

- 管理端页面入口：`/base-data/products`、`/base-data/tags`、`/o2o-console/products`
- 后端服务真源：`product.service.ts`、`tag.service.ts`

## 前端链路

- 产品中心与 O2O 商品管理入口共享同一页面壳层，但进入上下文不同。
- 前端既管理产品基础字段，也管理 SKU、规格组、缩略图、标签和 O2O 展示位。
- 价格显示依赖 `src/utils/o2o-price.ts`，客户端与管理端共用同一折扣口径。

## 后端链路

- `product.service.ts` 负责：
  - 产品列表、分页和详情
  - 创建、批量创建、更新、批量更新、删除
  - 标签替换
  - SKU 归一化与保存
  - 默认 SKU 与产品主记录同步
  - 产品视图构建与库存聚合
- 线上展示专用写入使用 `PATCH /api/products/:id/online-display`：仅接受 `o2oStatus`、`detailContent`、`limitPerUser` 和 `recommendation`，返回最新商品视图；不调用商品全量编辑或 SKU 替换。`recommendation.mode` 为 `all`、`selected`、`none`，必须提交打开编辑时所有当前 SKU（含停用、不含退役）的 `expectedSkuIds`；`selected.skuIds` 只允许当前启用 SKU。集合变化或推荐失效返回 409，停用商品上架也返回 409。
- 批量上下架使用 `PATCH /api/products/online-display/batch`，提交商品 ID 与 `o2oStatus`；去重后最多 100 个商品，全部锁定和校验后在同一事务内写入，返回排序后的 `ids` 和实际变更数 `updatedCount`。任一商品无效或停用商品拟上架时整批失败。
- 两个专用接口均要求 `products:manage`，Cookie 请求继承全局 CSRF 校验；按“操作账号 → 商品 → 当前 SKU”锁序写入，审计与业务写入同事务提交，提交后使商城目录缓存失效。价格、库存、条码、库位、图片、SKU 启停及退役状态均不在专用接口写入范围内。
- SKU 处理重点：
  - 若未显式传 `skus`，会回退到默认规格逻辑
  - 同一产品下 `skuCode` 和 `specText` 不能重复
  - 删除旧 SKU 时不会直接物理删，而是可能转为失活

## 关键状态/字段/快照

- 商品视图的 `currentStock`、`preOrderedStock` 只汇总当前规格矩阵中启用的 SKU；存在当前 SKU 但全部停用时汇总为 0，仅无当前 SKU（包括只剩历史 SKU）时回退商品主表字段。
- `availableStock` 统一按 `max(0, currentStock - preOrderedStock)` 计算；商品服务与库存报表复用同一纯汇总函数，报表查询不回写商品、SKU 或 `InventoryLog`。
- SKU 关键字段：`skuCode`、`specText`、`specValuesJson`、`defaultPrice`、`discountRate`、`thumbnail`、`o2oRecommended`、`sortOrder`。
- 若只有一个默认 SKU，产品与 SKU 会做双向同步，避免主记录和默认 SKU 口径分裂。
- 新手工出库只允许选择产品中心已建档、当前启用且具有当前启用 SKU 的商品；开单流程不承担商品建档或库存初始化。单 SKU 可兼容省略后自动解析，多 SKU 必须显式选择。SKU `defaultPrice` 只预填开单单价，人工覆盖不会修改 SKU 默认价；新单与后续内容编辑会按差额同步商品/SKU 库存并写可还原流水。退役 SKU 只允许在既有明细中减量或删除，不允许新增或增量。
- 标签关系通过中间关联表维护，不是产品表内简单字符串。

## 权限与安全边界

- 查看通常依赖 `products:view`、`tags:view`。
- 管理产品和标签依赖 `products:manage`、`tags:manage`。
- SKU/标签修改会影响客户端展示和 O2O 下单口径，因此即便是“前端展示优化”也必须当成业务配置改动处理。
- 商品写入口在同一事务内写审计：`product.create`/`product.batch_create`（新建摘要）、`product.update`（编码、名称、原价、折扣、启用、上架、限购及 SKU 原价/折扣/启停的前后值差异，成本价只记“是否变更”，仅改描述或图片不产生审计）、`product.batch_update`（批量启停，只列实际变化的商品）、`product.delete`。库存数量变化继续由库存流水 `manual_stock_adjust` 记录，审计不重复。Excel/YZ 导入沿用各自的汇总审计。标签写入口同样审计：`tag.create`、`tag.update`（名称、颜色码、系列码前后值，无变化不记）、`tag.delete`。

## 常见异常与排查顺序

1. 产品总库存不对：先查 SKU 聚合逻辑，而不是只看主产品表字段。
2. 默认规格价格不对：查默认 SKU 与产品主记录同步逻辑。
3. 某 SKU 在商城不显示：查 `isActive`、`o2oRecommended`、缩略图和排序字段。
4. 标签筛选或标签销量报表异常：查标签关系表和报表侧标签映射。
5. 修改 SKU 后历史订单价格变了：说明页面误用了实时价格而不是订单快照。

## 验证与回归关注点

- 产品修改后至少回归：产品列表、详情、SKU 展示、标签展示、库存总量、O2O 商品页。
- 涉及折扣价格时同时回归：管理端商品视图、客户端商城、购物车、订单详情。
- 涉及手工出库 SKU 时同时回归：桌面表格、移动抽屉、旧草稿、详情、打印/PDF 和报表规格展示，并运行 `npm --prefix backend run order:manual-sku:verify`。
- 批量更新或导入后回归：SKU 去重、默认规格、缩略图、排序和总库存聚合。
- 库存展示或汇总口径改动后运行：`npm --prefix backend run reports:inventory:verify`、`npm --prefix backend run product:sku-current:verify`、`npm --prefix backend run inventory:invariants:verify`。
