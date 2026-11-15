/** Onebox 后端引导：加载任何应用模块前降权；失败即退出，不修复卷权限或回退 root。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function dropOneboxIdentity(identity = process, passwd = fs.readFileSync('/etc/passwd', 'utf8')) {
  const account = passwd.split('\n').find(line => line.startsWith('node:'))?.split(':')
  const uid = Number(account?.[2]), gid = Number(account?.[3])
  if (!account || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) throw new Error('ONEBOX_NODE_IDENTITY_INVALID')
  for (const method of ['setgroups', 'setgid', 'setuid', 'getgroups', 'getgid', 'getuid', 'getegid', 'geteuid']) {
    if (typeof identity[method] !== 'function') throw new Error('ONEBOX_IDENTITY_API_UNAVAILABLE')
  }
  identity.setgroups([])
  identity.setgid(gid)
  identity.setuid(uid)
  if (identity.getuid() !== uid || identity.geteuid() !== uid || identity.getgid() !== gid || identity.getegid() !== gid
    || identity.getgroups().some(group => group !== gid)) throw new Error('ONEBOX_IDENTITY_DROP_FAILED')
  return { uid, gid }
}

export async function launchOneboxBackend() {
  const mode = process.env.Y_LINK_ONEBOX_NON_ROOT ?? 'false'
  if (!['true', 'false'].includes(mode)) throw new Error('ONEBOX_NON_ROOT_FLAG_INVALID')
  if (mode === 'true') {
    const { uid, gid } = dropOneboxIdentity()
    const { assertOneboxVolumePermissions } = await import('/app/backend/dist/runtime/onebox-permission-preflight.js')
    // 此阶段只检查文件权限，不加载业务 env 或解释控制状态；损坏控制文件交回 index 的救援边界。
    await assertOneboxVolumePermissions()
    console.log(`[onebox] backend identity verified uid=${uid} gid=${gid}`)
  }
  // 同一 Node PID 动态加载，不增加转发信号的中间子进程，保留 exit 75 与独立救援启动。
  await import('/app/backend/dist/index.js')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await launchOneboxBackend() } catch {
    console.error('[onebox] 后端引导失败：请核对非 root 开关、镜像 node 身份与已准备卷的必要权限；未尝试回退或修改权限。')
    process.exitCode = 1
  }
}
