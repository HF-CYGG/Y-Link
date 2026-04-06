# Pixel-perfect UI Refinement Spec (V2.1)

## Why
在 V2.0 重构中，我们实现了全站的 Apple 级 SaaS 质感，并接入了全局暗黑模式。但在细节体验上，亮色模式下的全局对比度仍显单薄，卡片的“浮层”边界感不够强烈；同时，原有的 Element Plus 亮暗切换开关（`el-switch`）在交互动效上缺乏类似于 macOS/iOS 的物理回弹反馈。为了达到极致的体验，需要进行一次“像素级”的 CSS 与交互重构。

## What Changes
- **全局色彩对比度与过渡动画优化**：
  - 在 `style.css` 中引入全局 CSS 属性过渡规则（`transition: ... 0.5s ease-in-out`），实现亮暗模式切换时无闪烁的“呼吸级”柔和变色。
  - 加深 `body` 亮色模式底色至 `#eff1f5`，暗色模式底色调整为纯净的 `#0a0a0b`，彻底拉开底层画布与卡片（白底/碳灰底）的对比度。
  - 增强 `.apple-card` 的边界感：亮色增加 `border-slate-200/80` 与带有细微淡蓝灰的弥散阴影 `rgba(0,0,0,0.05)`；暗色应用 `border-white/5` 营造隔离感。
- **布局容器边界强化**：
  - 调整 `AppLayout.vue` 中左侧边栏 `<aside>` 和顶部 `<header>` 的类名，同步其背景色（亮色 `bg-white`，暗色 `bg-[#141415]`）与边框色（亮色 `border-slate-200`，暗色 `border-white/5`），确保与主内容区界限分明。
- **原生丝滑亮暗切换控件重写**：
  - 废弃 `AppLayout.vue` 顶部的 `<el-switch>`。
  - 手写一个基于 Tailwind 驱动、内置 `Sunny` 与 `Moon` 图标淡入淡出逻辑的 Toggle 按钮。
  - 应用 `cubic-bezier(0.34, 1.56, 0.64, 1)`（iOS 物理回弹曲线）实现滑块切换时的丝滑手感。

## Impact
- Affected specs: 
  - 全局 CSS 变量与过渡动画规范
  - 布局容器（Header & Sidebar）的视觉层级
  - 亮暗模式切换的交互体验
- Affected code:
  - `src/style.css`
  - `src/layout/AppLayout.vue`

## ADDED Requirements
### Requirement: 亮暗切换物理回弹交互
系统 SHALL 提供具有物理回弹动效的自定义 Toggle 控件用于切换亮暗模式。

#### Scenario: 触发亮暗切换
- **WHEN** 用户点击 Header 区域的亮暗切换按钮
- **THEN** 内部滑块以 `cubic-bezier(0.34, 1.56, 0.64, 1)` 曲线滑动并产生轻微回弹，同时太阳/月亮图标分别产生缩放与透明度的平滑过渡。

## MODIFIED Requirements
### Requirement: 全局变色与卡片对比度
系统 UI 规范 MODIFIED 为：底层画布加深（亮色 `#eff1f5` / 暗色 `#0a0a0b`），卡片与容器维持高亮对比（亮色 `bg-white` / 暗色 `bg-[#141415]`），且全站元素的背景、边框、字体颜色在主题切换时必须经历 0.5s 的平滑过渡。

## REMOVED Requirements
### Requirement: 使用 Element Plus 默认 Switch 控件切换主题
**Reason**: 默认控件缺乏极致的物理交互动效反馈。  
**Migration**: 替换为手写的 Tailwind 动效 Toggle 按钮。