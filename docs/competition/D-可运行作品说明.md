# Y-Link——智能库存与订单协同管理系统可运行作品说明

## 运行基线与范围

源码包从 `origin/main` 的 `b149f945ad4702bc56487955ac2e2a0b8e359e2a` 导出。运行和演示范围为管理端 Web、客户端 Web/H5、供应端 Web、后端、数据库和 Docker 部署。

## 启动步骤

```powershell
Copy-Item .env.onebox.example .env
# 在私有 .env 中填写 INIT_ADMIN_PASSWORD
docker compose -f compose.onebox.yml up -d --build
docker compose -f compose.onebox.yml ps
Invoke-WebRequest http://127.0.0.1:8080/health
```

若修改了 `Y_LINK_PORT`，最后一条命令使用实际端口。`INIT_ADMIN_PASSWORD` 仅放入本地 `.env` 或部署平台密钥管理，不写入源码包。

## 验收与恢复

确认容器为健康状态，且管理端、客户端、供应端均能以本地演示账号登录。录制前备份 onebox 的数据卷与上传卷；每段录制从同一快照恢复。只恢复本地演示卷，恢复会覆盖卷内当前数据；录制完成后保留容器、卷和快照供复查。

可按需运行：

```powershell
npm run verify:onebox:smoke
npm run verify:db:concurrency
```

本轮已确认编码、Web 构建、后端构建和 onebox 冒烟通过；发布回归、数据库迁移与并发验证未通过，具体原因见测试文档。该状态不能替代浏览器实录验收。
