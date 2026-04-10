param(
  [string]$BackendProfile = 'local-dev',
  [int]$BackendPort = 3001,
  [int]$FrontendPort = 5173,
  [int]$MaxReadyAttempts = 60,
  [switch]$NoCleanLogs,
  [switch]$NoAttachLogs,
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'

# Resolve all paths from the repository root so the script works from any cwd.
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendRoot = Join-Path $ProjectRoot 'backend'
$BackendEnvFile = Join-Path $BackendRoot '.env.local-dev'
$RuntimeRoot = Join-Path $ProjectRoot '.local-dev'
$PidFile = Join-Path $RuntimeRoot 'processes.json'
$BackendLog = Join-Path $RuntimeRoot 'backend.log'
$BackendErrorLog = Join-Path $RuntimeRoot 'backend.error.log'
$FrontendLog = Join-Path $RuntimeRoot 'frontend.log'
$FrontendErrorLog = Join-Path $RuntimeRoot 'frontend.error.log'
$LocalSqlitePath = Join-Path $BackendRoot 'data/local-dev/y-link.local-dev.sqlite'
$EffectiveBackendEnvFile = Join-Path $RuntimeRoot "backend.$BackendProfile.$BackendPort.env"

# 统一的警告输出，方便在正常启动信息中快速识别异常分支。
function Write-WarnMessage {
  param([string]$Message)
  Write-Host "[local-dev][warn] $Message" -ForegroundColor Yellow
}

# 启动前检查关键命令是否存在，避免脚本走到一半才因环境缺失失败。
function Assert-CommandAvailable {
  param([string]$CommandName)

  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $CommandName"
  }
}

# 解析当前系统中的 PowerShell 5 可执行文件绝对路径：
# - 优先复用当前 PowerShell 进程所在安装目录；
# - 避免 Start-Process 再次依赖 PATH 查找 powershell.exe；
# - 在受限终端或 PATH 不完整的环境下仍能稳定拉起前后端子进程。
function Get-PowerShellExecutablePath {
  $candidatePaths = @()

  if ($PSHOME) {
    $candidatePaths += (Join-Path $PSHOME 'powershell.exe')
  }
  if ($env:SystemRoot) {
    $candidatePaths += (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $candidatePaths += (Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe')
  }

  foreach ($candidatePath in $candidatePaths) {
    if ($candidatePath -and (Test-Path $candidatePath)) {
      return $candidatePath
    }
  }

  throw '未找到可用的 Windows PowerShell 5 可执行文件。'
}

# 确保目标文件的父目录存在，避免 SQLite 路径或临时 env 文件写入失败。
function Ensure-ParentDirectory {
  param([string]$Path)

  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

# 基于固定 env 模板生成一份“本次启动专用”的临时 env 文件，
# 这样脚本传入的端口等覆盖值不会被 .env.local-dev 重新压回默认值。
function New-EffectiveBackendEnvFile {
  param(
    [string]$SourceEnvFile,
    [string]$TargetEnvFile,
    [int]$TargetPort
  )

  $lines = @()
  if (Test-Path $SourceEnvFile) {
    $lines = @(Get-Content -Path $SourceEnvFile)
  }

  $filteredLines = @(
    $lines | Where-Object { $_ -notmatch '^\s*PORT\s*=' }
  )

  $effectiveLines = @($filteredLines + "PORT=$TargetPort")
  Set-Content -Path $TargetEnvFile -Value $effectiveLines -Encoding UTF8
}

# 递归收集某个进程的所有子孙进程 PID，保证停止时不会留下 npm/node 孤儿进程。
function Get-DescendantProcessIds {
  param([int]$RootProcessId)

  # 某些环境中 CIM 查询可能阻塞，设置超时避免启动链路被卡死。
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

# 先停子进程再停根进程，避免仅杀外层 PowerShell 导致监听端口残留。
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

function Write-Info {
  param([string]$Message)
  Write-Host "[local-dev] $Message"
}

function Get-ListeningProcessIds {
  param([int]$Port)

  # 部分 Windows 环境下 Get-NetTCPConnection 可能长时间卡住，改用 netstat 解析提升稳定性。
  $netstatOutput = & netstat -ano -p tcp 2>$null
  if (-not $netstatOutput) {
    return @()
  }

  $listeningPidSet = [System.Collections.Generic.HashSet[int]]::new()
  $portPattern = ":(?:$Port)\s+.+\s+(?:LISTENING|侦听)\s+(\d+)\s*$"

  foreach ($line in $netstatOutput) {
    if ($line -notmatch $portPattern) {
      continue
    }

    $pidText = $Matches[1]
    [int]$parsedPid = 0
    if ($pidText -and [int]::TryParse($pidText, [ref]$parsedPid)) {
      [void]$listeningPidSet.Add($parsedPid)
    }
  }

  return @($listeningPidSet)
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

function Stop-RecordedProcesses {
  if (-not (Test-Path $PidFile)) {
    return
  }

  try {
    $record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
    # 同时清理外层 shell PID 和真正监听端口的进程 PID，容错更强。
    $processIds = @(Get-RecordedProcessIds -Record $record)
    foreach ($processId in $processIds) {
      if ($processId) {
        Stop-ProcessTree -RootProcessId ([int]$processId)
      }
    }

    # 重复启动前一并删除上次生成的临时 env 文件，避免旧状态残留。
    if ($record.effectiveBackendEnvFile -and (Test-Path $record.effectiveBackendEnvFile)) {
      Remove-Item -Path $record.effectiveBackendEnvFile -Force -ErrorAction SilentlyContinue
    }
  }
  finally {
    Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
  }
}

function Assert-PortAvailable {
  param(
    [int]$Port,
    [string]$ServiceName
  )

  $listeningProcessIds = Get-ListeningProcessIds -Port $Port
  if ($listeningProcessIds.Count -gt 0) {
    throw "$ServiceName port $Port is already in use by PID(s): $($listeningProcessIds -join ', ')."
  }
}

function Wait-HttpReady {
  param(
    [string]$Uri,
    [string]$ServiceName,
    [int]$MaxAttempts = 60
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        Write-Info "$ServiceName ready: $Uri"
        return
      }
    }
    catch {
      Start-Sleep -Seconds 1
    }
  }

  throw "$ServiceName timed out: $Uri"
}

function Get-ProcessDisplayName {
  param([int]$ProcessId)

  try {
    return (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName
  }
  catch {
    return 'unknown'
  }
}

function Format-ProcessDisplayList {
  param([int[]]$ProcessIds)

  if (-not $ProcessIds -or -not $ProcessIds.Count) {
    return 'none'
  }

  # 使用格式化字符串替代双引号内的复杂插值，避免 PowerShell 5 在启动摘要阶段出现解析歧义。
  return (
    $ProcessIds |
      ForEach-Object {
        '{0}({1})' -f $_, (Get-ProcessDisplayName -ProcessId ([int]$_))
      }
  ) -join ', '
}

function Test-ProcessAlive {
  param([int]$ProcessId)

  if (-not $ProcessId) {
    return $false
  }

  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Write-LogLine {
  param(
    [string]$Prefix,
    [string]$Line,
    [ConsoleColor]$Color = [ConsoleColor]::Gray
  )

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return
  }

  Write-Host "[$Prefix] $Line" -ForegroundColor $Color
}

function Read-NewLogLines {
  param(
    [string]$LogPath,
    [int]$KnownLineCount
  )

  if (-not (Test-Path $LogPath)) {
    return @{
      LineCount = $KnownLineCount
      Lines = @()
    }
  }

  $allLines = @(Get-Content -Path $LogPath)
  $safeKnownLineCount = [Math]::Min($KnownLineCount, $allLines.Count)
  $newLines = @($allLines | Select-Object -Skip $safeKnownLineCount)

  return @{
    LineCount = $allLines.Count
    Lines = $newLines
  }
}

function Start-CombinedLogRelay {
  param(
    [int]$BackendShellPid,
    [int]$FrontendShellPid,
    [string]$BackendLogPath,
    [string]$BackendErrorLogPath,
    [string]$FrontendLogPath,
    [string]$FrontendErrorLogPath
  )

  # 当前终端统一追踪前后端日志：
  # - 后台服务继续独立运行，但不再弹出额外黑窗；
  # - 当前终端仅负责轮询日志文件并加前缀输出，便于集中观察；
  # - 按 Ctrl+C 退出日志跟随；服务本身不会被自动杀掉，可随后执行 stop-local-dev.ps1。
  $backendState = @{
    Out = (Read-NewLogLines -LogPath $BackendLogPath -KnownLineCount 0).LineCount
    Error = (Read-NewLogLines -LogPath $BackendErrorLogPath -KnownLineCount 0).LineCount
  }
  $frontendState = @{
    Out = (Read-NewLogLines -LogPath $FrontendLogPath -KnownLineCount 0).LineCount
    Error = (Read-NewLogLines -LogPath $FrontendErrorLogPath -KnownLineCount 0).LineCount
  }

  Write-Host ''
  Write-Info '开始在当前终端统一输出本地联调日志。'
  Write-Info '按 Ctrl+C 将同时停止日志跟随和本地联调服务。'
  Write-Host ''

  while ((Test-ProcessAlive -ProcessId $BackendShellPid) -or (Test-ProcessAlive -ProcessId $FrontendShellPid)) {
    $backendOutResult = Read-NewLogLines -LogPath $BackendLogPath -KnownLineCount $backendState.Out
    $backendState.Out = $backendOutResult.LineCount
    foreach ($line in $backendOutResult.Lines) {
      Write-LogLine -Prefix 'backend' -Line $line -Color Cyan
    }

    $backendErrorResult = Read-NewLogLines -LogPath $BackendErrorLogPath -KnownLineCount $backendState.Error
    $backendState.Error = $backendErrorResult.LineCount
    foreach ($line in $backendErrorResult.Lines) {
      Write-LogLine -Prefix 'backend:error' -Line $line -Color Red
    }

    $frontendOutResult = Read-NewLogLines -LogPath $FrontendLogPath -KnownLineCount $frontendState.Out
    $frontendState.Out = $frontendOutResult.LineCount
    foreach ($line in $frontendOutResult.Lines) {
      Write-LogLine -Prefix 'frontend' -Line $line -Color Green
    }

    $frontendErrorResult = Read-NewLogLines -LogPath $FrontendErrorLogPath -KnownLineCount $frontendState.Error
    $frontendState.Error = $frontendErrorResult.LineCount
    foreach ($line in $frontendErrorResult.Lines) {
      Write-LogLine -Prefix 'frontend:error' -Line $line -Color Red
    }

    Start-Sleep -Milliseconds 500
  }

  Write-Host ''
  Write-Info '后台服务进程已退出，日志跟随结束。'
}

# 浏览器自动打开属于可选增强：
# - 仅在服务已就绪后执行，避免打开一个尚未可访问的地址；
# - 失败时只给出警告，不影响本地联调链路本身。
function Open-FrontendBrowser {
  param(
    [int]$Port,
    [string[]]$Paths = @('/')
  )

  foreach ($path in $Paths) {
    $normalizedPath = if ($path.StartsWith('/')) { $path } else { "/$path" }
    $frontendUrl = "http://127.0.0.1:$Port$normalizedPath"

    try {
      Start-Process $frontendUrl | Out-Null
      Write-Info "Browser opened: $frontendUrl"
    }
    catch {
      Write-WarnMessage "Failed to open browser automatically: $frontendUrl"
    }
  }
}

function Show-LogTail {
  param(
    [string]$Title,
    [string]$LogPath
  )

  if (-not (Test-Path $LogPath)) {
    return
  }

  Write-Host ''
  Write-Host "===== $Title ====="
  Get-Content -Path $LogPath -Tail 40
}

if (-not (Test-Path $BackendEnvFile)) {
  throw "Missing local dev env file: $BackendEnvFile"
}

Write-Info "启动本地联调链路（管理端 + 客户端 + 后端 + SQLite，本地前端端口:$FrontendPort，后端端口:$BackendPort）..."
Assert-CommandAvailable -CommandName 'npm.cmd'
$PowerShellExecutablePath = Get-PowerShellExecutablePath

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
Ensure-ParentDirectory -Path $LocalSqlitePath
Ensure-ParentDirectory -Path $EffectiveBackendEnvFile
Stop-RecordedProcesses
Assert-PortAvailable -Port $BackendPort -ServiceName 'backend'
Assert-PortAvailable -Port $FrontendPort -ServiceName 'frontend'
if (-not $NoCleanLogs) {
  Remove-Item -Path $BackendLog, $BackendErrorLog, $FrontendLog, $FrontendErrorLog -Force -ErrorAction SilentlyContinue
}
New-EffectiveBackendEnvFile -SourceEnvFile $BackendEnvFile -TargetEnvFile $EffectiveBackendEnvFile -TargetPort $BackendPort

Write-Info 'Starting backend local profile...'
$backendCommand = "& { `$env:APP_PROFILE='$BackendProfile'; `$env:ENV_FILE='$EffectiveBackendEnvFile'; `$env:PORT='$BackendPort'; npm.cmd run dev }"
$backendProcess = Start-Process `
  -FilePath $PowerShellExecutablePath `
  -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $backendCommand) `
  -WorkingDirectory $BackendRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $BackendLog `
  -RedirectStandardError $BackendErrorLog `
  -PassThru

Write-Info 'Starting frontend dev server (同时承载管理端与客户端页面)...'
$frontendCommand = "& { `$env:VITE_LOCAL_BACKEND_URL='http://127.0.0.1:$BackendPort'; npm.cmd run dev -- --host 127.0.0.1 --port $FrontendPort --strictPort }"
$frontendProcess = Start-Process `
  -FilePath $PowerShellExecutablePath `
  -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $frontendCommand) `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $FrontendLog `
  -RedirectStandardError $FrontendErrorLog `
  -PassThru

try {
  Wait-HttpReady -Uri "http://127.0.0.1:$BackendPort/health" -ServiceName 'backend health' -MaxAttempts $MaxReadyAttempts
  Wait-HttpReady -Uri "http://127.0.0.1:$FrontendPort" -ServiceName 'frontend dev server' -MaxAttempts $MaxReadyAttempts

  $backendListeningPids = @(Get-ListeningProcessIds -Port $BackendPort)
  $frontendListeningPids = @(Get-ListeningProcessIds -Port $FrontendPort)

  @{
    backendShellPid = $backendProcess.Id
    frontendShellPid = $frontendProcess.Id
    backendListeningPids = $backendListeningPids
    frontendListeningPids = $frontendListeningPids
    backendPort = $BackendPort
    frontendPort = $FrontendPort
    backendProfile = $BackendProfile
    backendEnvFile = $BackendEnvFile
    effectiveBackendEnvFile = $EffectiveBackendEnvFile
    backendLog = $BackendLog
    backendErrorLog = $BackendErrorLog
    frontendLog = $FrontendLog
    frontendErrorLog = $FrontendErrorLog
    sqlitePath = $LocalSqlitePath
    startedAt = (Get-Date).ToString('s')
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $PidFile -Encoding UTF8

  Write-Host ''
  Write-Info 'Local dev chain is ready.'
  Write-Info "管理端登录: http://127.0.0.1:$FrontendPort/login"
  Write-Info "客户端登录: http://127.0.0.1:$FrontendPort/client/login"
  Write-Info "客户端首页: http://127.0.0.1:$FrontendPort/client/mall"
  Write-Info "后端健康:   http://127.0.0.1:$BackendPort/health"
  Write-Info "SQLite 数据库: $LocalSqlitePath"
  Write-Info "Backend env: $EffectiveBackendEnvFile"
  Write-Info "Backend log:  $BackendLog"
  Write-Info "Backend err:  $BackendErrorLog"
  Write-Info "Frontend log: $FrontendLog"
  Write-Info "Frontend err: $FrontendErrorLog"
  Write-Info '说明：当前本地链路使用一个 Vite 开发服务器同时提供管理端与客户端页面，数据库为随后台自动初始化的本地 SQLite。'
  if ($backendListeningPids.Count -gt 0) {
    $backendPidDisplayText = Format-ProcessDisplayList -ProcessIds $backendListeningPids
    Write-Info "Backend PID(s): $backendPidDisplayText"
  }
  if ($frontendListeningPids.Count -gt 0) {
    $frontendPidDisplayText = Format-ProcessDisplayList -ProcessIds $frontendListeningPids
    Write-Info "Frontend PID(s): $frontendPidDisplayText"
  }
  if ($NoCleanLogs) {
    Write-WarnMessage 'Log cleanup skipped because -NoCleanLogs was provided.'
  }
  if ($OpenBrowser) {
    Open-FrontendBrowser -Port $FrontendPort -Paths @('/login', '/client/login')
  }
  Write-Info 'Run .\stop-local-dev.ps1 to stop the recorded processes.'

  if (-not $NoAttachLogs) {
    try {
      Start-CombinedLogRelay `
        -BackendShellPid $backendProcess.Id `
        -FrontendShellPid $frontendProcess.Id `
        -BackendLogPath $BackendLog `
        -BackendErrorLogPath $BackendErrorLog `
        -FrontendLogPath $FrontendLog `
        -FrontendErrorLogPath $FrontendErrorLog
    }
    finally {
      if (Test-Path $PidFile) {
        Write-WarnMessage '日志跟随已结束，正在停止本地联调服务。'
        Stop-RecordedProcesses
      }
    }
  }
}
catch {
  Write-Info 'Startup failed. Cleaning up spawned processes.'
  Stop-ProcessTree -RootProcessId $backendProcess.Id
  Stop-ProcessTree -RootProcessId $frontendProcess.Id
  Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
  Show-LogTail -Title 'backend.log' -LogPath $BackendLog
  Show-LogTail -Title 'backend.error.log' -LogPath $BackendErrorLog
  Show-LogTail -Title 'frontend.log' -LogPath $FrontendLog
  Show-LogTail -Title 'frontend.error.log' -LogPath $FrontendErrorLog
  throw
}
