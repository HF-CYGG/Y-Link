<#
模块说明：status-local-dev.ps1
  文件职责：读取 `.local-dev/processes.json`，汇总前后端本地联调的运行状态、端口监听和访问地址。
  实现逻辑：优先根据记录文件恢复上下文，再结合进程存活、端口监听与健康检查输出可直接排障的信息。
#>

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $ProjectRoot '.local-dev'
$PidFile = Join-Path $RuntimeRoot 'processes.json'
$BackendRoot = Join-Path $ProjectRoot 'backend'
$RuntimeOverrideFile = Join-Path $BackendRoot 'data\runtime\database-runtime-override.json'

function Write-Info {
  param([string]$Message)
  Write-Host "[local-dev] $Message"
}

function Write-WarnMessage {
  param([string]$Message)
  Write-Host "[local-dev][warn] $Message" -ForegroundColor Yellow
}

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
    if (-not $ipAddress) { continue }
    if ($ipAddress -eq '127.0.0.1') { continue }
    if ($ipAddress.StartsWith('169.254.')) { continue }
    if ($ipConfig.SkipAsSource) { continue }
    [void]$lanIpSet.Add($ipAddress)
  }

  return @($lanIpSet | Sort-Object)
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

  # 与启动脚本保持一致，统一使用 netstat 解析监听端口：
  # - 避免 Get-NetTCPConnection 在部分 Windows 环境下卡顿或权限受限；
  # - 这样状态查看和启动校验会基于同一套端口探测逻辑，结果更稳定。
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

function Test-HttpReady {
  param(
    [string]$Uri,
    [switch]$IgnoreTlsCertificateError
  )

  try {
    $previousCertificateValidationCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    if ($IgnoreTlsCertificateError) {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    }

    try {
      $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
      return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    finally {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCertificateValidationCallback
    }
  }
  catch {
    return $false
  }
}

# 读取数据库运行时覆盖文件：
# - 用于判断当前本地后端是否已经切换到 MySQL；
# - 读取失败时按“未启用覆盖”处理，避免状态脚本因单个文件异常中断。
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
# - 仅用于状态脚本在后端暂时不可读时做兜底推断；
# - 不尝试完整模拟 dotenv，只解析最常见的 `KEY=VALUE` 行。
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

# 把相对 backend 路径补齐为绝对路径，保证状态输出可直接定位到真实文件。
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

# 优先读取后端健康检查中的数据库状态：
# - 这里返回的是“当前进程实际已生效”的数据库；
# - 只要后端还能正常响应，就不再靠覆盖文件或本地记录猜测。
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

# 后端健康检查不可读时，基于记录文件与本地配置做降级推断：
# - 若存在运行时覆盖文件，则提示“按覆盖文件推断”，避免误报为当前已生效；
# - 若不存在覆盖文件，则读取本次启动使用的 env 文件，兼容默认环境本身就是 MySQL 的情况。
function Get-FallbackEffectiveDatabaseSummary {
  param($Record)

  $runtimeOverride = Get-RuntimeOverrideState
  if ($runtimeOverride -and $runtimeOverride.config -and $runtimeOverride.config.DB_TYPE -eq 'mysql') {
    return @{
      mode = 'mysql'
      displayName = 'MySQL'
      summary = "$($runtimeOverride.config.DB_HOST):$($runtimeOverride.config.DB_PORT)/$($runtimeOverride.config.DB_NAME)"
      source = '本地文件推断：运行时覆盖配置'
      overrideStatus = '覆盖文件已写入，需以后端实际状态为准'
      description = '当前后端健康检查不可读，因此这里只能按覆盖文件推断 MySQL 目标。'
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
      description = '当前后端健康检查不可读，因此这里只能按覆盖文件推断 SQLite 目标。'
      fromBackendHealth = $false
    }
  }

  $effectiveBackendEnvFile = if ($Record.effectiveBackendEnvFile) { [string]$Record.effectiveBackendEnvFile } else { '' }
  $envMap = Read-EnvFileMap -EnvFilePath $effectiveBackendEnvFile
  $dbType = if ($envMap.ContainsKey('DB_TYPE') -and $envMap['DB_TYPE']) { [string]$envMap['DB_TYPE'] } else { 'sqlite' }
  if ($dbType -eq 'mysql') {
    return @{
      mode = 'mysql'
      displayName = 'MySQL'
      summary = "$($envMap['DB_HOST']):$($envMap['DB_PORT'])/$($envMap['DB_NAME'])"
      source = '本地文件推断：默认环境配置'
      overrideStatus = '未启用运行时覆盖'
      description = '当前后端健康检查不可读，因此这里只能按本次启动 env 文件推断默认 MySQL。'
      fromBackendHealth = $false
    }
  }

  $sqlitePath = if ($envMap.ContainsKey('SQLITE_DB_PATH') -and $envMap['SQLITE_DB_PATH']) {
    Resolve-BackendRelativePath -TargetPath ([string]$envMap['SQLITE_DB_PATH'])
  } elseif ($Record.sqlitePath) {
    [string]$Record.sqlitePath
  } else {
    ''
  }

  return @{
    mode = 'sqlite'
    displayName = 'SQLite'
    summary = [string]$sqlitePath
    source = '本地文件推断：默认环境配置'
    overrideStatus = '未启用运行时覆盖'
    description = '当前后端健康检查不可读，因此这里只能按本次启动 env 文件推断默认 SQLite。'
    fromBackendHealth = $false
  }
}

if (-not (Test-Path $PidFile)) {
  Write-Info '本地联调当前未记录为运行中。'
  exit 0
}

$record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
$frontendScheme = if ($record.frontendScheme) { [string]$record.frontendScheme } elseif ($record.frontendHttps) { 'https' } else { 'http' }
$frontendLocalHostForHealthCheck = if ($frontendScheme -eq 'https') { 'localhost' } else { '127.0.0.1' }
$frontendUrl = "${frontendScheme}://$frontendLocalHostForHealthCheck`:$($record.frontendPort)"
$backendUrl = "http://127.0.0.1:$($record.backendPort)"
$backendHealthUrl = "$backendUrl/health"
$frontendHost = if ($record.frontendHost) { [string]$record.frontendHost } else { '127.0.0.1' }
$frontendHttps = $frontendScheme -eq 'https'

$backendShellAlive = Test-ProcessAlive -ProcessId ([int]$record.backendShellPid)
$frontendShellAlive = Test-ProcessAlive -ProcessId ([int]$record.frontendShellPid)
$backendListeningPids = @(Get-ListeningProcessIds -Port ([int]$record.backendPort))
$frontendListeningPids = @(Get-ListeningProcessIds -Port ([int]$record.frontendPort))
$backendHealthReady = Test-HttpReady -Uri $backendHealthUrl
$effectiveDatabase = if ($backendHealthReady) {
  Get-BackendDatabaseSummary -HealthUrl $backendHealthUrl
} else {
  $null
}
if (-not $effectiveDatabase) {
  $effectiveDatabase = Get-FallbackEffectiveDatabaseSummary -Record $record
}
$frontendReady = $frontendListeningPids.Count -gt 0
if (-not $frontendReady -and -not $frontendHttps) {
  # HTTP 场景可补充一次应用层探测，避免仅靠端口监听误判。
  $frontendReady = Test-HttpReady -Uri $frontendUrl
}

Write-Info '本地联调状态如下：'
Write-Info "StartedAt: $($record.startedAt)"
Write-Info "Frontend: $frontendUrl"
Write-Info "Backend:  $backendUrl"
Write-Info "Frontend host: $frontendHost"
Write-Info "当前数据库: $($effectiveDatabase.displayName)"
Write-Info "数据库来源: $($effectiveDatabase.source)"
Write-Info "覆盖状态: $($effectiveDatabase.overrideStatus)"
Write-Info "数据库摘要: $($effectiveDatabase.summary)"
Write-Info "数据库说明: $($effectiveDatabase.description)"
Write-Info "Backend shell alive: $backendShellAlive"
Write-Info "Frontend shell alive: $frontendShellAlive"
Write-Info "Backend listening PIDs: $($(if ($backendListeningPids.Count) { $backendListeningPids -join ', ' } else { 'none' }))"
Write-Info "Frontend listening PIDs: $($(if ($frontendListeningPids.Count) { $frontendListeningPids -join ', ' } else { 'none' }))"
Write-Info "Backend health ready: $backendHealthReady"
Write-Info "Frontend ready: $frontendReady"

if ($frontendHost -eq '0.0.0.0' -or $frontendHost -eq '*') {
  $lanIpAddresses = @(Get-LanIPv4Addresses)
  if ($lanIpAddresses.Count -gt 0) {
    Write-Info '局域网访问地址：'
    foreach ($lanIpAddress in $lanIpAddresses) {
      Write-Info "  管理端: ${frontendScheme}://$lanIpAddress`:$($record.frontendPort)/login"
      Write-Info "  客户端: ${frontendScheme}://$lanIpAddress`:$($record.frontendPort)/client/login"
    }
  }
}

if (-not $backendShellAlive -and -not $frontendShellAlive -and -not $backendListeningPids.Count -and -not $frontendListeningPids.Count) {
  Write-WarnMessage '记录文件存在，但本地联调进程似乎已不在运行，可执行 .\stop-local-dev.ps1 做清理。'
}
