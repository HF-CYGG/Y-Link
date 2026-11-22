/** 在独占子进程执行真实shutdown/薄index片段；业务模块、数据库、HTTP均为stub。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const runtime = fs.readFileSync(path.join(repo, 'backend/src/runtime/business-runtime.ts'), 'utf8')
const index = fs.readFileSync(path.join(repo, 'backend/src/index.ts'), 'utf8')
const scenario = process.argv[2]
const events = []
let release, entered, resumeRescue, enteredRescue
const blocked = new Promise(resolve => { release = resolve })
const reached = new Promise(resolve => { entered = resolve })
const rescueBlocked = new Promise(resolve => { resumeRescue = resolve })
const rescueReached = new Promise(resolve => { enteredRescue = resolve })
const handlers = new Map()
const report = code => {
  const shutdownEvents = events.filter(value => ['schema-workers-stopped', 'drain', 'outbox-stopped', 'web-sessions-stopped', 'datasource-closed'].includes(value))
  assert.deepEqual(shutdownEvents, scenario === 'cleanup-failure-signal'
    ? ['schema-workers-stopped']
    : ['schema-workers-stopped', 'drain', 'outbox-stopped', 'web-sessions-stopped', 'datasource-closed'])
  console.log(JSON.stringify({ scenario, events, code, realApp: false, realDatabase: false, realHttp: false }))
}
const fakeProcess = { env: {}, once(name, handler) { handlers.set(name, handler) },
  exit(code) { events.push('exit:' + code); report(code); process.exit(code) } }
const noop = () => {}
const context = vm.createContext({ globalThis: null, process: fakeProcess, console: { log: noop, error: noop },
  logLine: noop, paint: value => value, toSafeErrorLog: noop, sleep: async () => {},
  overloadMonitor: { stop: noop }, stopProductThumbnailBackfill: async () => {
    events.push('cleanup-blocked'); entered(); await blocked
    if (scenario === 'cleanup-failure-signal') throw new Error('SYNTHETIC_CLEANUP_FAILED')
  },
  databaseMaintenanceModeService: { shutdownAndDrain: async () => events.push('drain') },
  notificationService: { stopOutboxWorker: async () => events.push('outbox-stopped') },
  mobileSessionService: { stopCleanupLoop: async () => {} },
  stopWebSessionCleanup: async () => events.push('web-sessions-stopped'),
  customerServiceRealtimeService: { stopClusterPresenceSync: async () => {} },
  stopRedisBus: noop, closeRedis: async () => {},
  AppDataSource: { isInitialized: true, destroy: async () => events.push('datasource-closed') },
  registerRuntimeShutdownHandler: noop, registerDatabaseRescueQuiesce: noop, databaseMigrationService: {
    quiesceForDatabaseRescue: noop, stopSchemaWorkersForShutdown: async () => events.push('schema-workers-stopped'),
  } })
context.globalThis = context
function compile(source) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^export\s*\{\};?\s*$/gm, '')
}
const fragment = runtime.slice(runtime.indexOf('let activeHttpServer:'), runtime.indexOf('const probeHealthEndpoint'))
const stop = runtime.slice(runtime.indexOf('export async function stopFailedBusinessRuntime')).replace(/^export /gm, '')
vm.runInContext(compile(fragment + '\n' + stop + '\nglobalThis.controls={shutdownRuntime,stopFailedBusinessRuntime,getRequestedRuntimeExitCode};'), context)
context.loadModule = async name => {
  if (name.endsWith('database-startup-preflight.js')) return { inspectDatabaseStartup: async () => ({}) }
  if (name.endsWith('business-runtime.js')) return { startBusinessRuntime: async () => { throw new Error('SQLITE_ENGINE_UNVERIFIED') },
    stopFailedBusinessRuntime: context.controls.stopFailedBusinessRuntime, getRequestedRuntimeExitCode: context.controls.getRequestedRuntimeExitCode }
  if (name.endsWith('safe-error-log.js')) return { toSafeStartupErrorLog: () => ({ code: 'fixture' }) }
  if (name.endsWith('database-rescue-control.js')) return { inspectRecoveryIntent: () => ({ state: 'absent' }) }
  if (name.endsWith('database-runtime-override.js')) return { inspectDatabaseRuntimeOverride: () => ({ state: 'absent' }) }
  if (name.endsWith('rescue-app.js')) {
    if (scenario === 'late-signal') { events.push('rescue-import-blocked'); enteredRescue(); await rescueBlocked }
    return { startDatabaseRescueServer: async () => events.push('rescue-started') }
  }
  throw new Error('UNEXPECTED_MODULE:' + name)
}
const running = vm.runInContext(compile('(async()=>{\n' + index + '\n})()').replace(/\bimport\(/g, 'loadModule('), context)
await reached
if (scenario === 'restart75') void context.controls.shutdownRuntime('database_cutover_rollback', 75)
else if (scenario !== 'normal-failure' && scenario !== 'late-signal') {
  events.push('signal-during-cleanup')
  handlers.get(scenario === 'sigint' ? 'SIGINT' : 'SIGTERM')()
}
release()
if (scenario === 'late-signal') {
  await rescueReached
  events.push('signal-after-cleanup')
  handlers.get('SIGTERM')()
  resumeRescue()
}
await running
report(0)
