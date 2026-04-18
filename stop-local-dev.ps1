<#
模块说明：stop-local-dev.ps1
  文件职责：停止由 `start-local-dev.ps1` 记录的本地联调前后端进程，并清理临时运行文件。
  实现逻辑：从 `.local-dev/processes.json` 读取 shell PID 与监听 PID，递归终止进程树后再删除启动时生成的临时文件。
#>

$ErrorActionPreference = 'Stop'

# 所有运行态信息都从仓库根目录下的 `.local-dev` 目录读取，
# 这样无论用户当前在哪个 PowerShell 工作目录执行停止脚本，清理目标都保持一致。
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
  Write-Info '未找到本地联调进程记录，无需停止。'
  exit 0
}

$record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
# 同时兼容旧记录中的 shell PID 和新记录中的监听 PID。
$processIds = @(Get-RecordedProcessIds -Record $record)

if (-not $processIds.Count) {
  Write-WarnMessage '检测到本地联调记录文件，但其中没有可用的 PID 信息。'
}

foreach ($processId in $processIds) {
  Stop-ProcessTree -RootProcessId ([int]$processId)
}

$effectiveBackendEnvFile = $record.effectiveBackendEnvFile
if ($effectiveBackendEnvFile -and (Test-Path $effectiveBackendEnvFile)) {
  Remove-Item -Path $effectiveBackendEnvFile -Force -ErrorAction SilentlyContinue
}

$childProcessInputFile = $record.childProcessInputFile
if ($childProcessInputFile -and (Test-Path $childProcessInputFile)) {
  # 启动脚本会创建一个空 stdin 文件给隐藏子进程复用，这里同步清理，避免 `.local-dev` 目录残留噪声文件。
  Remove-Item -Path $childProcessInputFile -Force -ErrorAction SilentlyContinue
}

Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
Write-Info '已停止记录中的本地联调进程，并完成运行痕迹清理。'
