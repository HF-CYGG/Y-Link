/**
 * 模块说明：scripts/verify-unit-functional-suite.mjs
 * 文件职责：聚合执行 Y-Link 的单元功能测试、静态契约门禁与关键功能回归脚本，提供统一入口。
 * 实现逻辑：按“前端类型校验 -> 前端静态契约 -> 后端类型校验 -> 后端权限契约 -> 后端功能验证脚本”顺序执行，任一步失败即中断。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNpmCommand, runCommand } from './process-runner-utils.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const backendRoot = path.join(projectRoot, 'backend')

const log = (message) => {
  // eslint-disable-next-line no-console
  console.log(message)
}

/**
 * 统一执行步骤：
 * - 使用显式命令与参数，避免 shell 差异导致脚本在不同终端行为不一致；
 * - 每步开始/结束均打印日志，便于定位失败阶段。
 */
const runStep = async (title, command, args, cwd) => {
  log(`\n[unit-functional] 开始：${title}`)
  await runCommand({
    title,
    command,
    args,
    cwd,
    windowsHide: false,
  })
  log(`[unit-functional] 通过：${title}`)
}

const runNpmScript = async (title, scriptName, cwd) => {
  const npmCommand = resolveNpmCommand()
  await runStep(
    title,
    npmCommand.command,
    [...npmCommand.prefixArgs, 'run', scriptName],
    cwd,
  )
}

const main = async () => {
  // 前端先做类型层校验，保证页面/组合逻辑变更不会带入低级类型错误。
  await runStep(
    '前端类型校验',
    process.execPath,
    [path.join(projectRoot, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'), '--noEmit'],
    projectRoot,
  )

  // 低频重库静态导入门禁：
  // - 避免 html2pdf、图表、扫码等重库重新回流到高频页面首包；
  // - 同时守住正式出库单、用户中心、系统治理页等关键异步入口。
  await runStep(
    '前端低频重库静态导入检查',
    process.execPath,
    [path.join(projectRoot, 'scripts', 'verify-frontend-low-frequency-heavy-imports.mjs')],
    projectRoot,
  )

  // 后端类型校验作为功能脚本执行前的门禁，避免编译层问题掩盖业务问题。
  await runNpmScript('后端类型校验', 'check', backendRoot)

  // 后端路由权限契约门禁：
  // - 校验匿名挂载边界、权限点声明完整性与角色限制搭配关系；
  // - 防止系统治理接口被误挂到匿名区，或新增路由时漏接权限中间件。
  await runNpmScript('后端路由权限契约检查', 'task2:route-contract:verify', backendRoot)

  // O2O 关键功能脚本：覆盖预订单核心链路，属于当前项目最关键业务路径之一。
  await runNpmScript('后端 O2O 功能回归', 'o2o:verify', backendRoot)

  // 教职工目录治理回归：
  // - 校验实名/工号目录的查询、导入、编辑、启停接口可用；
  // - 防止系统配置页新增白名单治理后，后续改动把目录接口或权限链路悄悄带坏。
  await runNpmScript('后端教职工目录治理回归', 'client-staff-directory:verify', backendRoot)

  log('\n[unit-functional] 单元功能测试套件执行完成')
}

try {
  await main()
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\n[unit-functional] 单元功能测试套件失败：', error)
  process.exit(1)
}
