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

# 输出统一的当前数据库摘要：
# - 若存在 MySQL 覆盖，则优先展示 MySQL；
# - 若存在 SQLite 覆盖，则展示回退后的 SQLite；
# - 若不存在覆盖，则回落为本地默认 SQLite 记录。
function Get-EffectiveDatabaseSummary {
  param($Record)

  $runtimeOverride = Get-RuntimeOverrideState
  if ($runtimeOverride -and $runtimeOverride.config -and $runtimeOverride.config.DB_TYPE -eq 'mysql') {
    return @{
      mode = 'mysql'
      displayName = 'MySQL'
      summary = "$($runtimeOverride.config.DB_HOST):$($runtimeOverride.config.DB_PORT)/$($runtimeOverride.config.DB_NAME)"
      source = '运行时覆盖配置'
    }
  }

  if ($runtimeOverride -and $runtimeOverride.config -and $runtimeOverride.config.DB_TYPE -eq 'sqlite' -and $runtimeOverride.config.SQLITE_DB_PATH) {
    return @{
      mode = 'sqlite'
      displayName = 'SQLite'
      summary = [string]$runtimeOverride.config.SQLITE_DB_PATH
      source = '运行时覆盖配置'
    }
  }

  return @{
    mode = 'sqlite'
    displayName = 'SQLite'
    summary = [string]$Record.sqlitePath
    source = '默认本地环境配置'
  }
}

if (-not (Test-Path $PidFile)) {
  Write-Info '本地联调当前未记录为运行中。'
  exit 0
}

$record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
$effectiveDatabase = Get-EffectiveDatabaseSummary -Record $record
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
Write-Info "数据库摘要: $($effectiveDatabase.summary)"
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
