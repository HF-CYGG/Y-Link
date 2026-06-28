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
- SKU 处理重点：
  - 若未显式传 `skus`，会回退到默认规格逻辑
  - 同一产品下 `skuCode` 和 `specText` 不能重复
  - 删除旧 SKU 时不会直接物理删，而是可能转为失活

## 关键状态/字段/快照

- 产品主记录会聚合 SKU 库存：`currentStock`、`preOrderedStock`。
- SKU 关键字段：`skuCode`、`specText`、`specValuesJson`、`defaultPrice`、`discountRate`、`thumbnail`、`o2oRecommended`、`sortOrder`。
- 若只有一个默认 SKU，产品与 SKU 会做双向同步，避免主记录和默认 SKU 口径分裂。
- 标签关系通过中间关联表维护，不是产品表内简单字符串。

## 权限与安全边界

- 查看通常依赖 `products:view`、`tags:view`。
- 管理产品和标签依赖 `products:manage`、`tags:manage`。
- SKU/标签修改会影响客户端展示和 O2O 下单口径，因此即便是“前端展示优化”也必须当成业务配置改动处理。

## 常见异常与排查顺序

1. 产品总库存不对：先查 SKU 聚合逻辑，而不是只看主产品表字段。
2. 默认规格价格不对：查默认 SKU 与产品主记录同步逻辑。
3. 某 SKU 在商城不显示：查 `isActive`、`o2oRecommended`、缩略图和排序字段。
4. 标签筛选或标签销量报表异常：查标签关系表和报表侧标签映射。
5. 修改 SKU 后历史订单价格变了：说明页面误用了实时价格而不是订单快照。

## 验证与回归关注点

- 产品修改后至少回归：产品列表、详情、SKU 展示、标签展示、库存总量、O2O 商品页。
- 涉及折扣价格时同时回归：管理端商品视图、客户端商城、购物车、订单详情。
- 批量更新或导入后回归：SKU 去重、默认规格、缩略图、排序和总库存聚合。
