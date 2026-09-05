# Y-Link Mobile Native Auth Contract

版本：v1.1（总线最终仲裁校准版）
日期：2026-08-13
基线：`origin/main` @ `f84762c`（Merge PR #44）
状态：**已通过总线最终仲裁，交 Codex 实现**

本文是 Android / iOS 共用的正式 Native 认证契约。Codex 必须**严格按本文实现**，不得自行设计认证协议、改动字段语义或调整状态机。本文与仓库根 `AGENTS.md`、`MASTER_PLAN.md`、`AGENTS.claude.md` 冲突时，以那三份为准并回报总线。

本文档**只交付文档**：未修改后端生产代码、未新建实体、未新建 SQL migration、未实现 endpoint、未改动 Mobile adapter。

---

## Decision Log（总线最终仲裁）

以下 11 条为总线已裁决事项，**不再是开放问题，实现时不得偏离**：

| # | 决策 | 落点章节 |
|---|---|---|
| 1 | 保留 `/api/v1/mobile-auth` 前缀 | API Contract |
| 2 | Native 使用**纯 Bearer** | Web vs Native Boundary |
| 3 | Web 保持 **Cookie** 不变 | Web vs Native Boundary |
| 4 | **不引入 JWT**，继续用服务端可撤销 opaque token | Token Lifecycle |
| 5 | **不设独立 `tokenFamilyId`**，session id 即 family identity | Session Data Model |
| 6 | `absolute_expires_at` **必须存在** | Session Data Model |
| 7 | 单用户最大活跃 Mobile session 数默认 **10** | Device Model |
| 8 | **deviceId 不是认证因素** | Device Model |
| 9 | `last_access_at` **必须节流**，禁止每请求写库 | Session Data Model |
| 10 | 改密：校验成功 → revoke 全部旧 session → 为当前设备创建全新 session → **用户无需重新输入密码登录** | Password / Reset Semantics |
| 11 | 重置密码：revoke 全部 Web + Mobile session → **必须重新登录** | Password / Reset Semantics |

另有两项方案性裁决：

- **Refresh Grace**：接受「grace token 再次出现时继续向前 rotation」作为 **v1 方案**，但须满足 Refresh State Machine 中列出的**十条硬性不变量**（RG-1 ~ RG-10）。
- **MySQL Gate**：**本文档不要求任何数据库运行测试**；但 Mobile Auth **实现 PR** 进入 `main` 前必须同时通过 SQLite 与 MySQL 认证集成测试，见 MySQL Gate 章节。

---

## Goals

1. 为 Native 端提供**服务端可撤销的 opaque 双令牌**会话，不引入 JWT。
2. 弱网与多线程并发 refresh **不得误踢用户**；真实的旧 token 重放**必须被检测并撤销整条会话血缘**。
3. 支持多设备登录、设备枚举、单设备登出、其他设备登出、全部登出。
4. 保持现有已验证的安全属性不退化：token 仅存 hash、停用账号即时失效、改密使会话失效、URL 不承载 token。
5. **不破坏现有 Web Cookie 认证**。Web 与 Native 双通道必须无二义性。
6. 与既有 `authSecurityService` 风控体系合流，不新建第二套互相矛盾的限流。

### 非目标（本阶段明确不做）

- 不做 SSO / OAuth / 第三方登录
- 不做生物识别绑定（可作为客户端本地解锁层，但不参与服务端认证）
- 不做设备指纹反欺诈
- 不把 Mobile 会话与管理端 `SysUserSession` 打通

---

## Threat Model

| # | 威胁 | 当前暴露面 | 本契约的应对 |
|---|---|---|---|
| T1 | 数据库泄露导致会话被劫持 | 会话表 | 只存 SHA-256 hash，明文永不落库 |
| T2 | Access token 泄露（日志、崩溃报告、代理抓包） | 长期有效的单一 token | Access TTL 15 分钟，泄露窗口有限 |
| T3 | Refresh token 被盗（设备被取回、备份提取） | 无 refresh 概念 | 单次使用 + 轮换 + 重放检测 + 血缘撤销 |
| T4 | 攻击者重放已轮换的旧 refresh token | — | 超出宽限期的旧 token 命中即撤销整条会话 |
| T5 | 弱网并发 refresh 造成合法用户被误判为攻击者 | — | 60 秒宽限窗口 + 客户端 single-flight |
| T6 | 设备丢失后无法定向吊销 | 只能改密全局踢下线 | 按 deviceId 的会话枚举与定向撤销 |
| T7 | 账号被停用后旧 token 仍可用至 TTL 自然结束 | 已防护（每请求校验 status） | 保持，并扩展到 refresh 路径 |
| T8 | 客户端伪造 deviceId 冒充其他设备 | — | deviceId **不是凭据**，只做标签；认证完全依赖 token hash |
| T9 | Mobile token 被当作 Web Cookie 值重放（或反向） | Cookie/Bearer 同源解析 | 令牌前缀分流 + 独立表 + 独立中间件 |
| T10 | SecureStore 半状态（access 已更新、refresh 未更新） | — | 单键 JSON bundle 原子写 |
| T11 | 认证接口被用于账号枚举或撞库 | 已部分防护 | 复用 `authSecurityService`，新增 refresh 专项限流 |
| T12 | 高频 `lastAccessAt` 写入打满 SQLite 单写队列 | 已有 60s 节流 | **必须保留节流**，见 Session Data Model 注意事项 |

**明确接受的残余风险**：60 秒宽限窗口内，持有刚被轮换掉的 refresh token 的攻击者可换到有效令牌对。这是"不误踢合法用户"与"即时检测盗用"之间的取舍，采用业界通行做法。窗口结束后重放即被检测。

---

## Web vs Native Boundary

### 现状（`client-auth.middleware.ts:16-32`）

```ts
const parseBearerToken = (req: Request) => {
  const sessionToken = readClientSessionTokenFromCookie(req)   // ← Cookie 优先
  if (sessionToken) return sessionToken
  const authorization = req.headers.authorization              // ← Bearer 兜底
  ...
}
```

Cookie 优先于 Bearer。若 App 内嵌 WebView 同时持有 Cookie 与 Bearer，**Cookie 会赢**，Mobile 会话被静默旁路。这是必须修的二义性。

### 目标边界

| 通道 | 凭据 | 会话表 | 中间件 | CSRF |
|---|---|---|---|---|
| Web 客户端 | `y_link_client_session` HttpOnly Cookie | `client_user_session`（现状不动） | `requireClientAuth` | 现状不动 |
| Native App | `Authorization: Bearer ylma_<hex>` | `client_mobile_session`（新增） | `requireMobileAuth` | 不适用（无 Cookie 即无 CSRF） |

### 四条强制规则

**R-B1 — 令牌前缀分流。** Mobile 令牌带命名空间前缀，解析器按前缀分派，杜绝跨表查找：

- Access：`ylma_` + 64 位小写 hex
- Refresh：`ylmr_` + 64 位小写 hex
- 现有 Web session token 无前缀（保持不变）

前缀参与 hash 计算（对完整字符串做 SHA-256）。副作用收益：前缀可被密钥扫描工具识别，便于发现泄露。

**R-B2 — Mobile 认证路由只接受 Bearer。** `/api/v1/mobile-auth/*` 下的**所有 authenticated endpoint** 使用新中间件 `requireMobileAuth`，**完全不读 Cookie**。请求中出现任何 Cookie 值一律忽略，不参与认证判定、不作为兜底。

**R-B3 — Authorization 存在即独占（总线最终裁定，无 Cookie fallback）。**

这是本契约对既有中间件的**唯一**行为变更，判定逻辑必须逐字实现为：

```
if (请求存在 Authorization header) {
    // 只走 Bearer 通道，Cookie 完全不参与
    if (scheme 不是 Bearer)                  → 401
    if (token 为空 / 格式非法)                → 401
    if (token 以 ylma_ 开头)  → 查 client_mobile_session
    else                      → 查 client_user_session（历史无前缀 Bearer 兼容）
    if (无效 / 已过期 / 已撤销)               → 401     ← 禁止回退 Cookie
    → 认证成功
}
else {
    // 无 Authorization header：现有 Web 行为完全不变
    读取 y_link_client_session Cookie → 查 client_user_session
    if (无 Cookie 或无效)                     → 401
}
```

**核心约束：`Authorization` header 一旦存在，无论 Bearer 校验结果如何，都不得回退到 Cookie。** 失败即 401，不做二次尝试。

**为什么禁止 fallback（安全论证）**：若允许"Bearer 失败 → 退回 Cookie"，则内嵌 WebView 场景下，一个**已过期或已被撤销**的 Mobile token 会静默降级为 Web Cookie 会话继续可用。这会直接击穿 Mobile 侧的撤销语义 —— 用户「登出该设备」「改密」「重放检测撤销」之后，请求仍能凭 Cookie 通过。禁止 fallback 使撤销在两个通道上都是终局的。

**兼容性论证**：现有 Web 前端只发 Cookie、从不发 `Authorization` 头，因此走的始终是 `else` 分支，行为**逐字节不变**。行为变化仅发生在同时携带两者的场景，而那正是 WebView 内嵌场景，Bearer 独占即为期望行为。由 T-W1 / T-W2 / T-W3 三条回归测试守门。

**R-B4 — 跨通道令牌互斥。** Mobile access token 放进 Cookie 必须失败（Cookie 通道只查 `client_user_session`，`ylma_` 前缀令牌不可能命中）；Web session token 放进 `Authorization: Bearer` 时**不得**命中 `client_mobile_session`（无前缀 → 只查 `client_user_session`）。由前缀分派天然保证，无需额外校验。

---

## Session Data Model

### 表：`client_mobile_session`

单表设计。**不拆表**，理由见下方设计判断。

| 字段 | 类型（MySQL / SQLite） | 可空 | 说明 |
|---|---|---|---|
| `id` | `bigint unsigned` / `integer` | 否 | 主键。**同时充当 token family 标识** |
| `client_user_id` | `bigint unsigned` / `integer` | 否 | 外键 → `client_user.id`，`ON DELETE CASCADE` |
| `device_id` | `varchar(64)` | 否 | 客户端生成的 UUID v4，**仅标签，非凭据** |
| `device_name` | `varchar(64)` | 是 | 用户可读设备名，展示用 |
| `platform` | `varchar(16)` | 否 | `android` / `ios` |
| `app_version` | `varchar(32)` | 是 | 便于按版本排查与强制升级 |
| `access_token_hash` | `char(64)` / `varchar(64)` | 否 | SHA-256 hex |
| `access_expires_at` | `datetime(6)` / `datetime` | 否 | |
| `refresh_token_hash` | `char(64)` / `varchar(64)` | 否 | 当前有效 refresh |
| `refresh_expires_at` | `datetime(6)` / `datetime` | 否 | 滑动过期 |
| `previous_refresh_token_hash` | `char(64)` / `varchar(64)` | 是 | 上一代 refresh，用于宽限与重放检测 |
| `previous_refresh_grace_expires_at` | `datetime(6)` / `datetime` | 是 | 宽限窗口结束时刻 |
| `refresh_generation` | `int unsigned` | 否 | 轮换代数，默认 0；用于异常抖动检测 |
| `absolute_expires_at` | `datetime(6)` / `datetime` | 否 | **硬上限**，滑动续期不可突破 |
| `last_ip` | `varchar(45)` | 是 | 兼容 IPv6 |
| `last_access_at` | `datetime(6)` / `datetime` | 否 | **写入必须节流**，见下 |
| `created_at` | `datetime(6)` / `datetime` | 否 | |
| `revoked_at` | `datetime(6)` / `datetime` | 是 | 非空即失效 |
| `revoke_reason` | `varchar(32)` | 是 | 枚举见下 |

### 设计判断（对总线给定字段清单的取舍）

**删除 `tokenFamilyId`。** 在本设计中会话轮换始终复用同一行（只换 hash，不新建行），因此"token family"与"session 行"是同一概念，独立的 family id 是冗余字段，还会诱导实现者写出"多行同 family"的错误结构。**用 `id` 作为 family 标识**，撤销 family == 撤销该行。

**新增 `absolute_expires_at`。** 总线清单里没有，但没有它 refresh 可无限滑动续期，会话事实上永不过期，违背 `AGENTS.claude.md` §4「refresh 可撤销并有明确生命周期」。**这是必须字段。**

**保留 `refresh_generation`。** 不用于认证判定，只用于异常检测（见 Refresh State Machine 的 SV-1 安全阀）与审计取证。

**不拆表。** 曾考虑把 access token 拆出以降低写放大，结论是不值得：access 每 15 分钟才轮换一次（单设备 ≈ 96 次/天），而拆表会让**每个已认证请求多一次 join**。请求量比轮换量高 2~3 个数量级，拆表是净亏。

**`last_ip` 展示口径**：会话列表接口对**其他设备**只返回粗化形态（IPv4 保留前两段 `10.8.*.*`，IPv6 保留前 48 位），当前设备可返回完整值。避免会话列表成为跨设备的位置信息侧信道。

### `revoke_reason` 枚举（闭集，实现不得扩展）

`user_logout` / `user_logout_all` / `user_revoke_device` / `password_changed` / `password_reset` / `account_disabled` / `refresh_replay_detected` / `session_limit_evicted` / `expired_cleanup` / `admin_revoke`

### ⚠️ 与 SQLite 单写队列的关键交互

上一轮 Delta Re-Baseline 的 R2 指出：SQLite 下**所有写事务经同一有界队列串行**（`transaction-coordinator.ts`，默认 `maxPendingWrites=256`、超时 5s）。

因此：

- **`last_access_at` 的写入必须沿用现有 60 秒节流**（参考 `client-auth.service.ts:50` 的 `CLIENT_SESSION_ACTIVITY_WRITE_INTERVAL_MS`）。若每个已认证请求都写一次，SQLite 写队列会被认证心跳打满，直接触发 503 风暴。
- 认证**读路径不得进入写事务**。`requireMobileAuth` 的正常路径必须是纯读；只有越过节流阈值时才发起一次独立的轻量 UPDATE。
- 过期会话清理**不得挂在登录路径上**（这是现有 `client-auth.service.ts:568` 的既有问题，Delta 报告 Finding 9），Mobile 侧必须改为后台定时任务。

---

## Token Lifecycle

### 生成与存储

| 属性 | Access Token | Refresh Token |
|---|---|---|
| 熵 | `randomBytes(32)` = 256 bit | `randomBytes(32)` = 256 bit |
| 编码 | `ylma_` + hex(32B) → 69 字符 | `ylmr_` + hex(32B) → 69 字符 |
| 存储哈希 | SHA-256(完整字符串) hex | SHA-256(完整字符串) hex |
| 明文留存 | 仅签发响应中返回一次 | 仅签发响应中返回一次 |
| 服务端明文缓存 | **禁止** | **禁止** |

**哈希算法选型说明**：SHA-256 而非 bcrypt/argon2。令牌是 256 bit 均匀随机串，不存在字典/暴力可行性，慢哈希只会给每个已认证请求增加毫秒级开销而无安全收益。这与密码哈希（`utils/password.ts` 用慢哈希）是两类问题，**不要混用**。可直接复用现有 `utils/session-token.ts` 的 `hashSessionToken`。

**令牌生成**：复用 `utils/token.ts` 的 `generateSessionToken()`（已是 `randomBytes(32).toString('hex')`），在其外层拼接前缀。**不要新写随机数逻辑。**

### 生命周期参数（全部走 env，给出默认值）

| 参数 | env key | 默认 | 分类 | 说明 |
|---|---|---|---|---|
| Access TTL | `MOBILE_ACCESS_TTL_MINUTES` | `15` | 业务 | 泄露窗口 |
| Refresh TTL（滑动） | `MOBILE_REFRESH_TTL_DAYS` | `30` | 业务 | 每次成功 refresh 后重新计时 |
| 绝对过期 | `MOBILE_SESSION_ABSOLUTE_TTL_DAYS` | `90` | 业务 | 自 `created_at` 起，滑动不可突破 |
| Refresh 宽限窗口 | `MOBILE_REFRESH_GRACE_SECONDS` | `60` | **安全参数** | 旧 refresh 容忍期 |
| 单用户最大活跃会话 | `MOBILE_MAX_ACTIVE_SESSIONS` | `10` | 业务 | 见 Device Model |
| **轮换速率阈值** | `MOBILE_REFRESH_ROTATION_RATE_LIMIT` | `10` | **安全参数** | 见下方专项说明 |
| **轮换速率观测窗口** | `MOBILE_REFRESH_ROTATION_RATE_WINDOW_SECONDS` | `60` | **安全参数** | 同上 |

参数校验沿用 `config/env.ts` 的 zod 风格，全部给 `.int().positive()` 与合理上下界。

#### 轮换速率阈值是安全参数，不是业务常量（总线裁定）

`MOBILE_REFRESH_ROTATION_RATE_LIMIT` 与其观测窗口**必须**按安全参数对待，实现上须满足：

- **不得**硬编码在服务类中作为业务常量，必须经 `config/env.ts` 注入
- 变更该值等同于调整安全阈值，**需要与调整限流阈值同级的评审**，不得由业务需求单方面放宽
- 触发阈值的处置是**撤销会话 + 写安全审计**（见 RG-10），不是简单限流拒绝
- 该值的语义是「同一 session 在观测窗口内允许的最大 `refresh_generation` 增量」，跨 session 不累计
- 默认 `10 次 / 60 秒`：正常单会话为 4 次/小时，默认值给出约 150 倍瞬时裕量，仅在客户端 single-flight 完全失效或存在并行使用者时才会触发

监控要求：该阈值的触发率应作为安全指标持续观测。触发率异常升高时，**先排查客户端 single-flight 是否失效，禁止直接调高阈值掩盖问题**。

### 状态不变式

- **I-T1** 任一时刻，一行会话最多有 1 个有效 access hash、1 个有效 refresh hash、至多 1 个宽限期内的 previous refresh hash。
- **I-T2** `revoked_at IS NOT NULL` 的会话，其所有 token 立即失效，不论 `expires_at`。
- **I-T3** `refresh_expires_at` 与 `access_expires_at` 均不得晚于 `absolute_expires_at`。签发时取 `min()`。
- **I-T4** 数据库中不存在任何 token 明文。审计、日志、错误响应中也不得出现。

---

## Device Model

### deviceId 的定位

**deviceId 不是认证凭据。** 它由客户端生成（UUID v4）、存于 SecureStore、随登录与刷新上报，服务端仅用于：会话去重、会话列表展示、审计留痕。

强制规则：

- **D-1** 服务端**永不**基于 deviceId 授予任何权限。认证结论 100% 来自 token hash 匹配。
- **D-2** 请求携带的 deviceId 与会话记录不一致时，**不影响本次认证结果**，仅记录审计。不得据此拒绝或提权。
- **D-3** deviceId 格式校验：`/^[0-9a-fA-F-]{32,64}$/`，超长或非法直接 400，避免污染索引与日志。
- **D-4** deviceId 在 App 卸载重装后会变化，这是**预期行为**，不做持久化对抗。

### 同设备唯一活跃会话

`(client_user_id, device_id)` 在 `revoked_at IS NULL` 时唯一。同一设备重新登录时**复用/替换**该行（先撤销旧行，再建新行，同事务），而非累积。

MySQL 不支持部分唯一索引，实现方式：普通复合索引 `idx_mobile_session_user_device (client_user_id, device_id, revoked_at)` + **服务层在事务内保证**（先 `UPDATE ... SET revoked_at WHERE client_user_id=? AND device_id=? AND revoked_at IS NULL`，再 INSERT）。SQLite 同样走服务层逻辑，保持两库一致。

### 会话数上限的安全合理性评估

总线建议 10。我的评估：

**真实设备数** —— 校企 O2O 场景下单用户实际设备数为 1~3（一台主力手机，可能加一台平板/备用机）。
**主要增长源不是设备，是重装** —— 卸载重装、系统恢复出厂、更换手机都会产生新 deviceId。一个活跃用户两年内可能累积 4~6 个历史 deviceId。
**上限的作用** —— 主要是防止凭据填充攻击者在拿到密码后批量建立长效 refresh 会话作为持久化后门，而不是限制正常用户。

结论：**采纳 10，但真正起作用的是淘汰策略而非数字本身。**

- 超限时按 `last_access_at` 最旧的活跃会话 LRU 淘汰，`revoke_reason = 'session_limit_evicted'`
- 淘汰必须写审计事件，且**用户可在会话列表中看到"某设备已因数量上限被登出"**
- 若未来观察到淘汰率异常升高（正常用户被误淘汰），应先排查 deviceId 稳定性，而不是盲目调高上限

**不建议低于 5**（重装churn 会导致频繁误淘汰），**不建议高于 20**（削弱防持久化后门的作用）。

### 登出语义矩阵

| 操作 | 影响范围 | `revoke_reason` | 端点 |
|---|---|---|---|
| 当前设备登出 | 仅当前会话 | `user_logout` | `POST /logout` |
| 指定设备登出 | 指定 session id（必须属于本人） | `user_revoke_device` | `DELETE /sessions/:id` |
| 登出其他设备 | 本人全部会话，**排除**当前 | `user_revoke_device` | `POST /logout-all?scope=others` |
| 全部设备登出 | 本人全部 Mobile 会话，**含**当前 | `user_logout_all` | `POST /logout-all?scope=all` |

**"登出其他设备"与"全部登出"合并为一个端点 + `scope` 参数**，避免两个语义相近的端点被实现者混淆。`scope` 默认 `all`。

---

## API Contract

### 通用约定

- 前缀：`/api/v1/mobile-auth`
- 响应信封沿用现有 `{ code: 0, message: 'ok', data: T }`（`packages/api-client` 的 `ApiEnvelope` 已按此解析）
- 所有时间字段为 ISO 8601 UTC 字符串
- 认证要求列中：`Bearer(access)` = 需有效 access token；`Bearer(refresh)` = 仅 refresh 端点，refresh 走 **body** 而非 Authorization 头
- **所有端点禁止在 URL query 中出现任何 token**（`AGENTS.md` §4）

### 错误码（`code` 字段，全局唯一，闭集）

| code | HTTP | 含义 | 客户端应对 |
|---|---|---|---|
| `40100` | 401 | access token 缺失或格式非法 | 跳登录 |
| `40101` | 401 | access token 无效或已撤销 | 触发 refresh |
| `40102` | 401 | access token 已过期 | 触发 refresh |
| `40110` | 401 | refresh token 无效 | 清凭据，跳登录 |
| `40111` | 401 | refresh token 已过期 | 清凭据，跳登录 |
| `40112` | 401 | 会话已达绝对过期 | 清凭据，跳登录 |
| `40113` | 401 | **检测到 refresh 重放，会话已撤销** | 清凭据，跳登录 + 安全提示 |
| `40120` | 401 | 账号密码错误 | 停留，展示剩余次数 |
| `40300` | 403 | 账号已停用 | 清凭据，跳登录 + 停用提示 |
| `40900` | 409 | 设备会话冲突 | 重试一次 |
| `42900` | 429 | 触发限流 | 按 `retryAfterSeconds` 退避 |

**只有 `40101` 与 `40102` 允许触发自动 refresh。** 其余 401 一律终结会话。这条是 Native adapter 的核心判据。

---

### `POST /api/v1/mobile-auth/register`

**认证**：无
**幂等**：否（受账号唯一约束天然保护）
**限流**：复用 `authSecurityService.guardClientRegisterSourceRequest` + `guardClientRegisterAccountRequest`

Request：
```jsonc
{
  "accountType": "personal",          // personal | department
  "account": "13800138000",           // 手机号或邮箱
  "username": "张三",
  "password": "********",
  "staffNo": "T12345",                // department 类型必填
  "inviteCode": "******",             // department 类型必填
  "departmentName": "信息中心",
  "captchaId": "...",                 // 按 capabilities 决定
  "captchaCode": "...",
  "verificationCode": "123456",       // 按 capabilities 决定
  "device": {                         // ← Mobile 新增
    "deviceId": "0f2c...",
    "deviceName": "Pixel 8",
    "platform": "android",
    "appVersion": "1.0.0"
  }
}
```

Response `200`：与 `POST /login` 完全一致的 `MobileAuthSessionDTO`（注册成功即登录）。

**复用要求**：账号规范化、密码策略、验证码、员工目录校验、邀请码全部直接调用 `clientAuthService` 现有私有逻辑，**不得重写一套**。Codex 应把现有 `register()` 中「校验 + 建号」的部分抽成可复用方法，会话签发部分替换为 Mobile 版本。

错误：`40120`（校验失败细分沿用现有文案）、`409`（账号已存在）、`42900`。

---

### `POST /api/v1/mobile-auth/login`

**认证**：无
**幂等**：否
**限流**：`guardClientLoginRequest` + `recordClientLoginFailure` / `clearClientLoginFailures`（现有实现，直接复用）

Request：
```jsonc
{
  "account": "13800138000",
  "password": "********",
  "captchaId": "...",        // guardClientLoginRequest 返回 captchaRequired 时必填
  "captchaCode": "...",
  "device": {
    "deviceId": "0f2c...",
    "deviceName": "Pixel 8",
    "platform": "android",
    "appVersion": "1.0.0"
  }
}
```

Response `200` —— **`MobileAuthSessionDTO`**：
```jsonc
{
  "code": 0,
  "message": "ok",
  "data": {
    "accessToken": "ylma_3f9c...",
    "accessExpiresAt": "2026-08-13T10:15:00.000Z",
    "refreshToken": "ylmr_a71e...",
    "refreshExpiresAt": "2026-09-12T10:00:00.000Z",
    "absoluteExpiresAt": "2026-11-11T10:00:00.000Z",
    "session": {
      "id": "1024",
      "deviceId": "0f2c...",
      "deviceName": "Pixel 8",
      "platform": "android",
      "appVersion": "1.0.0",
      "createdAt": "2026-08-13T10:00:00.000Z",
      "lastAccessAt": "2026-08-13T10:00:00.000Z"
    },
    "user": {
      "id": "88",
      "username": "张三",
      "mobile": "138****8000",
      "email": null,
      "accountType": "personal",
      "departmentName": "",
      "staffNo": null,
      "status": "enabled"
    }
  }
}
```

`user` 投影**直接复用** `clientAuthService.toClientProfile()`，不新增字段口径。

**安全要求**：
- 账号不存在与密码错误必须返回**同一错误码与同一文案**（现有实现已如此，保持）
- 登录成功时执行会话数上限淘汰（LRU）
- 同 deviceId 已有活跃会话时先撤销再建（同一事务）
- 明文密码不得进入任何日志或审计 detail

错误：`40120`、`40300`（账号停用）、`42900`。

---

### `POST /api/v1/mobile-auth/refresh`

**认证**：无 Authorization 头；凭据在 body
**幂等**：**部分幂等** —— 宽限窗口内用同一 refresh token 重试不会失败，但每次返回**新的**令牌对（见 Refresh State Machine）
**限流**：新增 `authSecurityService.guardMobileRefreshRequest(requestMeta, sessionScopeKey)`

Request：
```jsonc
{
  "refreshToken": "ylmr_a71e...",
  "device": { "deviceId": "0f2c...", "appVersion": "1.0.1" }   // appVersion 可更新
}
```

Response `200`：`MobileAuthSessionDTO`（结构同 login，`user` 可省略以减小体积 —— **本契约要求保留 `user`**，便于客户端在 refresh 时同步账号状态变化）。

错误：`40110` / `40111` / `40112` / `40113` / `40300` / `42900`。

**安全要求**：
- refresh token **不得**出现在 URL、不得放 Authorization 头（避免被通用日志中间件记录）
- 每次成功 refresh 都写 `mobile_refresh` 审计
- `40113`（重放）必须同时撤销该会话并写 `refresh_replay_detected` 审计
- 账号状态必须在此路径重新校验（T7）

---

### `POST /api/v1/mobile-auth/logout`

**认证**：`Bearer(access)`
**幂等**：**是**。会话已撤销时返回 `200`，不返回 404 —— 登出重试不应报错。

Request：空
Response `200`：`{ "code": 0, "message": "ok", "data": { "revoked": true } }`

安全要求：只能撤销**当前 access token 所属**的会话，不接受任何 body 参数指定目标。

---

### `POST /api/v1/mobile-auth/logout-all`

**认证**：`Bearer(access)`
**幂等**：是

Query：`scope=all`（默认）| `scope=others`

Response `200`：`{ "data": { "revokedCount": 3, "currentSessionRevoked": true } }`

安全要求：只作用于**本人**会话；不影响 Web `client_user_session`（Web 登出走既有端点）。

---

### `GET /api/v1/mobile-auth/me`

**认证**：`Bearer(access)`
**幂等**：是（只读）

Response `200`：
```jsonc
{ "data": { "user": { /* toClientProfile 投影 */ }, "session": { /* 当前会话摘要 */ } } }
```

**注意**：此端点是 access token 有效性的探针，客户端冷启动时调用。必须走**纯读**路径（`last_access_at` 节流规则同样适用）。

---

### `GET /api/v1/mobile-auth/sessions`

**认证**：`Bearer(access)`
**幂等**：是

Response `200`：
```jsonc
{
  "data": {
    "sessions": [
      {
        "id": "1024",
        "deviceId": "0f2c...",
        "deviceName": "Pixel 8",
        "platform": "android",
        "appVersion": "1.0.0",
        "lastIp": "10.8.*.*",          // 非当前设备粗化
        "lastAccessAt": "2026-08-13T10:00:00.000Z",
        "createdAt": "2026-08-01T09:00:00.000Z",
        "isCurrent": true
      }
    ],
    "maxActiveSessions": 10
  }
}
```

只返回 `revoked_at IS NULL` 且未过期的会话，按 `lastAccessAt` 倒序。

---

### `DELETE /api/v1/mobile-auth/sessions/:id`

**认证**：`Bearer(access)`
**幂等**：是（已撤销返回 200）

安全要求：
- **必须校验目标会话属于当前用户**，否则返回 `404`（不是 403 —— 避免会话 id 枚举）
- 允许撤销当前会话（等价于 logout）

---

### `PATCH /api/v1/mobile-auth/profile`

**认证**：`Bearer(access)`
**幂等**：否

Request / Response 结构**完全复用**现有 `clientAuthService.updateProfile()` 的入参与投影（含 `currentPassword` 二次确认、手机号/邮箱验证码）。本契约不改动资料更新语义，仅换认证通道。

---

### 密码相关端点

| 端点 | 认证 | 行为 |
|---|---|---|
| `POST /api/v1/mobile-auth/change-password` | `Bearer(access)` | 见 Password / Reset Semantics |
| `POST /api/v1/mobile-auth/forgot-password/verify` | 无 | 复用现有 `verifyForgotPassword`，返回 resetToken |
| `POST /api/v1/mobile-auth/forgot-password/reset` | 无 | 复用现有 `resetPassword`，撤销全部会话 |
| `POST /api/v1/mobile-auth/verification-code` | 无 | 复用现有发送逻辑与 `guardVerificationCodeSendRequest` |
| `GET /api/v1/mobile-auth/capabilities` | 无 | 复用 `ClientAuthCapabilities`，供登录页决定是否需验证码 |

---

## Refresh State Machine

**这是本契约风险最高的部分，实现必须逐条对齐。**

### RG-1 ~ RG-10：总线裁定的十条硬性不变量

总线接受「grace token 再次出现时继续向前 rotation」作为 **v1 方案**，但该方案**只有在下列十条全部成立时才是安全的**。任何一条未实现，该方案即不成立，不得合入。

| # | 不变量 | 归属 | 验证用例 |
|---|---|---|---|
| **RG-1** | **同一 session 的 refresh 必须串行执行。** 服务端对同一会话行的 refresh 判定与轮换不得并行进入。MySQL 用 `SELECT ... FOR UPDATE` 持有行锁；SQLite 由 TransactionCoordinator 单写队列天然串行。 | 服务端 | T-10、T-70 |
| **RG-2** | **`refresh_generation` 单调递增。** 每次成功轮换必须 `+1`，不得回退、不得跳变、不得复用。该值是客户端判定凭据新旧的唯一依据。 | 服务端 | T-03、T-10 |
| **RG-3** | **`CUR` 与 `PREV` 的转换必须事务原子。** `PREV←CUR`、`CUR←new`、`GRACE_UNTIL←now+grace`、`generation++` 四项写入必须在**同一事务的同一条 UPDATE** 中完成，不得拆成多条语句。中途崩溃只能是「全部生效」或「全部未生效」。 | 服务端 | T-71 |
| **RG-4** | **`PREV` 仅在 grace window 内可被接受。** 窗口外命中 `PREV` 一律判为重放，撤销会话。窗口边界用服务端时间判定，不接受任何客户端传入的时间参数。 | 服务端 | T-11、T-12 |
| **RG-5** | **grace 不是正常并发机制。** grace 是**异常路径的容错兜底**，正常运行时命中率应接近 0。实现不得把 grace 当作「支持并发 refresh」的设计依据，客户端不得依赖 grace 来简化并发控制。命中 grace 必须在审计中标记 `viaGrace: true` 以便观测真实命中率。 | 双端 | T-11 + 监控 |
| **RG-6** | **Native 必须实现 process-level single-flight refresh。** 全进程唯一的 refresh Promise，所有并发 401 共享同一次刷新。这是防止 grace 被高频触发的**第一道也是主要防线**（见 HTTP Adapter Policy A-1）。 | 客户端 | T-60 |
| **RG-7** | **SecureStore 凭据更新必须串行。** 凭据写入需经一个串行化队列（互斥锁），禁止两次 refresh 的写入交错。配合单键原子写（SecureStore Contract），保证本地永远是一份自洽的完整凭据束。 | 客户端 | T-65、T-72 |
| **RG-8** | **响应中必须携带 `generation`。** 每个签发令牌的响应（login / register / refresh / change-password）都必须返回当前 `refresh_generation`，供客户端做新旧判定。 | 双端 | T-03、T-73 |
| **RG-9** | **客户端不得让较旧 generation 覆盖较新凭据。** 写入 SecureStore 前必须比较：若待写入的 `generation` **小于等于**本地已存 `generation`，则**丢弃该次写入**。这是 RG-7 之外针对乱序响应的第二道防护 —— 网络乱序可能让先发出的 refresh 后返回。 | 客户端 | T-73 |
| **RG-10** | **异常高频 rotation 必须撤销 session 并写安全审计。** 观测窗口内 `refresh_generation` 增量超过 `MOBILE_REFRESH_ROTATION_RATE_LIMIT`，判定为异常，撤销会话（`revoke_reason='refresh_replay_detected'`，`trigger='burst'`），返回 `40113`，写 `refresh_replay_detected` 审计并触发告警。 | 服务端 | T-14 |

**RG-6 / RG-9 的关系**：RG-6 消除同一进程内的并发；RG-9 兜住 RG-6 失效或响应乱序的残余情况。两者不可互相替代 —— 只有 RG-6 而无 RG-9，乱序响应会让旧凭据覆盖新凭据，导致下一次 refresh 命中 grace 甚至被判重放。

### 状态定义

会话行的 refresh 相关状态由三元组描述：

```
(CUR, PREV, GRACE_UNTIL)
  CUR        = refresh_token_hash            （始终非空）
  PREV       = previous_refresh_token_hash   （可空）
  GRACE_UNTIL= previous_refresh_grace_expires_at
```

### 输入分类

对收到的 refresh token `R`，令 `h = sha256(R)`：

| 分类 | 判定条件 |
|---|---|
| **MATCH_CUR** | `h == CUR` |
| **MATCH_PREV_IN_GRACE** | `h == PREV` 且 `now <= GRACE_UNTIL` |
| **MATCH_PREV_EXPIRED** | `h == PREV` 且 `now > GRACE_UNTIL` |
| **NO_MATCH** | 全库无匹配 |

### 转换表

| 输入 | 前置校验 | 动作 | 结果 | 审计 |
|---|---|---|---|---|
| MATCH_CUR | 会话未撤销、未过绝对期、账号 enabled | **轮换**：`PREV←CUR`，`CUR←new`，`GRACE_UNTIL←now+60s`，`generation++`，`refresh_expires_at←now+30d`（不超 `absolute_expires_at`），签发新 access | `200` + 新令牌对 | `mobile_refresh` |
| MATCH_PREV_IN_GRACE | 同上 | **同样执行轮换**（见下方说明） | `200` + 新令牌对 | `mobile_refresh`（标记 `viaGrace: true`） |
| MATCH_PREV_EXPIRED | — | **撤销整条会话**（`revoke_reason='refresh_replay_detected'`） | `401` `40113` | `refresh_replay_detected` |
| NO_MATCH | — | 无动作 | `401` `40110` | 不写（避免噪声放大与枚举探测） |
| 任一匹配但会话已撤销 | — | 无动作 | `401` `40110` | 不写 |
| 任一匹配但 `now > absolute_expires_at` | — | 撤销会话（`expired_cleanup`） | `401` `40112` | `mobile_session_revoked` |
| 任一匹配但账号 `status != 'enabled'` | — | 撤销会话（`account_disabled`） | `403` `40300` | `account_disabled_session_rejected` |

### 为什么 MATCH_PREV_IN_GRACE 也执行轮换（关键设计说明）

理想做法是"宽限期内返回**当初那次轮换签发的同一对令牌**"，但服务端**只存 hash、不存明文**（I-T4），物理上无法复现那对明文令牌。在"缓存明文换幂等"与"再轮换一次"之间：

- **缓存明文**：违反 I-T4，且内存缓存不跨进程重启、不跨多实例，SQLite 单实例下勉强可行、MySQL 多实例下失效。**否决。**
- **再轮换一次**：不违反任何不变式。代价是并发的两个线程各自拿到不同的、都有效的令牌对。

选择后者。收敛性论证：线程 A 拿到 R2（此时 CUR=R2），线程 B 用 R1 命中宽限 → 轮换为 R3（PREV=R2，宽限重置）。A 手上的 R2 成为 PREV 且处于新宽限期内，仍可用。客户端的 SecureStore 单键原子写（见 SecureStore Contract）保证最终只保留一份最新凭据，下一次 refresh 用最新的即命中 MATCH_CUR，状态收敛。

**安全阀 SV-1（即 RG-10）**：若 `MOBILE_REFRESH_ROTATION_RATE_WINDOW_SECONDS`（默认 60 秒）内 `refresh_generation` 增长超过 `MOBILE_REFRESH_ROTATION_RATE_LIMIT`（默认 10），判定为异常抖动 —— 要么是客户端 single-flight（RG-6）失效，要么是攻击者与用户在同时使用同一条血缘。此时**撤销会话**，`revoke_reason='refresh_replay_detected'`，`trigger='burst'`，返回 `40113`，写审计并告警。这为"再轮换"策略提供了兜底上界，防止无限乒乓。

两个阈值均为**安全参数**（见 Token Lifecycle），不得作为业务常量硬编码，调整需安全评审。

### 场景推演

**S1 正常 refresh** —— access 过期 → 单请求 refresh → MATCH_CUR → 轮换 → 200。

**S2 两个 App 线程同时 refresh** —— 客户端 single-flight 应拦下第二个。若未拦下：先到者 MATCH_CUR 轮换；后到者 MATCH_PREV_IN_GRACE 轮换。两者都 200，SecureStore 后写者胜出，下轮收敛。**不误踢。**

**S3 弱网重试（客户端未收到响应）** —— 服务端已轮换，客户端仍持 R1 重发 → MATCH_PREV_IN_GRACE → 200。**不误踢。**

**S4 两台设备同时 refresh** —— 不同 deviceId = 不同会话行 = 不同血缘，**互不影响**。

**S5 真实盗用（宽限期后）** —— 攻击者在 T+5min 用截获的 R1 → MATCH_PREV_EXPIRED → 会话撤销 + 审计。用户下次请求被登出并看到安全提示。**检测成立。**

**S6 服务端崩溃恢复** —— 轮换在**单个数据库事务**内完成（`runInTransaction`）。崩溃要么全成要么全不成：全不成 → 客户端 R1 仍是 CUR，重试即 MATCH_CUR；全成但响应丢失 → 退化为 S3。**无中间态。**

**S7 攻击者先用、用户后用** —— 攻击者宽限期后重放 → 会话撤销 → 用户也被登出。这是**期望行为**（fail-secure）：宁可让用户重新登录，也不能让被盗令牌继续存活。客户端必须对 `40113` 展示明确的安全提示文案，而非普通"登录已过期"。

### 事务与并发要求（RG-1 / RG-3 的实现规格）

- 整个 refresh 判定 + 轮换必须在**一个** `runInTransaction` 内完成
- MySQL：对会话行 `SELECT ... FOR UPDATE`（`pessimistic_write`）→ 满足 RG-1
- SQLite：由 TransactionCoordinator 单写队列串行，无需显式锁（沿用 `manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' }` 的既有写法）→ 满足 RG-1
- 轮换的落库必须是**单条条件更新**（CAS），形如：

  ```sql
  UPDATE client_mobile_session
     SET previous_refresh_token_hash = <旧 CUR>,
         previous_refresh_grace_expires_at = <now + grace>,
         refresh_token_hash = <新>,
         access_token_hash = <新>,
         access_expires_at = <...>,
         refresh_expires_at = <...>,
         refresh_generation = refresh_generation + 1
   WHERE id = ? AND refresh_token_hash = <判定时读到的 CUR> AND revoked_at IS NULL
  ```

  **四项状态迁移必须在这一条语句内完成**（RG-3）。`affected !== 1` 视为并发冲突，重新走一遍完整判定，不得直接报错、不得重试单条 SQL。
- 这与上一轮 Finding 2 修复所用的 CAS 模式一致，**Codex 应参考 `o2o-preorder.service.ts` 的 `cancelOrderInManager` 写法**。
- `refresh_generation` 用 `= refresh_generation + 1` 的**数据库端自增**表达，禁止「先读值、应用层 +1、再写回」（后者在并发下会丢更新，破坏 RG-2）。

---

## HTTP Adapter Policy

作用位置：`packages/api-client/src/native-fetch-adapter.ts:246-248` 现有 TODO。

### 401 处理流程

```
请求返回 401
   │
   ├─ code ∉ {40101, 40102} ──► 不 refresh
   │                            清凭据 → 清敏感缓存 → authStore=unauthenticated → 跳登录
   │
   └─ code ∈ {40101, 40102}
          │
          ├─ 本次请求已重放过一次？ ──► 是：按失败终结（同上清理路径）
          │
          ├─ 本次请求标记 replayable=false？ ──► 是：只 refresh，不重放；错误上抛给调用方
          │
          └─ 进入全进程 single-flight refresh（RG-6）
                 │
                 ├─ 成功 ──► generation 守卫（RG-9）──► 串行原子写 SecureStore（RG-7）
                 │                                        └─► 重放原请求【最多一次】
                 │
                 └─ 失败 ──► 清凭据 → 清敏感缓存 → authStore=unauthenticated → 跳登录
```

### 强制规则

**A-1 全进程单飞（RG-6）。** 模块级 `let refreshInFlight: Promise<Credentials> | null`。所有并发 401 共享同一个 Promise，完成后置空。这是 grace 路径不被高频触发的**主要防线**，也是 S2 场景在客户端侧的第一道防线。

实现要点：
- 单飞变量必须在**模块作用域**，不得挂在组件、hook 或 store 实例上（后者会随卸载/重建产生多份）
- 置空必须在 `finally` 中执行，保证失败后不会永久卡住后续 refresh
- refresh 自身的请求必须绕过 401 拦截（A-7），否则递归

**A-8 generation 守卫（RG-9）。** 收到任何签发凭据的响应后，写入 SecureStore **之前**必须比较 generation：

```
if (response.generation <= local.generation) {
    丢弃本次响应，保留本地凭据      // 乱序响应，本地已更新
} else {
    串行写入 SecureStore
}
```

**为什么必需**：即使 RG-6 生效，网络乱序仍可能让先发出的 refresh 后返回（例如 A-6 主动预刷新与 401 触发的刷新在极窄窗口内并存）。没有这道守卫，旧凭据会覆盖新凭据，下一次 refresh 就会命中 grace，反复几次即触发 RG-10 被撤销会话 —— 表现为用户莫名被登出。

**A-9 凭据写入串行化（RG-7）。** SecureStore 凭据写入必须经一个模块级串行队列（Promise 链或互斥锁），保证「读取本地 generation → 比较 → 写入」是一个不可分割的临界区。仅靠 SecureStore 单键原子写**不足以**满足 RG-7 —— 单键原子只保证单次写入不产生半状态，不保证两次「读-比较-写」不交错。

**A-2 最多重放一次。** 请求上下文携带 `__replayed: boolean`。禁止任何形式的循环重试。

**A-3 只有认证中间件产生的 401 可重放。** 关键论证：`requireMobileAuth` 在**业务 handler 之前**执行，因此 `40101`/`40102` 意味着**handler 从未运行**，重放天然安全，不存在重复副作用。其他来源的 401 不具备这个保证，一律不重放。**服务端必须保证 `40101`/`40102` 只由认证中间件产生**，业务层不得复用这两个码。

**A-4 禁止自动重放的请求类型：**

| 请求 | replayable | 理由与替代方案 |
|---|---|---|
| `POST /api/o2o/mall/preorders`（下单） | ✅ 可重放 | 已有 `clientRequestId` 幂等键（035），且 A-3 保证 handler 未执行。**双重保险** |
| `POST .../preorders/:id/cancel` | ✅ 可重放 | A-3 保证；服务端 CAS 领取本身幂等 |
| `PATCH .../preorders/:id`（改单） | ⚠️ 可重放但需谨慎 | A-3 保证 handler 未执行。但改单会消耗 `updateCount` 配额，**建议标 `replayable=false`**，由 UI 层提示用户重试，避免任何配额争议 |
| `POST .../preorders/:id/returns`（退货） | ✅ 可重放 | A-3 保证；服务端有可退数量校验兜底 |
| **文件上传（multipart）** | ❌ **禁止重放** | RN 的 FormData 与 fetch body 在首次消费后重建成本高且易错。改用**主动预刷新**：发起上传前若 access 剩余有效期 < 120 秒，先 refresh 再上传 |

**A-5 与 Idempotency-Key 的关系。** 两者解决**不同**问题，不可互相替代：

- `Idempotency-Key` / `clientRequestId` 解决的是**响应丢失后的网络级重试**（服务端已执行，客户端不知道）
- A-3 的重放解决的是**认证失败后的重试**（服务端未执行）

因此：下单类请求**必须同时具备**幂等键与正确的 401 策略。Native adapter 已支持 `idempotencyKey`（`types.ts:11`，`native-fetch-adapter.ts:215-217`），业务层必须为每次**用户意图**生成一个稳定 key 并在所有重试中复用（含 401 重放）。**重放时不得重新生成 key。**

**A-6 主动预刷新。** 请求发出前检查本地 `accessExpiresAt`，剩余 < 60 秒则先走 single-flight refresh。可消除绝大多数 401 往返。上传类请求阈值提高到 120 秒。

**A-7 refresh 自身的 401 不得递归。** refresh 端点的请求必须绕过 401 拦截逻辑。

---

## SecureStore Contract

现状：`apps/mobile/src/platform/secure-storage.ts` 是纯字符串包装，**无多键原子性**。

### 键位设计

| 键 | 内容 | 生命周期 |
|---|---|---|
| `ylk.mobile.credentials` | **单个 JSON 字符串**，见下 | 登录时写，refresh 时整体覆写，登出时删除 |
| `ylk.device.id` | deviceId（UUID v4） | 首次启动生成，**登出时保留**，仅卸载重装时重建 |

### `ylk.mobile.credentials` 结构

```jsonc
{
  "v": 1,
  "accessToken": "ylma_...",
  "accessExpiresAt": "2026-08-13T10:15:00.000Z",
  "refreshToken": "ylmr_...",
  "refreshExpiresAt": "2026-09-12T10:00:00.000Z",
  "absoluteExpiresAt": "2026-11-11T10:00:00.000Z",
  "sessionId": "1024",
  "generation": 7,              // ← RG-8/RG-9：服务端返回的 refresh_generation
  "userId": "88",
  "writeSeq": 12
}
```

### 半状态防护（总线关注点）

**唯一写入规则**：access 与 refresh **必须始终作为同一个 JSON 字符串、通过一次 `SecureStore.setItemAsync` 写入**。禁止拆成两个键分别写。

论证：`SecureStore.setItemAsync` 对单个键是原子的（底层为 Android Keystore / iOS Keychain 的单项写）。把整个凭据束放进一个键，就把"access 已更新、refresh 未更新"的半状态在物理上消除了 —— 要么整束旧的，要么整束新的。

### 两层防护缺一不可

| 层 | 机制 | 消除的问题 |
|---|---|---|
| 单键原子写 | 整束 JSON 一次 `setItemAsync` | access/refresh 不同步的**半状态** |
| 串行化 + generation 守卫（RG-7 / RG-9） | 模块级互斥锁包住「读 generation → 比较 → 写」 | 两次 refresh **交错**、旧 generation **覆盖**新凭据 |

单键原子写**不能**替代串行化：前者保证单次写入不撕裂，后者保证多次「读-比较-写」不交错。两者解决不同问题。

### 字段语义

- `generation`：来自服务端响应（RG-8），是判定凭据新旧的**唯一权威依据**。写入前必须执行 RG-9 守卫。**不参与认证**，仅用于本地新旧比较。
- `writeSeq`：本地单调递增计数，用于崩溃后诊断与日志关联。**不参与认证，也不参与新旧判定**（本地计数在多进程/重装场景不可靠，判定必须用服务端的 `generation`）。

### 禁止存储

- ❌ 密码（任何形式，含"记住密码"）
- ❌ 验证码
- ❌ 图形验证码答案
- ❌ 任何长期敏感明文

### SQLite（`apps/mobile/src/db/`）禁令

**本地 SQLite 不得存储任何 token 明文或 token hash。** 业务缓存表只能存 `userId` 作为归属标识。这与 `MASTER_PLAN.md` §5.1「`src/db/`：不保存明文 token、密码或验证码」一致。

### 登出必须清除的内容

| 类别 | 动作 |
|---|---|
| `ylk.mobile.credentials` | **删除** |
| `ylk.device.id` | **保留**（下次登录复用同一会话槽位，避免重复占用上限） |
| TanStack Query 缓存 | 全量 `queryClient.clear()` |
| 本地 SQLite 业务缓存 | 清除所有含用户数据的表（订单、购物车草稿、反馈会话、个人资料） |
| Zustand auth store | 重置为 `unauthenticated` |
| 内存中的 refresh single-flight | 置空 |

**清理顺序**：先清内存态（避免正在飞行的请求继续用旧 token），再清 SecureStore，最后清缓存。清理必须是幂等的，允许重复调用。

---

## Password / Reset Semantics

### 修改密码（已知原密码，已登录）

总线口径：撤销所有旧 Mobile Session，为当前设备签发新 session，用户不需重新登录。

**判定：采纳，并正式化如下。**

`POST /api/v1/mobile-auth/change-password`，认证 `Bearer(access)`，单事务内：

1. 校验 `currentPassword`（复用现有 `verifyPassword`）
2. 校验新密码策略（复用 `assertClientPasswordPolicy`）
3. 写入新 `password_hash`
4. **撤销该用户全部 `client_mobile_session`**（`revoke_reason='password_changed'`）
5. **删除该用户全部 `client_user_session`**（Web 会话，与现有 `changePassword` 行为一致）
6. **为请求中的 deviceId 签发一套全新会话**，返回完整 `MobileAuthSessionDTO`
7. 写 `password_changed` 审计

安全论证：第 6 步是「便利性」让步，安全上可接受，因为该设备刚刚成功证明了它知道**原密码 + 持有有效 access token**（双因子）。而第 4/5 步保证了所有**其他**设备（包括可能的攻击者设备）立即失效 —— 这才是改密的核心安全目的。

**实现约束**：第 6 步签发的必须是**全新的会话行与全新的 token family**，不得复用旧行、不得保留旧的 `previous_refresh_token_hash`。客户端收到响应后必须整束覆写 SecureStore。

### 忘记密码 / 重置密码（未登录）

总线口径：全部 Web + Mobile session 撤销，用户重新登录。

**判定：采纳，无修改。**

`POST /api/v1/mobile-auth/forgot-password/reset` 单事务内：

1. 校验 resetToken（复用现有 `EphemeralTicketStore` 票据）
2. 写入新 `password_hash`
3. 撤销全部 `client_mobile_session`（`revoke_reason='password_reset'`）
4. 删除全部 `client_user_session`
5. 销毁 resetToken
6. **不签发任何会话**，返回 `{ "data": { "ok": true } }`
7. 写 `password_changed` 审计（`detail.via = 'reset'`）

安全论证：与改密不同，重置流程中请求方**未证明持有原密码**，只证明了控制验证渠道（手机/邮箱）。此时不应自动授予会话 —— 若验证渠道本身已被攻陷，自动签发会直接把会话交给攻击者。强制重新登录增加一道密码确认。

### 资料更新中的敏感变更

`PATCH /profile` 修改手机号或邮箱时，**不撤销会话**（现有行为，保持）。但必须写审计，且若该渠道是登录账号本身，建议在响应中提示用户检查活跃设备。

---

## Revocation

### 撤销的统一语义

撤销 = 置 `revoked_at = now()` + `revoke_reason`。**不物理删除行**，保留至清理任务回收（默认保留 30 天），以支撑事后取证。

### 撤销即时生效路径

| 触发 | 生效点 | 延迟 |
|---|---|---|
| 用户登出 / 撤销设备 | 下一次请求的会话查询 | 0 |
| 改密 / 重置密码 | 同上 | 0 |
| 检测到 refresh 重放 | 同上 | 0 |
| 会话数上限淘汰 | 同上 | 0 |

**无缓存、无宽限。** 认证中间件每次都查库（走 `access_token_hash` 唯一索引）。

### Disabled Account（T7，必须保持的既有安全属性）

当前 Web 侧实现（`client-auth.service.ts:847`）在 `resolveClientByToken` 中每请求校验 `session.user.status !== 'enabled'` → 403。**Mobile 必须继承并扩展**：

**实现路径（三处，缺一不可）：**

1. **Access 校验路径**（`requireMobileAuth`）——
   会话查询 `JOIN client_user`，`status !== 'enabled'` 立即返回 `403 / 40300`。**不得**依赖任何缓存的用户状态。
2. **Refresh 路径** ——
   同样 JOIN 校验。停用账号的 refresh **必须失败**（`403 / 40300`），并顺带撤销该会话（`revoke_reason='account_disabled'`），防止账号恢复后旧血缘复活。
3. **管理端停用动作** ——
   `client-user-manage.service.ts` 中停用客户端账号时，在**同一事务内**批量撤销该用户全部 `client_mobile_session`，写 `account_disabled_session_rejected` 审计。这一步让停用**立即**反映在会话表上，而不只是靠每请求的 JOIN 兜底。

三者叠加保证：**不等待 access TTL 自然结束**，账号停用后第一次请求即失败。

**性能要求**：JOIN 使得每请求多一次关联查询。必须有 `client_mobile_session.access_token_hash` 唯一索引 + `client_user.id` 主键，两次索引查找，可接受。SQLite 下这是**纯读**路径，不进写队列。

### 过期与撤销会话清理

后台定时任务（复用 `runtime/runtime-shutdown.ts` 的生命周期管理模式，参考 `o2oPreorderService.startTimeoutRecycleLoop()` 的写法）：

- 周期：每小时
- 删除 `revoked_at < now() - 30d` 或 `absolute_expires_at < now() - 30d` 的行
- 分批（每批 ≤ 200 行），批间让出，**避免长时间占用 SQLite 写队列**
- **禁止**挂在登录路径上（Delta 报告 Finding 9 的教训）

---

## Rate Limiting

**原则：全部复用 `authSecurityService`，不新建第二套体系。** 该服务已把风控状态持久化到 `auth_risk_state` 表（033 迁移），支持跨重启与多实例共享。

### 复用既有守卫（零改动）

| 场景 | 现有方法 | 现有限额 |
|---|---|---|
| 登录 | `guardClientLoginRequest` / `recordClientLoginFailure` / `clearClientLoginFailures` | 18 次/5min（按账号源），120 次/5min（IP 兜底） |
| 注册 | `guardClientRegisterSourceRequest` / `guardClientRegisterAccountRequest` | 40 次/30min（源），10 次/24h（账号） |
| 图形验证码 | `guardClientCaptchaRequest` | 复用 |
| 验证码发送 | `guardVerificationCodeSendRequest` | 复用 |
| 忘记密码校验 | `guardClientForgotVerifyRequest` | 8 次/30min（源） |
| 忘记密码重置 | `guardClientForgotResetRequest` | 复用 |

### 需新增的唯一守卫

`guardMobileRefreshRequest(requestMeta, sessionScopeKey)`，按 `authSecurityService` 现有 `RATE_LIMIT_RULES` 的结构追加：

```ts
mobileRefreshBySession: {
  maxRequests: 60,
  windowMs: 60 * 60 * 1000,
  blockMessage: '令牌刷新过于频繁，请稍后重试',
},
mobileRefreshByIpFallback: {
  maxRequests: 600,
  windowMs: 60 * 60 * 1000,
  blockMessage: '当前网络下刷新请求过于频繁，请稍后重试',
},
```

**限额论证**：access TTL 15 分钟 → 正常单会话 4 次/小时。60 次/小时给出 15 倍裕量，足以覆盖弱网重试、多线程抖动与前后台切换，同时对暴力枚举 refresh token 构成有效阻断。

`sessionScopeKey` 取 `sha256(refreshToken)` 的前 16 位 —— **不要用明文 token 作限流键**，避免明文进入风控状态存储。若 token 无匹配会话（NO_MATCH），退化到 IP 兜底桶，防止用限流探测 token 有效性。

### 限流不得与重放检测互相干扰

`40113`（重放检测）**优先于**限流判定。即：先判定是否重放并撤销，再考虑限流。否则攻击者可以用限流把自己"保护"起来，避免触发重放检测。

---

## Audit

全部复用 `auditService.record(input, manager?)`（`audit.service.ts:91`），字段映射：

| 事件 `actionType` | `actionLabel` | `targetType` | `targetId` | detail 关键字段 | 结果 |
|---|---|---|---|---|---|
| `mobile_login` | Mobile 登录 | `client_mobile_session` | session id | deviceId, deviceName, platform, appVersion, evictedSessionId? | success / failed |
| `mobile_refresh` | Mobile 刷新令牌 | `client_mobile_session` | session id | generation, viaGrace | success |
| `refresh_replay_detected` | **检测到刷新令牌重放** | `client_mobile_session` | session id | generation, graceExpiredBySeconds, trigger（`prev_expired` / `burst`） | failed |
| `mobile_logout` | Mobile 登出 | `client_mobile_session` | session id | deviceId | success |
| `mobile_logout_all` | Mobile 全部登出 | `client_user` | user id | scope, revokedCount | success |
| `mobile_session_revoked` | Mobile 会话撤销 | `client_mobile_session` | session id | revokeReason, initiatedBy | success |
| `password_changed` | 客户端修改密码 | `client_user` | user id | via（`change` / `reset`）, revokedMobileCount, revokedWebCount, reissuedSessionId? | success |
| `account_disabled_session_rejected` | 停用账号会话拒绝 | `client_mobile_session` | session id | attemptedEndpoint | failed |

### 通用记录字段

`actor` = `{ userId, username, displayName }`，从 `toClientProfile` 投影取；`requestMeta` = `{ ipAddress, userAgent }`，用现有 `extractRequestMeta(req)`。时间由 `SysAuditLog` 自带。

### 强制禁令

- ❌ **任何审计 detail、日志、错误响应中不得出现 token 明文或完整 hash**。需要关联时只记录 hash 前 8 位（`hashPrefix`）。
- ❌ 不得记录密码、验证码、resetToken。
- ❌ `NO_MATCH` 的 refresh 不写审计（防止攻击者用垃圾 token 制造审计洪水淹没真实事件）。
- ✅ `refresh_replay_detected` 是**最高价值的安全事件**，应接入通知中心告警（`notification.service.ts`），而不只是写审计表。

### 告警建议

`refresh_replay_detected` 与短时间内大量 `account_disabled_session_rejected` 应触发运维通知。具体规则由通知中心配置，不在本契约硬编码。

---

## SQLite / MySQL Schema Requirements

**本轮不执行迁移。** 以下是实现时必须产出的 schema 需求。

### 表定义（两库一致的逻辑结构）

见 Session Data Model 的字段表。方言差异统一走 `entities/entity-column-options.ts` 的 `primaryId` / `foreignId` / `timestamp` / `booleanFlag`，**不要在实体里手写方言分支**。

### 索引与约束

| 名称 | 列 | 唯一 | 用途 |
|---|---|---|---|
| `uk_mobile_session_access_hash` | `access_token_hash` | ✅ | **每请求认证主查询** |
| `uk_mobile_session_refresh_hash` | `refresh_token_hash` | ✅ | refresh 主查询 |
| `idx_mobile_session_prev_refresh_hash` | `previous_refresh_token_hash` | ❌ | 宽限与重放检测查询 |
| `idx_mobile_session_user_active` | `client_user_id`, `revoked_at`, `last_access_at` | ❌ | 会话列表、上限淘汰（LRU） |
| `idx_mobile_session_user_device` | `client_user_id`, `device_id`, `revoked_at` | ❌ | 同设备去重 |
| `idx_mobile_session_cleanup` | `revoked_at`, `absolute_expires_at` | ❌ | 后台清理扫描 |
| `fk_mobile_session_user` | `client_user_id` → `client_user.id` | — | `ON DELETE CASCADE ON UPDATE RESTRICT` |

**`previous_refresh_token_hash` 不加唯一约束**：轮换过程中它会短暂等于某个曾经的 `refresh_token_hash`，加唯一会造成不必要的冲突。查询靠普通索引即可。

### MySQL 侧

- 新建 `037_mobile_auth_session.sql`，沿用 034/035/036 的 `information_schema` + 动态 DDL 守卫模式，保证在存量库上可重复执行
- 引擎 `InnoDB`，字符集 `utf8mb4` / `utf8mb4_0900_ai_ci`
- **必须同步登记**到 `backend/src/config/mysql-migration-runner.ts`：
  - `MYSQL_REQUIRED_TABLES` 增加 `client_mobile_session`
  - `MYSQL_REQUIRED_COLUMNS` 增加本表被业务直接读写的增量列（参考现有 `:99-113` 的写法）
  - `MYSQL_REQUIRED_INDEXES` 增加上表三个关键索引，`unique` 标志与列顺序必须精确
  - `introducingScript` 一律填 `'037_mobile_auth_session.sql'`

### SQLite 侧

- 上一轮 Delta 已实测确认：**实体上的 `@Index(..., { unique: true })` 装饰器在 SQLite 侧会真实建出 UNIQUE 索引**（以 `uk_o2o_preorder_client_request` 验证）。因此 SQLite 不需要单独的 DDL 脚本
- 但**必须**在 `backend/src/config/database-bootstrap.ts` 中登记本表的必需列（参考 `SQLITE_REQUIRED_O2O_PREORDER_COLUMNS` 的模式，`:184` 起），否则旧库升级会静默缺列
- 新增 `sqlite:legacy-upgrade:verify` 的覆盖用例

### 迁移安全要求

- 新表**不携带存量数据**，无回填需求，无回退数据风险
- 回退脚本：`DROP TABLE client_mobile_session`（不影响任何既有表）
- **不得**依赖 `synchronize` 自动建表（`AGENTS.claude.md` §4）
- 迁移前后必须跑 `verify:mysql:schema-contract` 与 `sqlite:legacy-upgrade:verify`

---

## MySQL Gate（总线裁定）

### 本文档不设数据库门禁

**Auth Contract 文档本身不要求任何数据库运行测试。** 本文是设计契约，不含可执行代码，docs-only PR 不需要跑 SQLite 或 MySQL 集成测试。

### 实现 PR 的强制门禁

**Mobile Auth 实现 PR 进入 `main` 前，必须同时通过 SQLite 与 MySQL 两套认证集成测试。**

必须覆盖的七个维度，**两套环境各跑一遍**：

| # | 维度 | 为什么两库必须分别验证 |
|---|---|---|
| G-1 | **row lock / CAS** | MySQL 走 `SELECT ... FOR UPDATE` 真实行锁；SQLite 走 TransactionCoordinator 单写队列。**完全不同的两条代码路径**，行为不可互推 |
| G-2 | **concurrent refresh** | 并发语义的核心。SQLite 的串行化会掩盖 MySQL 下的锁等待、死锁与超时 |
| G-3 | **rotation** | CAS 的 `affected` 判定在两库的驱动返回值语义需分别确认 |
| G-4 | **replay** | 依赖 `previous_refresh_token_hash` 索引查询与事务可见性，两库隔离级别不同 |
| G-5 | **revoke** | 批量撤销在 MySQL 下涉及多行锁，SQLite 下无 |
| G-6 | **password change** | 跨表事务（`client_mobile_session` + `client_user_session` + `client_user`），MySQL 下存在死锁风险 |
| G-7 | **disabled account** | JOIN 查询计划与索引命中在两库不同 |

### 硬性声明

> **SQLite 全部通过，不能替代 MySQL 验证，也不构成 MySQL 正确性的任何证据。**

这不是保守表述，而是上一轮 Delta Re-Baseline 的实证结论：SQLite 下所有写事务经单写队列**完全串行**，这会系统性掩盖 MySQL 下才会暴露的锁竞争、死锁、可见性与重试问题。以 SQLite 通过为由跳过 MySQL 验证，等同于未验证并发正确性。

### 环境前置

MySQL 集成测试需要 Docker + MySQL 8.4（参考 `compose.verify-db-concurrency.yml` 与 `verify:db:concurrency` 的既有编排）。**若该环境不可用，Mobile Auth 实现 PR 不得合入 `main`** —— 这是阻塞项，须优先解决而非绕过。

---

## Required Tests

Codex 必须交付以下测试矩阵，建议落在 `backend/scripts/mobile-auth-contract-verify.ts`（沿用现有 verify 脚本风格，独立 `APP_PROFILE`），并在 `package.json` 注册 `mobile-auth:contract:verify`。

**执行要求**：服务端用例（T-01 ~ T-73）必须在 **SQLite 与 MySQL 两套环境下各跑一遍**并分别留存输出，见 MySQL Gate。客户端用例（T-60 ~ T-66）只需跑一次。

### 核心生命周期

| # | 用例 | 前置 | 动作 | 断言 |
|---|---|---|---|---|
| T-01 | login 签发 | 已注册账号 | 正确凭据登录 | 返回 access/refresh/session/user；DB 中 1 行会话；**明文不等于任何 DB 字段**；hash 匹配 |
| T-02 | access 认证 | T-01 | 带 access 调 `/me` | 200；`last_access_at` 未被每请求写入（连续 3 次请求只写 ≤1 次） |
| T-03 | 正常 refresh | T-01 | 用 refresh 换新 | 200；新 access ≠ 旧；新 refresh ≠ 旧；`generation` +1；`PREV` == 旧 refresh hash |
| T-04 | rotation 后旧 access 失效 | T-03 | 用旧 access 请求 | 401 `40101` |
| T-05 | access 自然过期 | 篡改 `access_expires_at` 为过去 | 请求 | 401 `40102` |
| T-06 | refresh 自然过期 | 篡改 `refresh_expires_at` | refresh | 401 `40111` |
| T-07 | 绝对过期 | 篡改 `absolute_expires_at` | refresh | 401 `40112`；会话被撤销 |

### 并发与宽限（最高优先级）

| # | 用例 | 动作 | 断言 |
|---|---|---|---|
| T-10 | **并发 refresh（同 token）** | 同一 refresh token 并发 10 次 | **全部 200**（无一 401）；无会话被撤销；`generation` 增长 ≤ 10 |
| T-11 | 宽限窗口内重试 | refresh 成功后，用旧 token 在 30 秒内再 refresh | 200；会话未撤销；审计 `viaGrace=true` |
| T-12 | **宽限窗口后重放** | refresh 成功后，等待 > 60 秒，用旧 token refresh | 401 `40113`；会话 `revoked_at` 非空、`revoke_reason='refresh_replay_detected'`；审计已写 |
| T-13 | token family 撤销 | T-12 之后 | 该会话的 access 与当前 refresh **全部失效**（401） |
| T-14 | 抖动安全阀 SV-1 / RG-10 | 观测窗口内制造超阈值轮换 | 会话被撤销；`trigger='burst'`；审计已写；**阈值取自 env 而非硬编码** |
| T-15 | 未知 refresh token | 随机 64 hex | 401 `40110`；**无任何会话被撤销**；**无审计写入** |
| T-16 | 被盗旧 refresh（跨代） | 保存 gen0 token，轮换 3 代后使用 | 401（`40110` 或 `40113`）；不得返回 200 |

### RG 不变量专项（总线新增）

| # | 对应 | 用例 | 断言 |
|---|---|---|---|
| T-70 | **RG-1** | 同一 session 并发 refresh，服务端插桩记录临界区进出时刻 | 临界区**无重叠**；MySQL 下可观测到行锁等待；SQLite 下由写队列串行 |
| T-71 | **RG-3** | 在 CAS UPDATE 后、事务提交前强制抛错回滚 | `CUR` / `PREV` / `GRACE_UNTIL` / `generation` **四项全部未变**；原 refresh token 仍可用（无中间态） |
| T-72 | **RG-7** | 客户端并发触发两次凭据写入 | 两次「读-比较-写」**不交错**；最终存储自洽且为较新 generation |
| T-73 | **RG-8 / RG-9** | 构造乱序响应：先收到 gen=8，再收到 gen=7 | gen=7 的写入被**丢弃**；本地保持 gen=8；下一次 refresh 命中 `MATCH_CUR`（不命中 grace） |
| T-74 | **RG-2** | 连续 5 次成功 refresh | `generation` 严格递增 `+1`，无跳变、无回退、无重复 |
| T-75 | **RG-5** | 正常运行 100 次 refresh（客户端 single-flight 生效） | `viaGrace=true` 的审计条数为 **0**（grace 不应在正常路径被触发） |
| T-76 | **RG-8** | 检查 login / register / refresh / change-password 四类响应 | **全部**返回 `generation` 字段 |

### 多设备

| # | 用例 | 断言 |
|---|---|---|
| T-20 | 两设备并行登录 | 2 行会话，血缘独立；A 的 refresh 不影响 B |
| T-21 | 两设备同时 refresh | 均 200；互不撤销 |
| T-22 | 同设备重复登录 | 旧会话被撤销，活跃行数仍为 1 |
| T-23 | 撤销指定设备 | 目标失效；当前设备不受影响 |
| T-24 | 撤销他人会话 | 用 A 的 access 删 B 的 session id → **404**（非 403） |
| T-25 | `logout-all?scope=others` | 其他全失效，当前仍有效 |
| T-26 | `logout-all?scope=all` | 全部失效含当前 |
| T-27 | **会话数上限** | 建 11 个设备会话 | 活跃数恰为 10；最旧被淘汰；`revoke_reason='session_limit_evicted'`；审计已写 |

### 密码与账号状态

| # | 用例 | 断言 |
|---|---|---|
| T-30 | 改密 | 其他设备全失效；**当前设备拿到全新可用令牌对**；Web `client_user_session` 也被清空；新会话 `generation=0` 且 `PREV` 为空 |
| T-31 | 重置密码 | **全部**会话失效含当前；**不签发**新会话；重新登录可用 |
| T-32 | 停用账号 → access | 停用后立即用 access 请求 → 403 `40300`（不等 TTL） |
| T-33 | 停用账号 → refresh | 停用后 refresh → 403 `40300`；会话被撤销 |
| T-34 | 管理端停用即时撤销 | 停用动作完成后直接查 DB，该用户全部 mobile 会话 `revoked_at` 非空 |

### 协议与边界

| # | 用例 | 断言 |
|---|---|---|
| T-40 | 畸形 Bearer | `Authorization: Bearer`（空）、`Bearer  `、`Basic xxx`、超长串、含控制字符 | 全部 401 `40100`；无 5xx；无异常堆栈泄露 |
| T-41 | 错误前缀 | 用 `ylmr_`（refresh）当 access 用 | 401；**不得**命中 access 索引 |
| T-42 | 跨表互斥 | Web session token 放 Bearer | 走 Web 分支解析，**不得**命中 `client_mobile_session` |
| T-43 | **Mobile token 放 Cookie** | 设 `y_link_client_session=ylma_...` | 401；不得被 Web 分支接受 |
| T-44 | deviceId 非凭据 | 用 A 的 access + B 的 deviceId 请求 | 200（认证成功），会话归属仍是 A，不发生任何提权 |
| T-45 | deviceId 格式 | 超长 / 非法字符 | 400 |
| T-46 | URL 不承载 token | 扫描全部端点定义 | 无任何 query 参数接收 token |

### Web 兼容性回归（R-B3 变更的守门）

R-B3 是本契约对既有中间件的唯一行为变更，以下用例是它的守门。**这三条不通过，实现 PR 不得合入。**

| # | 场景 | 请求构造 | 断言 |
|---|---|---|---|
| **T-W1** | Web 纯 Cookie（现状回归） | 只带有效 `y_link_client_session` Cookie，**无 `Authorization`** | 200；解析为 `client_user_session`；行为与变更前**逐字节一致** |
| **T-W2** | Cookie + 有效 Mobile Bearer | 同时携带有效 Cookie 与有效 `ylma_*` | 200；**Bearer 胜出**，解析为 `client_mobile_session`；`clientAuth` 归属为 mobile 会话所属用户 |
| **T-W3** | 历史无前缀 Bearer | 只带无前缀 Bearer，**无 Cookie** | 走 Web 分支查 `client_user_session`；行为不变 |
| **T-W4** | **无效 Bearer + 有效 Cookie（无 fallback 守门）** | 携带**已过期/已撤销/垃圾**的 `Authorization`，同时携带**有效** Cookie | **401** —— **绝不允许**回退 Cookie 而返回 200 |
| **T-W5** | 已撤销 Mobile token + 有效 Cookie | 先 logout 使 mobile token 失效，再带该 token + 有效 Cookie | **401**；证明 Mobile 侧撤销不会被 Cookie 静默绕过 |
| **T-W6** | 非 Bearer scheme + 有效 Cookie | `Authorization: Basic xxx` + 有效 Cookie | **401**；`Authorization` 存在即独占，不看 scheme 是否是 Bearer |
| **T-W7** | 空 Bearer + 有效 Cookie | `Authorization: Bearer`（无 token）+ 有效 Cookie | **401** |
| **T-W8** | Mobile 认证路由拒绝 Cookie | 对 `/api/v1/mobile-auth/me` 只带有效 Cookie、无 Bearer | **401**；Mobile 路由不接受 Cookie（R-B2） |

**T-W4 ~ T-W7 是本轮总线新增的核心守门用例。** 它们验证的是「`Authorization` 存在即独占、失败不回退 Cookie」这条规则 —— 缺了它们，一个已撤销的 Mobile 会话可以静默降级为 Cookie 会话继续可用，直接击穿撤销语义。

### 限流与审计

| # | 用例 | 断言 |
|---|---|---|
| T-50 | refresh 限流 | 单会话 1 小时内 > 60 次 | 429 `42900`，带 `retryAfterSeconds` |
| T-51 | 限流不掩盖重放 | 已触发限流后提交过期旧 token | 仍返回 `40113` 并撤销会话 |
| T-52 | 审计无明文 | 全流程后扫描 `sys_audit_log.detail_json` | 不含任何 token 明文、完整 hash、密码、验证码 |
| T-53 | 登录失败限流复用 | 连续错误密码 | 走既有 `authSecurityService` 计数与锁定，**未新建并行计数器** |

### 客户端侧（`packages/api-client` 单元测试）

| # | 用例 | 断言 |
|---|---|---|
| T-60 | single-flight（**RG-6**） | 并发 5 个请求同时 401 | 只发起 **1 次** refresh |
| T-61 | 最多重放一次 | refresh 后重放仍 401 | 不再重试，进入登出清理 |
| T-62 | 非 40101/40102 不 refresh | 返回 `40113` | 直接清凭据，**不调用 refresh** |
| T-63 | 上传不自动重放 | multipart 请求 401 | 不重放；错误上抛 |
| T-64 | 幂等键在重放中保持 | 带 `Idempotency-Key` 的请求被重放 | 两次请求的 key **完全相同** |
| T-65 | SecureStore 原子性 | refresh 成功 | 只发生 **1 次** `setItemAsync`，键为 `ylk.mobile.credentials` |
| T-66 | 登出清理完整性 | 调用 logout | credentials 已删；deviceId **保留**；query 缓存已清；SQLite 业务表已清 |
| T-67 | single-flight 失败恢复（**RG-6**） | 首次 refresh 抛错 | 单飞变量被置空；后续请求可再次发起 refresh，不永久卡死 |
| T-68 | 单飞变量作用域（**RG-6**） | 组件卸载重建后再触发 401 | 仍复用**同一个**模块级单飞，不产生第二份 |

---

## Implementation Checklist for Codex

按顺序实施，每步完成后运行对应验证。**任何一步需要偏离本契约，必须先回报总线，不得自行决定。**

### 阶段 1 —— 数据层

- [ ] 新建实体 `backend/src/entities/client-mobile-session.entity.ts`，字段与索引严格对齐 Session Data Model；方言差异只用 `entityColumnOptions`
- [ ] 注册到 `backend/src/config/data-source.ts` 的 `appEntities`（**遗漏会导致跨库迁移丢表**）
- [ ] 新建 `backend/sql/037_mobile_auth_session.sql`，沿用 034/035/036 的 `information_schema` 守卫模式
- [ ] 登记 `mysql-migration-runner.ts` 的 `MYSQL_REQUIRED_TABLES` / `COLUMNS` / `INDEXES`
- [ ] 登记 `database-bootstrap.ts` 的 SQLite 必需列清单
- [ ] 运行 `verify:mysql:schema-contract` 与 `sqlite:legacy-upgrade:verify`

### 阶段 2 —— 令牌与会话服务

- [ ] 新建 `backend/src/utils/mobile-token.ts`：前缀常量、生成、解析、前缀判别；**内部复用** `generateSessionToken` 与 `hashSessionToken`，不新写随机数与哈希
- [ ] 新建 `backend/src/services/mobile-auth.service.ts`
- [ ] 从 `client-auth.service.ts` **抽取**（不复制）账号校验、密码校验、验证码、员工目录、`toClientProfile` 为可复用方法
- [ ] 实现签发 / 轮换 / 撤销，全部走 `runInTransaction`；轮换用 CAS（参考 `o2o-preorder.service.ts` 的 `cancelOrderInManager`）
- [ ] 实现会话上限 LRU 淘汰与同设备去重
- [ ] `last_access_at` 写入节流（≥60 秒），复用现有常量语义

### 阶段 3 —— 中间件与边界

- [ ] 新建 `backend/src/middleware/mobile-auth.middleware.ts`（`requireMobileAuth`），**只读 Bearer，绝不读 Cookie**
- [ ] 修改 `client-auth.middleware.ts` 的取值优先级为 Bearer 优先 + 前缀分派（**唯一允许的既有文件行为变更**）
- [ ] 必须先让 T-W1 / T-W2 / T-W3 通过，再继续

### 阶段 4 —— 路由

- [ ] 新建 `backend/src/routes/mobile-auth.routes.ts`，挂载 `/api/v1/mobile-auth`
- [ ] 全部入参走 zod schema，风格对齐 `o2o.routes.ts` 的 `submitPreorderSchema`
- [ ] 接入 `authSecurityService` 各守卫；新增 `guardMobileRefreshRequest`
- [ ] 接入 `auditService`，字段严格对齐 Audit 章节
- [ ] 运行 `task2:route-contract:verify` 与 `permission:regression:verify`

### 阶段 5 —— 停用账号联动

- [ ] `client-user-manage.service.ts` 停用动作内，同事务批量撤销该用户全部 mobile 会话
- [ ] 后台清理任务（每小时、分批、可优雅停机），**不得挂在登录路径**

### 阶段 6 —— 客户端

- [ ] `packages/api-client`：401 策略、**模块级 single-flight（RG-6）**、单次重放、`replayable` 标记
- [ ] `packages/api-client`：**generation 守卫（RG-9）** 与 **凭据写入串行化（RG-7）**
- [ ] `apps/mobile`：SecureStore 单键凭据束（含 `generation`）、deviceId 生成与持久化、auth store、登出清理
- [ ] 补齐 T-60 ~ T-68 单元测试

### 阶段 7 —— 验证（MySQL Gate）

- [ ] `backend/scripts/mobile-auth-contract-verify.ts` 覆盖 T-01 ~ T-76 与 T-W1 ~ T-W8
- [ ] `package.json` 注册 `mobile-auth:contract:verify`
- [ ] `npm --prefix backend run build`
- [ ] `npm run verify:text-encoding`
- [ ] `npm --prefix backend run write-transaction:contract:verify`
- [ ] **SQLite 环境**下跑通全部服务端矩阵，留存输出
- [ ] **MySQL 环境**下跑通全部服务端矩阵，留存输出 —— 覆盖 G-1 ~ G-7 七个维度
- [ ] 两套输出**同时**附在实现 PR 中；**缺任一套即不得合入**

### 明确禁止

- ❌ 不得引入 JWT 或任何自验证令牌
- ❌ 不得在服务端缓存 token 明文
- ❌ 不得复用 `client_user_session` 承载 Mobile 会话
- ❌ 不得新建第二套限流体系
- ❌ 不得为 Mobile 改动 Web Cookie / CSRF 行为（除 R-B3 的独占规则）
- ❌ **不得在 Bearer 校验失败后回退 Cookie**（R-B3）
- ❌ 不得把轮换速率阈值写成业务常量（必须走 env 安全参数）
- ❌ 不得用 SQLite 测试结果替代 MySQL 验证
- ❌ 不得在本契约之外自行发明错误码或字段

---

## Claude Review Checklist

下一轮高风险审查按此逐条核验：

**令牌与存储**
- [ ] DB 中确无明文 token（直接查表断言）
- [ ] 明文只在签发响应出现一次，无第二处返回
- [ ] 前缀分派正确，跨表不可互认（T-41 ~ T-43）
- [ ] 熵与哈希算法符合规格；未误用慢哈希

**Refresh 状态机与 RG 十条不变量（最高优先级）**
- [ ] 四种输入分类的判定逻辑与转换表逐行一致
- [ ] **RG-1** 同 session refresh 串行（MySQL 行锁 / SQLite 写队列），T-70 有证据
- [ ] **RG-2** `generation` 用数据库端自增表达，非「读-加-写」，T-74 通过
- [ ] **RG-3** 四项状态迁移在**单条** CAS UPDATE 内，T-71 证明无中间态
- [ ] **RG-4** grace 窗口用服务端时间判定，不接受客户端参数
- [ ] **RG-5** 正常路径 `viaGrace` 命中率为 0（T-75）
- [ ] **RG-6** 单飞在模块作用域、`finally` 置空（T-60/67/68）
- [ ] **RG-7** 凭据写入有串行队列，不只靠单键原子（T-72）
- [ ] **RG-8** 四类签发响应**全部**返回 `generation`（T-76）
- [ ] **RG-9** 旧 generation 写入被丢弃（T-73）
- [ ] **RG-10** 超阈值撤销 + 审计 + 告警；阈值取自 env（T-14）
- [ ] 宽限期后重放**确实**撤销会话（T-12）
- [ ] NO_MATCH 不写审计、不撤销（T-15）

**撤销即时性**
- [ ] 无任何会话/用户状态缓存
- [ ] 停用账号三条路径全部实现（access / refresh / 管理端联动）
- [ ] 改密、重置的撤销范围与本契约完全一致

**Web 兼容与 Bearer 独占（R-B3）**
- [ ] Web 纯 Cookie 行为逐字节不变（T-W1）
- [ ] Cookie + 有效 Bearer 并存时 Bearer 胜出（T-W2）
- [ ] **无效 Bearer + 有效 Cookie 返回 401，绝无 fallback**（T-W4 ~ T-W7）
- [ ] 已撤销 Mobile token 不能被 Cookie 绕过（T-W5）
- [ ] Mobile 认证路由拒绝 Cookie（T-W8）
- [ ] 未破坏管理端 CSRF

**并发与性能**
- [ ] `last_access_at` 节流生效（SQLite 写队列不被认证心跳打满）
- [ ] 认证读路径不进写事务
- [ ] 清理任务分批、可停机、不在登录路径
- [ ] 所有写事务经 `runInTransaction`（`write-transaction:contract:verify` 通过）

**客户端**
- [ ] single-flight 真正全进程唯一
- [ ] 无任何形式的无限重试
- [ ] 上传不自动重放
- [ ] 重放时幂等键不变
- [ ] SecureStore 单键原子写 + 串行化 + generation 守卫，三者齐备
- [ ] SQLite 无 token 明文

**审计**
- [ ] 八类事件齐备且字段对齐
- [ ] detail 中无明文、无完整 hash、无密码、无验证码
- [ ] `refresh_replay_detected` 有告警接入

**验证证据（MySQL Gate）**
- [ ] 全部服务端用例（T-01 ~ T-76、T-W1 ~ T-W8）有真实执行输出，非声称
- [ ] 客户端用例（T-60 ~ T-68）有真实执行输出
- [ ] **SQLite 与 MySQL 两套输出同时提供**
- [ ] MySQL 侧覆盖 G-1 ~ G-7 七个维度
- [ ] **不接受仅 SQLite 通过**

---

## Open Questions for Total Bus

### 已由总线仲裁关闭（v1.0 → v1.1）

| 原编号 | 议题 | 裁决 |
|---|---|---|
| Q1 | API 版本前缀 | **关闭** —— 保留 `/api/v1/mobile-auth`，接受与现有 `/api/xxx` 并存 |
| Q5 | 改密后为当前设备续签 | **关闭** —— 按决策 10 执行：revoke 全部旧 session → 为当前设备建全新 session → 用户无需重新登录 |
| Q8 | MySQL 验证环境 | **关闭** —— 文档本身不需 DB 测试；实现 PR 必须 SQLite + MySQL 双通过，见 MySQL Gate |
| — | Refresh grace 方案 | **关闭** —— 接受 v1「继续向前 rotation」，附 RG-1 ~ RG-10 十条硬性不变量 |
| — | 轮换速率阈值定位 | **关闭** —— 定为**可配置安全参数**，非业务常量 |

### 仍待确认（不阻塞 Codex 开工，每条已有默认值）

**Q2 —— Access TTL 15 分钟是否合适？**
15 分钟意味着典型使用中每小时 4 次 refresh。若产品希望降低弱网刷新往返，可放宽到 30 分钟（泄露窗口翻倍）；若安全优先可收紧到 5 分钟（刷新压力 3 倍，SQLite 写队列压力同步上升）。**默认 15 分钟。**

**Q3 —— 绝对过期 90 天是否符合业务预期？**
90 天后用户必须重新输入密码。对低频使用的 O2O 场景可能造成体验问题。若希望更长需明确接受上限。**默认 90 天。**

**Q4 —— 会话上限 10 的淘汰通知方式。**
被 LRU 淘汰的设备下次打开时会被登出。是否需要推送/站内信提前告知？当前设计只在会话列表中体现。**默认不额外通知。**

**Q6 —— `PATCH /preorders/:id`（改单）是否列为 `replayable=false`？**
A-4 中建议 `false`，理由是避免 `updateCount` 配额争议；但严格按 A-3 论证重放是安全的。这是保守取舍，需产品确认改单配额敏感度。**默认 `false`。**

**Q7 —— `refresh_replay_detected` 的用户侧文案。**
过于明确（"检测到账号可能被盗用"）易引发恐慌与客服量；过于模糊（"登录已过期"）会让真实受害者错过处置时机。**默认："出于安全考虑，您的登录已被重置，请重新登录。"** 需产品定稿。

**Q10 —— MySQL 验证环境的可用时间点（新增，实现前必须回答）。**
Q8 已裁定「实现 PR 必须双通过」，但截至本文定稿，Docker + MySQL 8.4 环境在当前工作机上仍不可用（上一轮 Delta 实测 `verify:db:concurrency` 无法执行）。**这是 Mobile Auth 实现的排期前置条件** —— 需要总线明确环境何时就绪，否则实现完成后将卡在合入门禁。建议在 Codex 开工前解决。

### 与 Delta 遗留决策的关系

上一轮登记的 D1（`limitEnabled` 语义）、D2（限购口径）、D3（商城 SKU 过滤）、D4/D5（上传尺寸与 HEIC）仍未决。它们与本契约无依赖，可并行推进；D4/D5 会影响 Mobile Upload 契约的立项时点。

---

## 附：本文档的边界声明

- 本文是**设计契约**，不是实现记录。文中任何 schema、字段、错误码在代码落地前均不存在。
- 文中对现有代码的引用（行号、方法名）基于 `origin/main` @ `f84762c`。实现时若发现与实际不符，**以代码为准**并回报总线（`AGENTS.md` §0.1）。
- 本文档交付时未修改 backend 生产代码、未新建实体、未新建 SQL migration、未实现 endpoint、未改动 Mobile adapter。

### 版本历史

| 版本 | 日期 | 基线 | 变更 |
|---|---|---|---|
| v1.0 | 2026-08-13 | `60eda61` | 初版设计定稿 |
| v1.1 | 2026-08-13 | `f84762c` | 总线最终仲裁校准：新增 Decision Log；R-B3 改为「Authorization 存在即独占、失败禁止回退 Cookie」；新增 RG-1 ~ RG-10 十条 refresh 硬性不变量；轮换速率阈值改为可配置安全参数；新增 MySQL Gate 章节；T-W 系列扩充至 8 条；新增 T-67/68、T-70 ~ T-76；关闭 Q1/Q5/Q8，新增 Q10 |
