<#
模块说明：stop-local-dev.ps1
  文件职责：停止本地联调相关进程并清理 `.local-dev` 运行时文件，避免端口与 stdin 文件占用残留。
  实现逻辑：
  1) 优先停止 `processes.json` 中记录的 shell PID 与监听 PID；
  2) 兜底扫描默认联调端口（3001/5173）并强制释放；
  3) 额外清理占用 `child-process.stdin.txt` 的残留进程，杜绝启动时文件被占用。
#>

param(
  [int[]]$KnownPorts = @(3001, 5173)
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $ProjectRoot '.local-dev'
$PidFile = Join-Path $RuntimeRoot 'processes.json'
$DefaultChildProcessInputFile = Join-Path $RuntimeRoot 'child-process.stdin.txt'

function Write-WarnMessage {
  param([string]$Message)
  Write-Host "[local-dev][warn] $Message" -ForegroundColor Yellow
}

function Write-Info {
  param([string]$Message)
  Write-Host "[local-dev] $Message"
}

function Get-DescendantProcessIds {
  param([int]$RootProcessId)

  $allProcesses = @(Get-CimInstance Win32_Process -OperationTimeoutSec 2 -ErrorAction SilentlyContinue)
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

function Stop-ProcessTree {
  param([int]$RootProcessId)

  if (-not $RootProcessId -or $RootProcessId -eq $PID) {
    return
  }

  $descendantProcessIds = @(Get-DescendantProcessIds -RootProcessId $RootProcessId)
  foreach ($processId in ($descendantProcessIds | Sort-Object -Descending)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }

  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

function Get-ListeningProcessIds {
  param([int]$Port)

  $netstatOutput = & netstat -ano -p tcp 2>$null
  if (-not $netstatOutput) {
    return @()
  }

  $pidSet = [System.Collections.Generic.HashSet[int]]::new()
  $portPattern = ":(?:$Port)\s+.+\s+(?:LISTENING|侦听)\s+(\d+)\s*$"
  foreach ($line in $netstatOutput) {
    if ($line -notmatch $portPattern) {
      continue
    }
    [int]$parsedPid = 0
    if ([int]::TryParse($Matches[1], [ref]$parsedPid)) {
      [void]$pidSet.Add($parsedPid)
    }
  }
  return @($pidSet)
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

function Get-ProcessIdsByCommandLineKeyword {
  param([string]$Keyword)

  if (-not $Keyword) {
    return @()
  }

  $allProcesses = @(Get-CimInstance Win32_Process -OperationTimeoutSec 2 -ErrorAction SilentlyContinue)
  if (-not $allProcesses.Count) {
    return @()
  }

  $pidSet = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($process in $allProcesses) {
    $commandLine = [string]$process.CommandLine
    if (-not $commandLine) {
      continue
    }
    if ($commandLine -like "*$Keyword*") {
      [void]$pidSet.Add([int]$process.ProcessId)
    }
  }
  return @($pidSet)
}

function Try-RemoveFileWithWarning {
  param([string]$Path)

  if (-not $Path -or -not (Test-Path $Path)) {
    return
  }

  try {
    Remove-Item -Path $Path -Force -ErrorAction Stop
  }
  catch {
    Write-WarnMessage "清理文件失败（可能仍被占用）：$Path"
  }
}

$record = $null
if (Test-Path $PidFile) {
  try {
    $record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
  }
  catch {
    Write-WarnMessage 'processes.json 解析失败，将按兜底策略清理。'
  }
}

$processIdsToStop = [System.Collections.Generic.HashSet[int]]::new()

if ($record) {
  foreach ($processId in @(Get-RecordedProcessIds -Record $record)) {
    [void]$processIdsToStop.Add([int]$processId)
  }
}

foreach ($port in @($KnownPorts)) {
  foreach ($processId in @(Get-ListeningProcessIds -Port ([int]$port))) {
    [void]$processIdsToStop.Add([int]$processId)
  }
}

$childInputFileCandidates = @($DefaultChildProcessInputFile)
if ($record -and $record.childProcessInputFile) {
  $childInputFileCandidates += [string]$record.childProcessInputFile
}
$childInputFileCandidates = @($childInputFileCandidates | Select-Object -Unique)

foreach ($childInputFilePath in $childInputFileCandidates) {
  foreach ($processId in @(Get-ProcessIdsByCommandLineKeyword -Keyword $childInputFilePath)) {
    [void]$processIdsToStop.Add([int]$processId)
  }
}

if ($processIdsToStop.Count -eq 0) {
  Write-Info '未发现需要停止的本地联调进程，继续执行运行痕迹清理。'
}
else {
  Write-Info "准备停止本地联调相关进程：$(@($processIdsToStop) -join ', ')"
  foreach ($processId in @($processIdsToStop)) {
    Stop-ProcessTree -RootProcessId ([int]$processId)
  }
}

if ($record -and $record.effectiveBackendEnvFile) {
  Try-RemoveFileWithWarning -Path ([string]$record.effectiveBackendEnvFile)
}

foreach ($childInputFilePath in $childInputFileCandidates) {
  Try-RemoveFileWithWarning -Path $childInputFilePath
}

# 二次兜底：若 child-process.stdin.txt 仍被占用，再扫一次占用进程并重试删除。
foreach ($childInputFilePath in $childInputFileCandidates) {
  if (-not (Test-Path $childInputFilePath)) {
    continue
  }

  $holderPids = @(Get-ProcessIdsByCommandLineKeyword -Keyword $childInputFilePath)
  if ($holderPids.Count -gt 0) {
    Write-WarnMessage "检测到 stdin 文件仍可能被占用，继续强制停止相关进程：$($holderPids -join ', ')"
    foreach ($holderPid in $holderPids) {
      Stop-ProcessTree -RootProcessId ([int]$holderPid)
    }
    Start-Sleep -Milliseconds 300
    Try-RemoveFileWithWarning -Path $childInputFilePath
  }
}

Try-RemoveFileWithWarning -Path $PidFile
Write-Info '本地联调进程已停止，并完成运行痕迹清理。'
