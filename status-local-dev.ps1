<#
模块说明：status-local-dev.ps1
文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
#>

﻿$ErrorActionPreference = 'Stop'

# 查看由 start-local-dev.ps1 管理的本地联调状态：
# - 优先读取 .local-dev/processes.json 中的记录；
# - 同时检查 shell PID、监听 PID 与 health 接口，帮助快速判断“是否真的还在运行”；
# - 仅做状态查看，不修改任何进程。
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $ProjectRoot '.local-dev'
$PidFile = Join-Path $RuntimeRoot 'processes.json'

function Write-Info {
  param([string]$Message)
  Write-Host "[local-dev] $Message"
}

function Write-WarnMessage {
  param([string]$Message)
  Write-Host "[local-dev][warn] $Message" -ForegroundColor Yellow
}

function Test-ProcessAlive {
  param([int]$ProcessId)

  if (-not $ProcessId) {
    return $false
  }

  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-ListeningProcessIds {
  param([int]$Port)

  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if (-not $connections.Count) {
    return @()
  }

  return @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-HttpReady {
  param([string]$Uri)

  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

if (-not (Test-Path $PidFile)) {
  Write-Info '本地联调当前未记录为运行中。'
  exit 0
}

$record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
$frontendUrl = "http://127.0.0.1:$($record.frontendPort)"
$backendUrl = "http://127.0.0.1:$($record.backendPort)"
$backendHealthUrl = "$backendUrl/health"

$backendShellAlive = Test-ProcessAlive -ProcessId ([int]$record.backendShellPid)
$frontendShellAlive = Test-ProcessAlive -ProcessId ([int]$record.frontendShellPid)
$backendListeningPids = @(Get-ListeningProcessIds -Port ([int]$record.backendPort))
$frontendListeningPids = @(Get-ListeningProcessIds -Port ([int]$record.frontendPort))
$backendHealthReady = Test-HttpReady -Uri $backendHealthUrl
$frontendReady = Test-HttpReady -Uri $frontendUrl

Write-Info '本地联调状态如下：'
Write-Info "StartedAt: $($record.startedAt)"
Write-Info "Frontend: $frontendUrl"
Write-Info "Backend:  $backendUrl"
Write-Info "SQLite:   $($record.sqlitePath)"
Write-Info "Backend shell alive: $backendShellAlive"
Write-Info "Frontend shell alive: $frontendShellAlive"
Write-Info "Backend listening PIDs: $($(if ($backendListeningPids.Count) { $backendListeningPids -join ', ' } else { 'none' }))"
Write-Info "Frontend listening PIDs: $($(if ($frontendListeningPids.Count) { $frontendListeningPids -join ', ' } else { 'none' }))"
Write-Info "Backend health ready: $backendHealthReady"
Write-Info "Frontend ready: $frontendReady"

if (-not $backendShellAlive -and -not $frontendShellAlive -and -not $backendListeningPids.Count -and -not $frontendListeningPids.Count) {
  Write-WarnMessage '记录文件存在，但本地联调进程似乎已不在运行，可执行 .\stop-local-dev.ps1 做清理。'
}
