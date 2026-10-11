// 使用原有隔离 SQLite 验证的启用模式，保留其完整行为断言并供 V8 采集覆盖率。
process.argv.push('--enabled')
await import('./admin-webauthn-verify.ts')
