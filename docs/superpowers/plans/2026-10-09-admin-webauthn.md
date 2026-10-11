# 管理端 WebAuthn 实施与验收计划

日期：2026-10-09。范围仅为 `SysUser` 管理端账号，所有现有角色自愿绑定。生产依赖精确版本 `@simplewebauthn/server@14.0.3` 与浏览器端 `@simplewebauthn/browser@14.0.0` 已获批准。

## 职责与接口

后端负责固定 RP/Origin 配置、一次性挑战、真实签名验证、账号锁内会话签发、凭据事务、权限/审计、SQLite/MySQL 结构及安全回归；前端负责浏览器 WebAuthn 仪式、管理端入口和用户管理撤销交互。后端路由均使用 `/api` 前缀与现有 `{code,message,data}` 响应：`GET /auth/webauthn/capabilities`、`POST /auth/webauthn/login/options`（可选 `captchaId,code`）、`POST /auth/webauthn/login/verify`、`GET /auth/webauthn/credentials`、`POST /auth/webauthn/register/options`、`POST /auth/webauthn/register/verify`、`PATCH/DELETE /auth/webauthn/credentials/:id`、`POST /users/:id/webauthn/reset`。注册的 `kind=passkey|security_key` 仅影响浏览器提示，不作硬件品牌或企业证明。用户列表和本人资料可返回 `webauthnCredentialsCount`。

## 不变量与执行顺序

1. 默认关闭；启用时先验证固定 DNS RP、非空名称及完整 Origin 白名单。强制驻留凭据和用户验证；不把用户名、设备种类或 attestation 品牌当作无密码身份来源。
2. 匿名登录先过来源/全局风控与按需验证码，挑战绑定短期 nonce Cookie；verify 一次取票，先按原始凭据字节查归属，再在账号→凭据锁内验证 userHandle、公钥签名、UV 和计数器，更新计数器并由统一 `authService` 签发会话及审计。开启 TOTP 的账号密钥登录可直接取得同一管理端会话，密码路径保持原有 MFA。
3. 本人注册先复核密码及已开启的 TOTP，在账号锁内生成不可变句柄并限制最多 10 把；挑战绑定会话摘要和安全快照。verify 重新检查会话仍有效及快照一致，再验证真实 attestation、原始 ID 唯一性并同事务写凭据与审计。删除任一密钥同事务吊销本人全部会话；管理员撤销他人全部密钥亦如此，目标可为 disabled/deactivated，操作者须 admin+权限+身份复核+原因。
4. 永久删除账号前同事务删除凭据，密码重置保留凭据，停用/注销禁止登录。新认证表由实体、SQLite 旧库自举、幂等 MySQL 058 脚本及 MySQL schema contract 共同维护；不纳入业务 JSON 导入六类。

## 验收

先用真实 ES256/CBOR fixture 做红绿回归，再运行后端 build、WebAuthn/MFA/路由契约、SQLite 旧库、MySQL 结构契约和相关安全脚本。覆盖 Origin/nonce/CSRF、挑战重放、userHandle/UV/签名/计数器、跨账号和重复 ID、10 把上限、TOTP 复核、管理员权限、停用/注销/重置密码/永久删除、撤销与在途注册竞态、原有密码/MFA 登录不回归。MySQL 在自有临时实例验证新 schema 与至少一组真实签名及双操作者锁竞态；无法运行则明确列为未验证，不把 SQLite 通过当作 MySQL 通过。验证期冻结代码快照，保存命令、退出码和关键断言；不自动提交或部署。
