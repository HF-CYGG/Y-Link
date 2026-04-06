# Tasks
- [x] Task 1: 升级全局 CSS 色彩对比度与过渡动画
  - [x] SubTask 1.1: 在 `src/style.css` 中插入全局选择器 `*, *::before, *::after` 的 `transition` 规则，实现 0.5s 柔和渐变。
  - [x] SubTask 1.2: 更新 `body` 的 `@apply` 规则，加深亮暗背景色（`#eff1f5` 和 `#0a0a0b`）。
  - [x] SubTask 1.3: 更新 `.apple-card` 的样式，应用更具立体感的边框色与微弱的 `rgba(0,0,0,0.05)` 弥散阴影。

- [x] Task 2: 强化 AppLayout 容器边界
  - [x] SubTask 2.1: 修改 `src/layout/AppLayout.vue` 中 `<aside>`（侧边栏）的类名，同步新的暗色背景（`bg-[#141415]`）与细微边框（`border-white/5`）。
  - [x] SubTask 2.2: 修改 `src/layout/AppLayout.vue` 中 `<header>`（顶栏）的类名，同步新的暗色背景与底边框样式。

- [x] Task 3: 重写原生亮暗切换控件
  - [x] SubTask 3.1: 在 `src/layout/AppLayout.vue` 的 `<script setup>` 中确保引入 `Sunny`, `Moon` 图标。
  - [x] SubTask 3.2: 移除原有的 `<el-switch>`。
  - [x] SubTask 3.3: 植入手写的基于 Tailwind 与 iOS 物理回弹贝塞尔曲线的 Toggle 按钮代码，并绑定 `toggleDark()` 方法。

# Task Dependencies
- Task 1, 2, 3 无强依赖，但均指向样式的像素级微调，可一次性并行修改。