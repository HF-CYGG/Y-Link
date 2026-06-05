---
name: "ylink-ui-regression-guard"
description: "Fixes Y-Link UI regressions by frontend structure. Invoke when admin or client layouts flicker, overlap, shift, or become unusable on phone and desktop."
---

# Y-Link UI Regression Guard

## 目标
- 覆盖 `Y-Link` 前端结构中的主要 UI 区域，而不是只聚焦最近出现过的某个弹窗或扫码页。
- 专门处理管理端、客户端、共享组件、切页过渡、移动端适配相关的界面回归。

## 何时使用
- 用户反馈以下任一现象：
  - 页面切换闪动、重影、错位
  - 底部导航异常下移
  - 扫码框过大/过小
  - 弹窗内容显示不完整
  - PC 与移动端布局不一致
  - 表格、抽屉、详情卡、工作台在手机端不可用

## 前端结构覆盖
### 1. 管理端布局
- `src/layout/**`
- `src/components/common/page-container/**`
- `src/components/common/page-shared/**`
- `src/components/common/business-composite/**`

### 2. 客户端布局
- `src/views/client/components/ClientMainLayout.vue`
- `src/views/client/components/ClientShell.vue`
- `src/views/client/*.vue`

### 3. 业务页面
- `src/views/dashboard/**`
- `src/views/order-entry/**`
- `src/views/order-list/**`
- `src/views/inbound/**`
- `src/views/o2o/**`
- `src/views/base-data/**`
- `src/views/system/**`

### 4. 共享样式与交互
- `src/style.css`
- `src/composables/useDevice.ts`
- `src/composables/useCameraQrScanner.ts`
- `src/components/common/page-shared/UnifiedScanDialog.vue`

## 优先检查点
### 页面切换
- `router-view`
- `transition`
- `absolute / fixed` 定位
- `z-index`
- `overflow`
- `keepAlive`

### 移动端
- `100vh / 100dvh`
- `safe-area-inset-bottom`
- `aspect-ratio`
- `position: fixed`
- 滚动容器是否双层嵌套

### 弹窗与扫码
- 视觉舞台是否稳定
- 说明区与操作区是否挤压
- 扫码识别框是否与视觉卡片同步

## 项目特定原则
- 优先做“布局根因修复”，不要只靠魔法数字硬压。
- 先保证结构稳定，再微调尺寸。
- PC 与移动端都要可用，但手机可用性优先。
- 对于切页异常：
  - 优先建立稳定的页面舞台容器
  - 让过渡页脱离正常文档流
- 对于扫码卡片：
  - 视觉舞台、识别框、说明区必须一起调

## 验证要求
- 修改后至少执行：
  - `npm run build`
- 同时检查：
  - 最近修改文件 diagnostics
  - 是否出现新的对比度、布局或类型警告

## 输出要求
- 先说根因，不先给参数试错结论。
- 明确说明：
  - 改了哪个布局容器
  - 改了哪个过渡逻辑
  - 改了哪些移动端约束
  - 是否影响管理端、客户端或共享组件

## 示例
- “客户端底部导航切页时瞬间下移”
- “扫码窗口太大，边界利用率低”
- “弹窗在手机端看不全”
- “订单查询页在窄屏下操作区错位”
