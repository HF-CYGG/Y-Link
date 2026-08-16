# Mobile Shared Package Consumption Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `apps/mobile` 通过单一、可复现的 npm workspace 依赖模型正式消费 `@ylink/shared-types` 与 `@ylink/api-client`，并为其余共享包保留同样的接入路径。

**Architecture:** 根 `package.json` 声明 `apps/mobile` 与 `packages/*` workspaces，仓库只保留根 `package-lock.json`。开发者、GitHub Actions 与 EAS 都从同一根依赖图安装；Mobile 仍从 `apps/mobile` 运行 Expo/EAS 命令，Metro 使用 Expo SDK 57 的自动 monorepo 解析，不新增手写 watch folder 或别名。

**Tech Stack:** npm workspaces、Node.js 22.13.1、Expo SDK 57、React Native 0.86、TypeScript、GitHub Actions、EAS Build。

## Global Constraints

- 不实现 Mobile Auth、token/session、Server Cart、真实 API、订单 mutation 或 UI 改造。
- 不修改后端业务代码、数据库、接口或现有 Web 请求行为。
- 不新增第三方依赖；只把现有仓库包纳入正式 workspace 依赖图。
- `apps/mobile/package-lock.json` 不再作为第二套依赖真源；三种环境统一使用根 `package-lock.json`。
- EAS 配置不增加 project ID、包名、签名、凭据或发布动作。

---

### Task 1: 建立可回归的 workspace 契约验证

**Files:**
- Create: `scripts/verify-mobile-workspace.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: 根、Mobile 与共享包 manifests，以及根 lockfile。
- Produces: `npm run verify:mobile:workspace`，验证单 lockfile、workspace 声明、正式包依赖和锁文件链接。

- [x] **Step 1: 先写验证脚本，断言目标依赖模型**
- [x] **Step 2: 在当前结构运行并确认因缺少 workspaces/正式依赖而失败**
- [x] **Step 3: 保留失败证据，进入最小配置实现**

### Task 2: 统一 npm workspace 与包身份

**Files:**
- Modify: `package.json`
- Modify: `apps/mobile/package.json`
- Delete: `apps/mobile/package-lock.json`
- Delete: `apps/mobile/.npmrc`
- Modify: `packages/api-client/package.json`
- Modify: `packages/shared-types/package.json`
- Modify: `packages/domain/package.json`
- Modify: `packages/validation/package.json`
- Modify: `packages/design-tokens/package.json`
- Modify: `packages/tsconfig.json`
- Modify: `packages/api-client/src/modules/*.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: 现有五个私有共享包与 Mobile Expo manifest。
- Produces: `@ylink/*` workspace 包名、Mobile 对 `shared-types`/`api-client` 的直接依赖，以及 `api-client` 对 `shared-types` 的显式依赖。

- [x] **Step 1: 根 manifest 声明 `apps/mobile` 与 `packages/*` workspaces，并迁移 npm overrides**
- [x] **Step 2: Mobile 移除 `y-link: file:../..`，添加两个 `@ylink/*: "*"` 依赖**
- [x] **Step 3: 统一五个共享包 scope，并修正 api-client import 与依赖声明**
- [x] **Step 4: 生成唯一根 lockfile，移除 Mobile lockfile 与被 npm workspace 忽略的嵌套 `.npmrc`**
- [x] **Step 5: 运行 workspace 验证脚本并确认通过**

### Task 3: 对齐 CI、Docker 与 EAS 入口

**Files:**
- Modify: `.github/workflows/mobile-check.yml`
- Modify: `Dockerfile`
- Modify: `Dockerfile.onebox`
- Modify: `apps/mobile/eas.json`

**Interfaces:**
- Consumes: 根 workspace 与根 lockfile。
- Produces: GitHub 两个 job 均执行根 `npm ci`，Web Docker 显式忽略 workspaces，EAS profiles 固定 Node 22.13.1。

- [x] **Step 1: Mobile CI cache/install 改为根 lockfile 与根 `npm ci`**
- [x] **Step 2: CI 使用 npm workspace 命令执行 Mobile 检查并新增 workspace 契约门禁**
- [x] **Step 3: 两个前端 Docker build stage 使用 `npm ci --workspaces=false`，保持 Web 镜像不安装 Mobile 依赖**
- [x] **Step 4: EAS profiles 明确 Node 22.13.1，不加入凭据或发布配置**

### Task 4: 更新工程文档

**Files:**
- Modify: `MASTER_PLAN.md`
- Modify: `AGENTS.codex.md`
- Modify: `AGENTS.antigravity.md`
- Modify: `README.md`
- Modify: `apps/mobile/README.md`
- Modify: `docs/project-context/00-项目总览与阅读索引.md`
- Modify: `docs/project-context/60-移动端工程与共享基础.md`
- Modify: `docs/project-context/61-Mobile-API-Contract.md`

**Interfaces:**
- Consumes: 已验证的唯一依赖模型。
- Produces: 开发者、CI、EAS 一致的安装/运行说明，以及仍未开始 Auth/真实 API 的边界声明。

- [x] **Step 1: 删除“独立 Mobile lockfile/不得根安装”的旧口径**
- [x] **Step 2: 写明根 `npm ci`、`npm --workspace y-link-mobile ...` 与 `cd apps/mobile && eas build` 入口**
- [x] **Step 3: 写明 `domain`/`validation`/`design-tokens` 只是可接入 workspace，尚未由 Mobile 消费**

### Task 5: Clean install 与全量验证

**Files:**
- Verify only.

**Interfaces:**
- Consumes: 完整变更集。
- Produces: 开发者 clean clone、GitHub CI 命令与 Expo/EAS 入口共用同一依赖图的证据。

- [x] **Step 1: 在当前 worktree 执行根 `npm ci` 与 workspace 契约验证**
- [x] **Step 2: 运行 shared packages typecheck/api-client tests**
- [x] **Step 3: 运行 Mobile dependencies check、SQLite test、typecheck、Android export**
- [x] **Step 4: 运行 Web build、Docker frontend/onebox build 与 `git diff --check`**
- [x] **Step 5: 从当前 HEAD 加应用后的 Git tree 导出全新临时目录，执行根 clean `npm ci`、workspace 验证、Mobile typecheck/export，并清理临时目录**
- [x] **Step 6: 检查 diff、敏感信息、lockfile 唯一性与未越界项后交付，不提交、不推送、不创建 PR**
