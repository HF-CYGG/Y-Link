# Y-Link 文创出库管理系统 V1.0 Spec

## Why
当前“野藏文创”出库流程依赖纸质单据，存在录入效率低、核对成本高、数据难追溯的问题。需要通过 Web 端数字化系统实现整单高效录入、标准化编号与可扩展的数据底座，支撑后续 SaaS 化演进。

## What Changes
- 新增“出库开单”核心能力：整单录入、行级自动计算、整单汇总、一次性提交。
- 新增“双轨编号”能力：系统 UUID（order_uuid）与业务展示单号（show_no）并行生成与存储。
- 新增“产品+标签”基础资料能力：产品维护、标签维护、产品标签多对多关联。
- 新增“标签过滤+拼音检索”能力：开单时按标签过滤产品，并支持拼音首字母模糊匹配。
- 新增“PC/移动多态视图”：PC DataGrid 高密度录入，移动端卡片列表 + 抽屉编辑。
- 新增“键盘流录入体验”：Tab 连续切换、末行 Enter 自动增行并聚焦。
- 新增“交互防错与反馈”：骨架屏、保存 Loading、防重复提交、空状态插画、删除动效。
- 新增“主子表事务提交”后端规范：主表插入、子表批量插入、失败全回滚。
- 新增数据库 4+1 表结构：出库主表、明细表、产品表、标签表、产品标签关系表。

## Impact
- Affected specs:
  - 出库开单与计算能力
  - 出库单编号规则能力
  - 产品标签化管理能力
  - 多端响应式交互能力
  - 主子表事务一致性能力
- Affected code:
  - 前端：src/views/order-entry、src/views/order-list、src/views/base-data、src/components、src/composables、src/api、src/store
  - 后端：出库单控制器/服务/仓储层、产品与标签管理接口、事务提交逻辑、编号生成器
  - 数据库：biz_outbound_order、biz_outbound_order_item、base_product、base_tag、rel_product_tag
  - 部署：Nginx 反向代理配置、Docker 化部署脚本
