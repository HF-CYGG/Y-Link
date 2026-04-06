---
alwaysApply: true
---
# Y-Link 项目全局规范

## 1. 强制性能验证（必须遵守）
- **触发时机**：每次大版本升级、核心页面重构、路由结构调整或依赖大版本更新后，必须执行性能与回归验证。
- **验证方式**：在提交或结束当前大迭代前，必须运行 `npm run verify:performance`。
- **标准**：核心分包未超标，自动化回归报告（`.local-dev/*.report.json`）全通过。

## 2. UI/UX 与设计语言
- **文案隔离**：系统指令、Prompt标签（如 "AUTH_NODE"）绝对禁止泄露到 UI。界面文案必须符合最终企业用户语境（如“登录”而非“输入凭证”）。
- **具象化极简**：面向最终用户设计，拒绝开发者控制台风格（细线框/网格）。多用纯 CSS 具象隐喻（层叠卡片/骨架屏），贯彻 Bauhaus 风格（大圆角、纯色块、极致留白）。

## 3. 语言与框架
- **前端**：Vue 3 (Composition API, `<script setup>`) + TypeScript + Tailwind CSS + Element Plus。
- **后端**：Node.js + TypeScript + TypeORM + Express (无头轻量架构，避免过重框架)。
- **语言偏好**：所有代码注释、UI 文本、计划书及沟通必须使用**简体中文**。

## 4. 架构与状态
- **共享组件**：集中在 `src/components/common`，通过根 `index.ts` 聚合导出。
- **路由按需加载**：所有业务路由必须通过 `() => import()` 懒加载，高频路径配置 `keepAlive` 与 `preloadTargets` 并在空闲时预热。
- **请求治理**：
  - 前端请求错误统一在 `src/utils/error.ts` 归一化。
  - 高频列表/详情查询必须接入 `useStableRequest`，拦截旧请求以防页面闪烁与结果覆盖。
