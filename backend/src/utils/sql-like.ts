/**
 * 文件说明：SQL LIKE 模糊匹配的转义工具。
 * 实现逻辑：用户输入或业务编码中的 `%`、`_` 在 LIKE 中是通配符，`!` 被选作转义字符本身也需转义；
 * 拼接模式串前统一转义，并在 SQL 中显式声明 `ESCAPE '!'`，SQLite 与 MySQL 行为一致。
 * 维护重点：
 * - 参数值仍必须通过绑定参数传入，本工具只解决“通配符误匹配 / 慢查询”，不替代参数化；
 * - 使用本工具生成的模式串时，对应 LIKE 子句必须带 `ESCAPE '!'`，否则转义符会被当成普通字符。
 */

export const SQL_LIKE_ESCAPE_CHAR = '!'

/** 转义 LIKE 通配符：`a_b%` → `a!_b!%`。数字 ID（SQLite 下实体主键可能是 number）先转为字符串。 */
export const escapeSqlLikePattern = (value: string | number) => String(value).replace(/[!%_]/g, '!$&')

/** 生成“包含”匹配模式串：`%<转义后的值>%`。 */
export const buildSqlLikeContains = (value: string | number) => `%${escapeSqlLikePattern(value)}%`

/** 生成“前缀”匹配模式串：`<转义后的值>%`。 */
export const buildSqlLikePrefix = (value: string | number) => `${escapeSqlLikePattern(value)}%`
