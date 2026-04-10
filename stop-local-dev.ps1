<#
模块说明：stop-local-dev.ps1
文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
#>

﻿$ErrorActionPreference = 'Stop'

# Stop the processes started by start-local-dev.ps1 using the recorded shell PID file.
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $ProjectRoot '.local-dev'
$PidFile = Join-Path $RuntimeRoot 'processes.json'

# 在“有记录但清理信息不完整”时输出提醒，便于快速判断当前停止链路是否完整。
function Write-WarnMessage {
  param([string]$Message)
  Write-Host "[local-dev][warn] $Message" -ForegroundColor Yellow
}

function Write-Info {
  param([string]$Message)
  Write-Host "[local-dev] $Message"
}

# 递归收集所有子孙进程，防止只关闭父进程后残留 npm/node 监听。
function Get-DescendantProcessIds {
  param([int]$RootProcessId)

  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  if (-not $allProcesses.Count) {
    return @()
  }

  $pending = [System.Collections.Generic.Queue[int]]::new()
  $visited = [System.Collections.Generic.HashSet[int]]::new()
  $pending.Enqueue($RootProcessId)

  while ($pending.Count -gt 0) {
    $currentPid = $pending.Dequeue()
    foreach ($process in $allProcesses) {
      if ($process.ParentProcessId -eq $currentPid -and $visited.Add([int]$process.ProcessId)) {
        $pending.Enqueue([int]$process.ProcessId)
      }
    }
  }

  return @($visited)
}

# 停止顺序与启动脚本一致：优先子进程，再停止根进程。
function Stop-ProcessTree {
  param([int]$RootProcessId)

  if (-not $RootProcessId) {
    return
  }

  $descendantProcessIds = @(Get-DescendantProcessIds -RootProcessId $RootProcessId)
  foreach ($processId in ($descendantProcessIds | Sort-Object -Descending)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }

  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

function Get-RecordedProcessIds {
  param($Record)

  $collectedProcessIds = @()
  foreach ($candidate in @(
    $Record.backendShellPid,
    $Record.frontendShellPid,
    $Record.backendListeningPids,
    $Record.frontendListeningPids
  )) {
    foreach ($processId in @($candidate)) {
      if ($null -ne $processId -and "$processId".Trim()) {
        $collectedProcessIds += [int]$processId
      }
    }
  }

  return @($collectedProcessIds | Select-Object -Unique)
}

if (-not (Test-Path $PidFile)) {
  Write-Info 'No local dev process record found.'
  exit 0
}

$record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
# 同时兼容旧记录中的 shell PID 和新记录中的监听 PID。
$processIds = @(Get-RecordedProcessIds -Record $record)

if (-not $processIds.Count) {
  Write-WarnMessage 'Process record exists, but no PID information was found.'
}

foreach ($processId in $processIds) {
  Stop-ProcessTree -RootProcessId ([int]$processId)
}

$effectiveBackendEnvFile = $record.effectiveBackendEnvFile
if ($effectiveBackendEnvFile -and (Test-Path $effectiveBackendEnvFile)) {
  Remove-Item -Path $effectiveBackendEnvFile -Force -ErrorAction SilentlyContinue
}

Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
Write-Info 'Recorded local dev processes have been stopped.'
