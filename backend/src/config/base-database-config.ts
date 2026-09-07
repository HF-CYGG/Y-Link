/** 基础数据库配置在 runtime override 注入前独立保存；此模块不加载业务数据库。 */
import { z } from 'zod'
import './env-file-bootstrap.js'

const schema = z.object({
  APP_PROFILE: z.string().default('default'),
  DB_TYPE: z.enum(['sqlite', 'mysql']).default('sqlite'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('y_link'),
  SQLITE_DB_PATH: z.string().optional(),
  DB_SYNC: z.enum(['true', 'false']).optional().transform((value) => value === undefined ? undefined : value === 'true'),
})
const result = schema.safeParse(process.env)
// 错误只输出字段名，不把含密码的原始 Zod input / 配置写入日志。
if (!result.success) throw new Error('BASE_DATABASE_CONFIG_INVALID')
const profile = result.data.APP_PROFILE.replaceAll(/[^a-zA-Z0-9_-]/g, '-')
export const baseDatabaseConfig = Object.freeze({
  ...result.data,
  SQLITE_DB_PATH: result.data.SQLITE_DB_PATH?.trim() || (profile === 'default'
    ? './data/y-link.sqlite' : `./data/local-dev/y-link.${profile}.sqlite`),
})
