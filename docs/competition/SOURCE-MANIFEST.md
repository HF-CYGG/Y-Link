# 源码包清单与导出边界

## 基线

- 导出来源：`origin/main`
- 固定提交：`b149f945ad4702bc56487955ac2e2a0b8e359e2a`
- 导出方式：从该提交的 Git 对象建立白名单目录，不从当前工作树复制业务文件。

## 白名单

| 类别 | 纳入路径或文件 |
| --- | --- |
| 根配置 | `README.md`、`LICENSE*`、`package.json`、`package-lock.json`、`tsconfig*.json`、`vite.config.*` |
| Web 前端 | `src/**`、`public/**` |
| 后端 | `backend/src/**`、`backend/sql/**`、`backend/scripts/**`、`backend/package*.json`、`backend/tsconfig*.json` |
| 部署 | `Dockerfile*`、`compose*.yml`、`docker/**`、`.env.onebox.example`、`.env.docker*.example` |
| 验证与共享包 | `scripts/**`、`packages/api-client/**`、`packages/design-tokens/**`、`packages/domain/**`、`packages/shared-types/**`、`packages/validation/**` |
| 保留的仓库目录 | `apps/mobile/**`；仅随源码保留，不属于本届参赛功能，未参与构建和验收 |
| 包内说明 | `COMPETITION_SCOPE.md`、`SOURCE-MANIFEST.md`、`OPEN_SOURCE_AND_LICENSES.md` |

如基线中存在完成运行所需的同级锁文件或配置文件，只能在核对其不含私密值后加入白名单。

## 排除模式

`/.git/**`、`/.agents/**`、`/.codex*/**`、`/.trae/**`、`/.github/**`、`**/.env`、`**/.env.*`（白名单中的 `*.example` 除外）、`**/node_modules/**`、`**/dist/**`、`**/coverage/**`、`**/*.log`、`**/*.sqlite`、`**/*.sqlite-*`、`**/*.db`、`**/uploads/**`、`**/data/**`、`output/**`、附件目录、录屏素材、临时演示数据工具、缓存和操作系统元数据。

## 打包后检查

1. 解压 ZIP 到临时目录，核对白名单、文件数量、体积和 SHA-256。
2. 在解压目录扫描私密配置、令牌、Cookie、连接串、生产地址、数据库文件和上传文件；扫描结果只记录“通过/发现文件路径”，不输出疑似值。
3. 检查 `COMPETITION_SCOPE.md` 已写明 `apps/mobile` 的保留原因和非参赛边界。
4. 确认源码 ZIP、清单和许可说明中没有生产账号信息；生产凭据只允许存在于最终私有软件使用说明书 DOCX。
