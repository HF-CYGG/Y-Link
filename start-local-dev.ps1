<#
模块说明：start-local-dev.ps1
  文件职责：一键启动 Y-Link 本地联调链路，包括后端服务、前端 Vite 开发服务器、日志收敛与运行记录。
  实现逻辑：先清理旧进程与端口占用，再按本次参数生成临时环境文件，拉起前后端进程并执行就绪校验，最后输出访问地址与日志跟随。
#>

param(
  [string]$BackendProfile = 'local-dev',
  [int]$BackendPort = 3001,
  [int]$FrontendPort = 5173,
  [string]$FrontendHost = '0.0.0.0',
  [bool]$FrontendHttps = $true,
  [int]$MaxReadyAttempts = 60,
  [switch]$NoCleanLogs,
  [switch]$NoAttachLogs,
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'

# 所有运行时路径都从仓库根目录推导：
# - 避免用户在任意 cwd 执行脚本时出现相对路径失效；
# - 统一把日志、PID、临时 env 文件收敛到 .local-dev 目录下。
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
$ChildProcessInputFile = Join-Path $RuntimeRoot 'child-process.stdin.txt'
$RuntimeOverrideFile = Join-Path $BackendRoot 'data\runtime\database-runtime-override.json'
$FrontendScheme = if ($FrontendHttps) { 'https' } else { 'http' }
$FrontendLocalHostForHealthCheck = if ($FrontendHttps) { 'localhost' } else { '127.0.0.1' }

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

# 读取数据库运行时覆盖文件：
# - 若本地环境此前已经通过迁移助手切换到 MySQL，这里可直接识别；
# - 启动脚本只做“读取并展示”，不修改任何覆盖配置。
function Get-RuntimeOverrideState {
  if (-not (Test-Path $RuntimeOverrideFile)) {
    return $null
  }

  try {
    return Get-Content -Path $RuntimeOverrideFile -Raw | ConvertFrom-Json
  }
  catch {
    return $null
  }
}

# 读取简单 env 文件中的键值对：
# - 仅处理 `KEY=VALUE` 结构，忽略空行和注释；
# - 本地脚本只用它兜底推断数据库目标，不承担完整 dotenv 解析职责。
function Read-EnvFileMap {
  param([string]$EnvFilePath)

  $envMap = @{}
  if (-not $EnvFilePath -or -not (Test-Path $EnvFilePath)) {
    return $envMap
  }

  foreach ($line in @(Get-Content -Path $EnvFilePath)) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    if ($line -match '^\s*#') {
      continue
    }
    if ($line -notmatch '^\s*([^=]+?)\s*=(.*)$') {
      continue
    }

    $key = $Matches[1].Trim()
    $value = $Matches[2]
    $envMap[$key] = $value
  }

  return $envMap
}

# 把后端 env 文件里的 SQLite 路径补齐为绝对路径：
# - 相对路径统一相对 backend 根目录解析；
# - 与后端默认运行方式保持一致，便于脚本输出可直接定位的真实文件地址。
function Resolve-BackendRelativePath {
  param([string]$TargetPath)

  if (-not $TargetPath) {
    return $null
  }
  if ([System.IO.Path]::IsPathRooted($TargetPath)) {
    return $TargetPath
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BackendRoot $TargetPath))
}

# 直接读取后端健康检查中的数据库摘要：
# - 该接口返回的是“当前进程已经实际生效”的数据库状态；
# - 启动脚本优先信任它，避免再靠本地文件猜测当前数据库。
function Get-BackendDatabaseSummary {
  param([string]$HealthUrl)

  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3
    $payload = $response.Content | ConvertFrom-Json
    $databaseState = $payload.data.database
    if (-not $databaseState -or -not $databaseState.effectiveDatabase) {
      return $null
    }

    return @{
      mode = [string]$databaseState.effectiveDatabase.dbType
      displayName = [string]$databaseState.effectiveDatabase.displayName
      summary = [string]$databaseState.effectiveDatabase.summary
      source = if ($databaseState.effectiveDatabase.sourceLabel) { [string]$databaseState.effectiveDatabase.sourceLabel } else { [string]$databaseState.effectiveDatabase.source }
      overrideStatus = if ($databaseState.runtimeOverrideStatus.statusLabel) { [string]$databaseState.runtimeOverrideStatus.statusLabel } else { '未知' }
      description = [string]$databaseState.effectiveDatabase.description
      fromBackendHealth = $true
    }
  }
  catch {
    return $null
  }
}

# 当后端健康检查暂时不可读时，脚本仍可基于本地文件做兜底推断：
# - 若当前存在运行时覆盖文件，优先按覆盖目标推断“重启后将采用什么库”；
# - 若不存在覆盖文件，则读取本次启动使用的临时 env 文件，而不是硬编码为 SQLite。
function Get-FallbackEffectiveDatabaseSummary {
  param([string]$BackendEnvFilePath)

  $runtimeOverride = Get-RuntimeOverrideState
  if ($runtimeOverride -and $runtimeOverride.config -and $runtimeOverride.config.DB_TYPE -eq 'mysql') {
    return @{
      mode = 'mysql'
      displayName = 'MySQL'
      summary = "$($runtimeOverride.config.DB_HOST):$($runtimeOverride.config.DB_PORT)/$($runtimeOverride.config.DB_NAME)"
      source = '本地文件推断：运行时覆盖配置'
      overrideStatus = '覆盖文件已写入，需以后端实际状态为准'
      description = '当前未能读取后端健康检查，因此这里只能按覆盖文件推断目标 MySQL。'
      fromBackendHealth = $false
    }
  }

  if ($runtimeOverride -and $runtimeOverride.config -and $runtimeOverride.config.DB_TYPE -eq 'sqlite' -and $runtimeOverride.config.SQLITE_DB_PATH) {
    return @{
      mode = 'sqlite'
      displayName = 'SQLite'
      summary = [string](Resolve-BackendRelativePath -TargetPath ([string]$runtimeOverride.config.SQLITE_DB_PATH))
      source = '本地文件推断：运行时覆盖配置'
      overrideStatus = '覆盖文件已写入，需以后端实际状态为准'
      description = '当前未能读取后端健康检查，因此这里只能按覆盖文件推断目标 SQLite。'
      fromBackendHealth = $false
    }
  }

  $envMap = Read-EnvFileMap -EnvFilePath $BackendEnvFilePath
  $dbType = if ($envMap.ContainsKey('DB_TYPE') -and $envMap['DB_TYPE']) { [string]$envMap['DB_TYPE'] } else { 'sqlite' }
  if ($dbType -eq 'mysql') {
    return @{
      mode = 'mysql'
      displayName = 'MySQL'
      summary = "$($envMap['DB_HOST']):$($envMap['DB_PORT'])/$($envMap['DB_NAME'])"
      source = '本地文件推断：默认环境配置'
      overrideStatus = '未启用运行时覆盖'
      description = '当前未能读取后端健康检查，因此这里只能按本次启动 env 文件推断默认 MySQL。'
      fromBackendHealth = $false
    }
  }

  $sqlitePath = if ($envMap.ContainsKey('SQLITE_DB_PATH') -and $envMap['SQLITE_DB_PATH']) {
    Resolve-BackendRelativePath -TargetPath ([string]$envMap['SQLITE_DB_PATH'])
  } else {
    $LocalSqlitePath
  }

  return @{
    mode = 'sqlite'
    displayName = 'SQLite'
    summary = [string]$sqlitePath
    source = '本地文件推断：默认环境配置'
    overrideStatus = '未启用运行时覆盖'
    description = '当前未能读取后端健康检查，因此这里只能按本次启动 env 文件推断默认 SQLite。'
    fromBackendHealth = $false
  }
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
    if ($record.childProcessInputFile -and (Test-Path $record.childProcessInputFile)) {
      Remove-Item -Path $record.childProcessInputFile -Force -ErrorAction SilentlyContinue
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
    [int]$MaxAttempts = 60,
    [switch]$IgnoreTlsCertificateError
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      $previousCertificateValidationCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
      if ($IgnoreTlsCertificateError) {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
      }

      # 只要能返回 2xx~4xx，就说明目标 HTTP 服务已经真正监听并能处理请求；
      # 这里不强制要求业务成功，只验证“服务已起来”。
      try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
          Write-Info "$ServiceName ready: $Uri"
          return
        }
      }
      finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCertificateValidationCallback
      }
    }
    catch {
      Start-Sleep -Seconds 1
    }
  }

  throw "$ServiceName timed out: $Uri"
}

function Wait-PortReady {
  param(
    [int]$Port,
    [string]$ServiceName,
    [int]$MaxAttempts = 60
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $listeningProcessIds = @(Get-ListeningProcessIds -Port $Port)
    if ($listeningProcessIds.Count -gt 0) {
      Write-Info "$ServiceName ready on port $Port (PID: $($listeningProcessIds -join ', '))"
      return
    }
    Start-Sleep -Seconds 1
  }

  throw "$ServiceName timed out on port $Port"
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

# 收集当前机器可用于局域网访问的 IPv4 地址：
# - 过滤 loopback、APIPA(169.254.x.x) 与无效地址；
# - 启动成功后直接打印可访问链接，便于手机/平板联调。
function Get-LanIPv4Addresses {
  try {
    $ipConfigs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop
  }
  catch {
    return @()
  }

  $lanIpSet = [System.Collections.Generic.HashSet[string]]::new()
  foreach ($ipConfig in $ipConfigs) {
    $ipAddress = $ipConfig.IPAddress
    if (-not $ipAddress) {
      continue
    }
    if ($ipAddress -eq '127.0.0.1') {
      continue
    }
    if ($ipAddress.StartsWith('169.254.')) {
      continue
    }
    if ($ipConfig.SkipAsSource) {
      continue
    }

    [void]$lanIpSet.Add($ipAddress)
  }

  return @($lanIpSet | Sort-Object)
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

# 判断一组 PID 中是否仍有存活进程：
# - 启动脚本既会记录外层 shell PID，也会记录真正监听端口的 node PID；
# - 日志跟随应优先依据“真实服务进程是否还活着”来决定是否继续。
function Test-AnyProcessAlive {
  param([int[]]$ProcessIds)

  foreach ($processId in @($ProcessIds)) {
    if (Test-ProcessAlive -ProcessId ([int]$processId)) {
      return $true
    }
  }

  return $false
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
    [int[]]$BackendListeningPids = @(),
    [int[]]$FrontendListeningPids = @(),
    [string]$BackendLogPath,
    [string]$BackendErrorLogPath,
    [string]$FrontendLogPath,
    [string]$FrontendErrorLogPath
  )

  # 当前终端统一追踪前后端日志：
  # - 后台服务继续独立运行，但不再弹出额外黑窗；
  # - 当前终端仅负责轮询日志文件并加前缀输出，便于集中观察；
  # - 按 Ctrl+C 退出日志跟随时，会继续检查服务是否仍存活，再决定是保留还是清理记录。
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

  while (
    (Test-ProcessAlive -ProcessId $BackendShellPid) -or
    (Test-ProcessAlive -ProcessId $FrontendShellPid) -or
    (Test-AnyProcessAlive -ProcessIds $BackendListeningPids) -or
    (Test-AnyProcessAlive -ProcessIds $FrontendListeningPids)
  ) {
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
    [string]$Scheme = 'http',
    [string[]]$Paths = @('/')
  )

  foreach ($path in $Paths) {
    $normalizedPath = if ($path.StartsWith('/')) { $path } else { "/$path" }
    $frontendUrl = "${Scheme}://127.0.0.1:$Port$normalizedPath"

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

Write-Info "启动本地联调链路（管理端 + 客户端 + 后端，本地前端端口:$FrontendPort，后端端口:$BackendPort）..."
Assert-CommandAvailable -CommandName 'npm.cmd'
$PowerShellExecutablePath = Get-PowerShellExecutablePath

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
Ensure-ParentDirectory -Path $LocalSqlitePath
Ensure-ParentDirectory -Path $EffectiveBackendEnvFile
Ensure-ParentDirectory -Path $ChildProcessInputFile
Stop-RecordedProcesses
Assert-PortAvailable -Port $BackendPort -ServiceName 'backend'
Assert-PortAvailable -Port $FrontendPort -ServiceName 'frontend'
if (-not $NoCleanLogs) {
  Remove-Item -Path $BackendLog, $BackendErrorLog, $FrontendLog, $FrontendErrorLog -Force -ErrorAction SilentlyContinue
}
New-EffectiveBackendEnvFile -SourceEnvFile $BackendEnvFile -TargetEnvFile $EffectiveBackendEnvFile -TargetPort $BackendPort
Set-Content -Path $ChildProcessInputFile -Value '' -Encoding UTF8

Write-Info 'Starting backend local profile...'
# 后端通过“独立 PowerShell + 临时 env 文件”启动：
# - 避免 npm 与 PowerShell 参数转义互相干扰；
# - 允许本次启动动态覆盖端口/profile，同时不污染源 env 文件。
$backendCommand = "& { `$env:APP_PROFILE='$BackendProfile'; `$env:ENV_FILE='$EffectiveBackendEnvFile'; `$env:PORT='$BackendPort'; npm.cmd run dev }"
$backendProcess = Start-Process `
  -FilePath $PowerShellExecutablePath `
  -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $backendCommand) `
  -WorkingDirectory $BackendRoot `
  -WindowStyle Hidden `
  -RedirectStandardInput $ChildProcessInputFile `
  -RedirectStandardOutput $BackendLog `
  -RedirectStandardError $BackendErrorLog `
  -PassThru

Write-Info 'Starting frontend dev server (同时承载管理端与客户端页面)...'
# 前端只启动一个 Vite 开发服务，同时承载管理端与客户端页面，
# 通过注入本次后端地址，保证本地联调时接口统一指向当前后端端口。
# 默认监听 0.0.0.0，这样局域网内其他设备也能直接访问当前调试页。
# 同时默认启用自签名 HTTPS，保证手机真机联调时可使用浏览器摄像头能力。
$frontendCommand = "& { `$env:VITE_LOCAL_BACKEND_URL='http://127.0.0.1:$BackendPort'; `$env:VITE_DEV_SERVER_HTTPS='$($FrontendHttps.ToString().ToLower())'; npm.cmd run dev -- --host $FrontendHost --port $FrontendPort --strictPort }"
$frontendProcess = Start-Process `
  -FilePath $PowerShellExecutablePath `
  -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $frontendCommand) `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardInput $ChildProcessInputFile `
  -RedirectStandardOutput $FrontendLog `
  -RedirectStandardError $FrontendErrorLog `
  -PassThru

try {
  # 就绪校验必须在记录 PID 之前完成：
  # - 若服务其实未成功拉起，就不写入“假成功”的运行记录；
  # - 失败时直接进入 catch，输出日志尾部帮助排查。
  Wait-HttpReady -Uri "http://127.0.0.1:$BackendPort/health" -ServiceName 'backend health' -MaxAttempts $MaxReadyAttempts
  # 前端就绪改为端口监听探测：
  # 在 PowerShell 5 + 自签名 HTTPS 场景下，Invoke-WebRequest 可能因为 TLS 握手或证书策略反复失败，
  # 但 dev server 实际已经可用，使用端口探测更稳。
  Wait-PortReady -Port $FrontendPort -ServiceName 'frontend dev server' -MaxAttempts $MaxReadyAttempts

  $backendListeningPids = @(Get-ListeningProcessIds -Port $BackendPort)
  $frontendListeningPids = @(Get-ListeningProcessIds -Port $FrontendPort)
  $effectiveDatabase = Get-BackendDatabaseSummary -HealthUrl "http://127.0.0.1:$BackendPort/health"
  if (-not $effectiveDatabase) {
    $effectiveDatabase = Get-FallbackEffectiveDatabaseSummary -BackendEnvFilePath $EffectiveBackendEnvFile
  }

  @{
    backendShellPid = $backendProcess.Id
    frontendShellPid = $frontendProcess.Id
    backendListeningPids = $backendListeningPids
    frontendListeningPids = $frontendListeningPids
    backendPort = $BackendPort
    frontendPort = $FrontendPort
    frontendHost = $FrontendHost
    frontendHttps = $FrontendHttps
    frontendScheme = $FrontendScheme
    backendProfile = $BackendProfile
    backendEnvFile = $BackendEnvFile
    effectiveBackendEnvFile = $EffectiveBackendEnvFile
    childProcessInputFile = $ChildProcessInputFile
    backendLog = $BackendLog
    backendErrorLog = $BackendErrorLog
    frontendLog = $FrontendLog
    frontendErrorLog = $FrontendErrorLog
    sqlitePath = $LocalSqlitePath
    startedAt = (Get-Date).ToString('s')
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $PidFile -Encoding UTF8

  Write-Host ''
  Write-Info 'Local dev chain is ready.'
  Write-Info "管理端登录: ${FrontendScheme}://$FrontendLocalHostForHealthCheck`:$FrontendPort/login"
  Write-Info "客户端登录: ${FrontendScheme}://$FrontendLocalHostForHealthCheck`:$FrontendPort/client/login"
  Write-Info "客户端首页: ${FrontendScheme}://$FrontendLocalHostForHealthCheck`:$FrontendPort/client/mall"
  Write-Info "后端健康:   http://127.0.0.1:$BackendPort/health"
  Write-Info "当前数据库: $($effectiveDatabase.displayName)"
  Write-Info "数据库来源: $($effectiveDatabase.source)"
  Write-Info "覆盖状态: $($effectiveDatabase.overrideStatus)"
  Write-Info "数据库摘要: $($effectiveDatabase.summary)"
  Write-Info "数据库说明: $($effectiveDatabase.description)"
  Write-Info "Backend env: $EffectiveBackendEnvFile"
  Write-Info "Backend log:  $BackendLog"
  Write-Info "Backend err:  $BackendErrorLog"
  Write-Info "Frontend log: $FrontendLog"
  Write-Info "Frontend err: $FrontendErrorLog"
  Write-Info "说明：当前本地链路使用一个 Vite 开发服务器同时提供管理端与客户端页面；数据库口径优先以后端健康检查中的实际生效状态为准，若暂时无法读取才退回本地文件推断；前端协议为 $FrontendScheme。"
  if ($FrontendHost -eq '0.0.0.0' -or $FrontendHost -eq '*') {
    $lanIpAddresses = @(Get-LanIPv4Addresses)
    if ($lanIpAddresses.Count -gt 0) {
      Write-Info '局域网访问地址（确保防火墙已放行前端端口；若浏览器提示证书风险，请先手动信任自签名证书）：'
      foreach ($lanIpAddress in $lanIpAddresses) {
        Write-Info "  管理端: ${FrontendScheme}://$lanIpAddress`:$FrontendPort/login"
        Write-Info "  客户端: ${FrontendScheme}://$lanIpAddress`:$FrontendPort/client/login"
      }
    }
    else {
      Write-WarnMessage '未检测到可用的局域网 IPv4 地址，若需局域网访问请检查当前网络连接。'
    }
  }
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
    Open-FrontendBrowser -Port $FrontendPort -Scheme $FrontendScheme -Paths @('/login', '/client/login')
  }
  Write-Info 'Run .\stop-local-dev.ps1 to stop the recorded processes.'

  if (-not $NoAttachLogs) {
    try {
      Start-CombinedLogRelay `
        -BackendShellPid $backendProcess.Id `
        -FrontendShellPid $frontendProcess.Id `
        -BackendListeningPids $backendListeningPids `
        -FrontendListeningPids $frontendListeningPids `
        -BackendLogPath $BackendLog `
        -BackendErrorLogPath $BackendErrorLog `
        -FrontendLogPath $FrontendLog `
        -FrontendErrorLogPath $FrontendErrorLog
    }
    finally {
      if (Test-Path $PidFile) {
        # 日志跟随后再次判断真实服务是否仍在，解决“外层 shell 退出但 node 仍在”与相反情况。
        $servicesStillAlive = (
          (Test-ProcessAlive -ProcessId $backendProcess.Id) -or
          (Test-ProcessAlive -ProcessId $frontendProcess.Id) -or
          (Test-AnyProcessAlive -ProcessIds $backendListeningPids) -or
          (Test-AnyProcessAlive -ProcessIds $frontendListeningPids)
        )

        if ($servicesStillAlive) {
          Write-Info '日志跟随已结束，但本地联调服务仍在运行，可继续访问页面或手动执行 .\stop-local-dev.ps1 停止。'
        }
        else {
          Write-WarnMessage '日志跟随已结束，检测到服务已退出，正在清理本地联调记录。'
          Stop-RecordedProcesses
        }
      }
    }
  }
}
catch {
  Write-Info 'Startup failed. Cleaning up spawned processes.'
  # 启动失败时优先清理进程树，再打印日志尾部，避免失败进程继续占用端口或追加无关日志。
  Stop-ProcessTree -RootProcessId $backendProcess.Id
  Stop-ProcessTree -RootProcessId $frontendProcess.Id
  Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
  Show-LogTail -Title 'backend.log' -LogPath $BackendLog
  Show-LogTail -Title 'backend.error.log' -LogPath $BackendErrorLog
  Show-LogTail -Title 'frontend.log' -LogPath $FrontendLog
  Show-LogTail -Title 'frontend.error.log' -LogPath $FrontendErrorLog
  throw
}
