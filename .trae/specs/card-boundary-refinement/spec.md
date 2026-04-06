# Card Boundary & Hierarchy Refinement Spec (V2.2)

## Why
在亮色模式下，当前页面的“嵌套卡片”设计（大白板套小白板，如 DashboardView 中外层大白卡套内层小白卡）导致了视觉上的“白色溢出”。内层卡片与外层容器颜色过于接近，缺乏对比度，且阴影扩散后导致层级模糊。这种“边界感不强”会引起用户的视觉疲劳，无法一眼分辨出不同功能区域的界限。

## What Changes
- **消除“大白板套小白板”的过度嵌套**：
  - 移除 DashboardView 最外层的白色大卡片容器背景（`bg-white`），让其直接与底层灰色画布（`#eff1f5`）接触。
  - 保留内部各个小 Widget（今日数据、快捷操作、近期动态）作为独立的 `.apple-card`，让它们直接悬浮在灰色底层画布上。
- **调整 AppPageContainer 默认背景**：
  - 取消全局通用容器（`AppPageContainer.vue`）默认自带的白色背景块，仅作为排版容器存在（或者让其背景透明），将“白色卡片”的渲染权下放给具体的业务组件。
- **强化阴影与边框对比度**：
  - 修改 `style.css` 中的 `.apple-card` 阴影参数。收拢阴影的扩散半径，并增加垂直偏移，让阴影显得更加扎实而不是虚浮（例如：`shadow-[0_2px_12px_rgba(0,0,0,0.06)]`）。
  - 加深内层卡片的边框颜色（从极淡的色值调整为更清晰的浅灰色，如 `border-slate-200`），进一步勾勒物理边界。

## Impact
- Affected specs: 
  - 页面级容器的嵌套规范
  - `.apple-card` 的阴影与边框视觉参数
- Affected code:
  - `src/components/common/AppPageContainer.vue`
  - `src/views/dashboard/DashboardView.vue`
  - `src/style.css`
  - （连带检查其他业务页面如 `OrderEntryView`，确保没有发生不合理的“白套白”嵌套）

## ADDED Requirements
### Requirement: 独立悬浮的功能区域
系统 SHALL 保证各个独立的功能区块（Widget 或业务表单块）直接渲染在灰色底层画布上，而不是被一个更大的白色背景容器所包裹。

#### Scenario: 浏览 Dashboard 页面
- **WHEN** 用户处于亮色模式查看 Dashboard
- **THEN** 各个数据卡片、快捷操作区独立悬浮在 `#eff1f5` 的画布上，彼此之间通过画布的灰色留白隔开，边界清晰可见。

## MODIFIED Requirements
### Requirement: 卡片阴影与边框视觉
系统 UI 规范 MODIFIED 为：`.apple-card` 在亮色模式下的阴影应更加紧凑扎实（收拢扩散范围），边框颜色适度加深，以明确定义卡片内容的物理边界，防止视觉糊化。

## REMOVED Requirements
无。
