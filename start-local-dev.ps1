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
# 禁用 Web 请求进度输出，避免终端反复出现“正在读取 Web 响应”噪声。
$ProgressPreference = 'SilentlyContinue'

# 鎵€鏈夎繍琛屾椂璺緞閮戒粠浠撳簱鏍圭洰褰曟帹瀵硷細
# - 閬垮厤鐢ㄦ埛鍦ㄤ换鎰?cwd 鎵ц鑴氭湰鏃跺嚭鐜扮浉瀵硅矾寰勫け鏁堬紱
# - 缁熶竴鎶婃棩蹇椼€丳ID銆佷复鏃?env 鏂囦欢鏀舵暃鍒?.local-dev 鐩綍涓嬨€?
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

# 缁熶竴鐨勮鍛婅緭鍑猴紝鏂逛究鍦ㄦ甯稿惎鍔ㄤ俊鎭腑蹇€熻瘑鍒紓甯稿垎鏀€?
function Write-WarnMessage {
  param([string]$Message)
  Write-Host "[local-dev][warn] $Message" -ForegroundColor Yellow
}

# 鍚姩鍓嶆鏌ュ叧閿懡浠ゆ槸鍚﹀瓨鍦紝閬垮厤鑴氭湰璧板埌涓€鍗婃墠鍥犵幆澧冪己澶卞け璐ャ€?
function Assert-CommandAvailable {
  param([string]$CommandName)

  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $CommandName"
  }
}

# 瑙ｆ瀽褰撳墠绯荤粺涓殑 PowerShell 5 鍙墽琛屾枃浠剁粷瀵硅矾寰勶細
# - 浼樺厛澶嶇敤褰撳墠 PowerShell 杩涚▼鎵€鍦ㄥ畨瑁呯洰褰曪紱
# - 閬垮厤 Start-Process 鍐嶆渚濊禆 PATH 鏌ユ壘 powershell.exe锛?
# - 鍦ㄥ彈闄愮粓绔垨 PATH 涓嶅畬鏁寸殑鐜涓嬩粛鑳界ǔ瀹氭媺璧峰墠鍚庣瀛愯繘绋嬨€?
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

# 纭繚鐩爣鏂囦欢鐨勭埗鐩綍瀛樺湪锛岄伩鍏?SQLite 璺緞鎴栦复鏃?env 鏂囦欢鍐欏叆澶辫触銆?
function Ensure-ParentDirectory {
  param([string]$Path)

  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

# 鍩轰簬鍥哄畾 env 妯℃澘鐢熸垚涓€浠解€滄湰娆″惎鍔ㄤ笓鐢ㄢ€濈殑涓存椂 env 鏂囦欢锛?
# 杩欐牱鑴氭湰浼犲叆鐨勭鍙ｇ瓑瑕嗙洊鍊间笉浼氳 .env.local-dev 閲嶆柊鍘嬪洖榛樿鍊笺€?
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
    $lines | Where-Object { $_ -notmatch "^\\s*PORT\\s*=" }
  )

  $effectiveLines = @($filteredLines + "PORT=$TargetPort")
  Set-Content -Path $TargetEnvFile -Value $effectiveLines -Encoding UTF8
}

# 閫掑綊鏀堕泦鏌愪釜杩涚▼鐨勬墍鏈夊瓙瀛欒繘绋?PID锛屼繚璇佸仠姝㈡椂涓嶄細鐣欎笅 npm/node 瀛ゅ効杩涚▼銆?
function Get-DescendantProcessIds {
  param([int]$RootProcessId)

  # 鏌愪簺鐜涓?CIM 鏌ヨ鍙兘闃诲锛岃缃秴鏃堕伩鍏嶅惎鍔ㄩ摼璺鍗℃銆?
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

# 鍏堝仠瀛愯繘绋嬪啀鍋滄牴杩涚▼锛岄伩鍏嶄粎鏉€澶栧眰 PowerShell 瀵艰嚧鐩戝惉绔彛娈嬬暀銆?
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

# 璇诲彇鏁版嵁搴撹繍琛屾椂瑕嗙洊鏂囦欢锛?
# - 鑻ユ湰鍦扮幆澧冩鍓嶅凡缁忛€氳繃杩佺Щ鍔╂墜鍒囨崲鍒?MySQL锛岃繖閲屽彲鐩存帴璇嗗埆锛?
# - 鍚姩鑴氭湰鍙仛鈥滆鍙栧苟灞曠ず鈥濓紝涓嶄慨鏀逛换浣曡鐩栭厤缃€?
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

# 璇诲彇绠€鍗?env 鏂囦欢涓殑閿€煎锛?
# - 浠呭鐞?`KEY=VALUE` 缁撴瀯锛屽拷鐣ョ┖琛屽拰娉ㄩ噴锛?
# - 鏈湴鑴氭湰鍙敤瀹冨厹搴曟帹鏂暟鎹簱鐩爣锛屼笉鎵挎媴瀹屾暣 dotenv 瑙ｆ瀽鑱岃矗銆?
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
    if ($line -match "^\\s*#") {
      continue
    }
    if ($line -notmatch "^\\s*([^=]+?)\\s*=(.*)$") {
      continue
    }

    $key = $Matches[1].Trim()
    $value = $Matches[2]
    $envMap[$key] = $value
  }

  return $envMap
}

# 鎶婂悗绔?env 鏂囦欢閲岀殑 SQLite 璺緞琛ラ綈涓虹粷瀵硅矾寰勶細
# - 鐩稿璺緞缁熶竴鐩稿 backend 鏍圭洰褰曡В鏋愶紱
# - 涓庡悗绔粯璁よ繍琛屾柟寮忎繚鎸佷竴鑷达紝渚夸簬鑴氭湰杈撳嚭鍙洿鎺ュ畾浣嶇殑鐪熷疄鏂囦欢鍦板潃銆?
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

# 鐩存帴璇诲彇鍚庣鍋ュ悍妫€鏌ヤ腑鐨勬暟鎹簱鎽樿锛?
# - 璇ユ帴鍙ｈ繑鍥炵殑鏄€滃綋鍓嶈繘绋嬪凡缁忓疄闄呯敓鏁堚€濈殑鏁版嵁搴撶姸鎬侊紱
# - 鍚姩鑴氭湰浼樺厛淇′换瀹冿紝閬垮厤鍐嶉潬鏈湴鏂囦欢鐚滄祴褰撳墠鏁版嵁搴撱€?
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

# 褰撳悗绔仴搴锋鏌ユ殏鏃朵笉鍙鏃讹紝鑴氭湰浠嶅彲鍩轰簬鏈湴鏂囦欢鍋氬厹搴曟帹鏂細
# - 鑻ュ綋鍓嶅瓨鍦ㄨ繍琛屾椂瑕嗙洊鏂囦欢锛屼紭鍏堟寜瑕嗙洊鐩爣鎺ㄦ柇鈥滈噸鍚悗灏嗛噰鐢ㄤ粈涔堝簱鈥濓紱
# - 鑻ヤ笉瀛樺湪瑕嗙洊鏂囦欢锛屽垯璇诲彇鏈鍚姩浣跨敤鐨勪复鏃?env 鏂囦欢锛岃€屼笉鏄‖缂栫爜涓?SQLite銆?
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

  # 閮ㄥ垎 Windows 鐜涓?Get-NetTCPConnection 鍙兘闀挎椂闂村崱浣忥紝鏀圭敤 netstat 瑙ｆ瀽鎻愬崌绋冲畾鎬с€?
  $netstatOutput = & netstat -ano -p tcp 2>$null
  if (-not $netstatOutput) {
    return @()
  }

  $listeningPidSet = [System.Collections.Generic.HashSet[int]]::new()
  $portPattern = ":(?:$Port)\s+.+\s+(?:LISTENING|渚﹀惉)\s+(\d+)\s*$"

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

function Stop-RecordedProcesses {
  if (-not (Test-Path $PidFile)) {
    return
  }

  try {
    $record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
    # 鍚屾椂娓呯悊澶栧眰 shell PID 鍜岀湡姝ｇ洃鍚鍙ｇ殑杩涚▼ PID锛屽閿欐洿寮恒€?
    $processIds = @(Get-RecordedProcessIds -Record $record)
    foreach ($processId in $processIds) {
      if ($processId) {
        Stop-ProcessTree -RootProcessId ([int]$processId)
      }
    }

    # 閲嶅鍚姩鍓嶄竴骞跺垹闄や笂娆＄敓鎴愮殑涓存椂 env 鏂囦欢锛岄伩鍏嶆棫鐘舵€佹畫鐣欍€?
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

  $listeningProcessIds = @(Get-ListeningProcessIds -Port $Port)
  if ($listeningProcessIds.Count -eq 0) {
    return
  }

  # 鍚姩鍓嶇/鍚庣鍓嶅己鍒跺洖鏀跺啿绐佺鍙ｏ細
  # - 绔彛鑻ヨ鍘嗗彶娈嬬暀杩涚▼鍗犵敤锛岀洿鎺ョ粓姝㈠搴旇繘绋嬫爲锛岄伩鍏嶆墜宸ユ帓闅滐紱
  # - 浠呭鐩爣绔彛涓婄殑鐩戝惉杩涚▼鐢熸晥锛屼笉浼氭棤宸埆娓呯悊绯荤粺鍏跺畠杩涚▼銆?
  Write-WarnMessage "$ServiceName port $Port 琚崰鐢紝鍑嗗寮哄埗缁撴潫鍐茬獊杩涚▼锛?($listeningProcessIds -join ', ')"
  foreach ($processId in $listeningProcessIds) {
    if ([int]$processId -eq [int]$PID) {
      continue
    }
    Stop-ProcessTree -RootProcessId ([int]$processId)
  }

  for ($attempt = 1; $attempt -le 10; $attempt++) {
    Start-Sleep -Milliseconds 500
    $remainingProcessIds = @(Get-ListeningProcessIds -Port $Port)
    if ($remainingProcessIds.Count -eq 0) {
      Write-Info "$ServiceName port $Port 已释放，继续启动。"
      return
    }
  }

  $remainingProcessIds = @(Get-ListeningProcessIds -Port $Port)
  throw "$ServiceName port $Port is still in use by PID(s): $($remainingProcessIds -join ', ')."
}

function Initialize-ChildProcessInputFile {
  param([string]$InputFilePath)

  $ensureInputFile = {
    param([string]$TargetPath)
    Set-Content -Path $TargetPath -Value '' -Encoding UTF8
  }

  try {
    & $ensureInputFile -TargetPath $InputFilePath
    return $InputFilePath
  }
  catch {
    Write-WarnMessage "妫€娴嬪埌 stdin 鏂囦欢琚崰鐢紝鍑嗗寮哄埗娓呯悊鍗犵敤杩涚▼锛?InputFilePath"
    $holderPids = @(Get-ProcessIdsByCommandLineKeyword -Keyword $InputFilePath)
    foreach ($holderPid in $holderPids) {
      if ([int]$holderPid -eq [int]$PID) {
        continue
      }
      Stop-ProcessTree -RootProcessId ([int]$holderPid)
    }

    Start-Sleep -Milliseconds 300
    try {
      & $ensureInputFile -TargetPath $InputFilePath
      Write-Info "stdin 鏂囦欢鍗犵敤宸叉竻鐞嗭細$InputFilePath"
      return $InputFilePath
    }
    catch {
      $fallbackPath = Join-Path $RuntimeRoot ("child-process.stdin.{0}.txt" -f (Get-Date -Format 'yyyyMMddHHmmssfff'))
      Set-Content -Path $fallbackPath -Value '' -Encoding UTF8
      Write-WarnMessage "鍘?stdin 鏂囦欢浠嶄笉鍙啓锛屽凡鍒囨崲涓烘湰娆′細璇濅笓鐢ㄦ枃浠讹細$fallbackPath"
      return $fallbackPath
    }
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

      # 鍙鑳借繑鍥?2xx~4xx锛屽氨璇存槑鐩爣 HTTP 鏈嶅姟宸茬粡鐪熸鐩戝惉骞惰兘澶勭悊璇锋眰锛?
      # 杩欓噷涓嶅己鍒惰姹備笟鍔℃垚鍔燂紝鍙獙璇佲€滄湇鍔″凡璧锋潵鈥濄€?
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

# 鏀堕泦褰撳墠鏈哄櫒鍙敤浜庡眬鍩熺綉璁块棶鐨?IPv4 鍦板潃锛?
# - 杩囨护 loopback銆丄PIPA(169.254.x.x) 涓庢棤鏁堝湴鍧€锛?
# - 鍚姩鎴愬姛鍚庣洿鎺ユ墦鍗板彲璁块棶閾炬帴锛屼究浜庢墜鏈?骞虫澘鑱旇皟銆?
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

  # 浣跨敤鏍煎紡鍖栧瓧绗︿覆鏇夸唬鍙屽紩鍙峰唴鐨勫鏉傛彃鍊硷紝閬垮厤 PowerShell 5 鍦ㄥ惎鍔ㄦ憳瑕侀樁娈靛嚭鐜拌В鏋愭涔夈€?
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

# 鍒ゆ柇涓€缁?PID 涓槸鍚︿粛鏈夊瓨娲昏繘绋嬶細
# - 鍚姩鑴氭湰鏃細璁板綍澶栧眰 shell PID锛屼篃浼氳褰曠湡姝ｇ洃鍚鍙ｇ殑 node PID锛?
# - 鏃ュ織璺熼殢搴斾紭鍏堜緷鎹€滅湡瀹炴湇鍔¤繘绋嬫槸鍚﹁繕娲荤潃鈥濇潵鍐冲畾鏄惁缁х画銆?
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

  # 褰撳墠缁堢缁熶竴杩借釜鍓嶅悗绔棩蹇楋細
  # - 鍚庡彴鏈嶅姟缁х画鐙珛杩愯锛屼絾涓嶅啀寮瑰嚭棰濆榛戠獥锛?
  # - 褰撳墠缁堢浠呰礋璐ｈ疆璇㈡棩蹇楁枃浠跺苟鍔犲墠缂€杈撳嚭锛屼究浜庨泦涓瀵燂紱
  # - 鎸?Ctrl+C 閫€鍑烘棩蹇楄窡闅忔椂锛屼細缁х画妫€鏌ユ湇鍔℃槸鍚︿粛瀛樻椿锛屽啀鍐冲畾鏄繚鐣欒繕鏄竻鐞嗚褰曘€?
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

# 娴忚鍣ㄨ嚜鍔ㄦ墦寮€灞炰簬鍙€夊寮猴細
# - 浠呭湪鏈嶅姟宸插氨缁悗鎵ц锛岄伩鍏嶆墦寮€涓€涓皻鏈彲璁块棶鐨勫湴鍧€锛?
# - 澶辫触鏃跺彧缁欏嚭璀﹀憡锛屼笉褰卞搷鏈湴鑱旇皟閾捐矾鏈韩銆?
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
$ChildProcessInputFile = Initialize-ChildProcessInputFile -InputFilePath $ChildProcessInputFile

Write-Info 'Starting backend local profile...'
# 鍚庣閫氳繃鈥滅嫭绔?PowerShell + 涓存椂 env 鏂囦欢鈥濆惎鍔細
# - 閬垮厤 npm 涓?PowerShell 鍙傛暟杞箟浜掔浉骞叉壈锛?
# - 鍏佽鏈鍚姩鍔ㄦ€佽鐩栫鍙?profile锛屽悓鏃朵笉姹℃煋婧?env 鏂囦欢銆?
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
# 鍓嶇鍙惎鍔ㄤ竴涓?Vite 寮€鍙戞湇鍔★紝鍚屾椂鎵胯浇绠＄悊绔笌瀹㈡埛绔〉闈紝
# 閫氳繃娉ㄥ叆鏈鍚庣鍦板潃锛屼繚璇佹湰鍦拌仈璋冩椂鎺ュ彛缁熶竴鎸囧悜褰撳墠鍚庣绔彛銆?
# 榛樿鐩戝惉 0.0.0.0锛岃繖鏍峰眬鍩熺綉鍐呭叾浠栬澶囦篃鑳界洿鎺ヨ闂綋鍓嶈皟璇曢〉銆?
# 鍚屾椂榛樿鍚敤鑷鍚?HTTPS锛屼繚璇佹墜鏈虹湡鏈鸿仈璋冩椂鍙娇鐢ㄦ祻瑙堝櫒鎽勫儚澶磋兘鍔涖€?
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
  # 灏辩华鏍￠獙蹇呴』鍦ㄨ褰?PID 涔嬪墠瀹屾垚锛?
  # - 鑻ユ湇鍔″叾瀹炴湭鎴愬姛鎷夎捣锛屽氨涓嶅啓鍏モ€滃亣鎴愬姛鈥濈殑杩愯璁板綍锛?
  # - 澶辫触鏃剁洿鎺ヨ繘鍏?catch锛岃緭鍑烘棩蹇楀熬閮ㄥ府鍔╂帓鏌ャ€?
  Wait-HttpReady -Uri "http://127.0.0.1:$BackendPort/health" -ServiceName 'backend health' -MaxAttempts $MaxReadyAttempts
  # 鍓嶇灏辩华鏀逛负绔彛鐩戝惉鎺㈡祴锛?
  # 鍦?PowerShell 5 + 鑷鍚?HTTPS 鍦烘櫙涓嬶紝Invoke-WebRequest 鍙兘鍥犱负 TLS 鎻℃墜鎴栬瘉涔︾瓥鐣ュ弽澶嶅け璐ワ紝
  # 浣?dev server 瀹為檯宸茬粡鍙敤锛屼娇鐢ㄧ鍙ｆ帰娴嬫洿绋炽€?
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
        # 鏃ュ織璺熼殢鍚庡啀娆″垽鏂湡瀹炴湇鍔℃槸鍚︿粛鍦紝瑙ｅ喅鈥滃灞?shell 閫€鍑轰絾 node 浠嶅湪鈥濅笌鐩稿弽鎯呭喌銆?
        $servicesStillAlive = (
          (Test-ProcessAlive -ProcessId $backendProcess.Id) -or
          (Test-ProcessAlive -ProcessId $frontendProcess.Id) -or
          (Test-AnyProcessAlive -ProcessIds $backendListeningPids) -or
          (Test-AnyProcessAlive -ProcessIds $frontendListeningPids)
        )

        if ($servicesStillAlive) {
          Write-Info '日志跟随已结束，但本地联调服务仍在运行，可继续访问页面或手动执行 .\\stop-local-dev.ps1 停止。'
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
  # 鍚姩澶辫触鏃朵紭鍏堟竻鐞嗚繘绋嬫爲锛屽啀鎵撳嵃鏃ュ織灏鹃儴锛岄伩鍏嶅け璐ヨ繘绋嬬户缁崰鐢ㄧ鍙ｆ垨杩藉姞鏃犲叧鏃ュ織銆?
  Stop-ProcessTree -RootProcessId $backendProcess.Id
  Stop-ProcessTree -RootProcessId $frontendProcess.Id
  Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
  Show-LogTail -Title 'backend.log' -LogPath $BackendLog
  Show-LogTail -Title 'backend.error.log' -LogPath $BackendErrorLog
  Show-LogTail -Title 'frontend.log' -LogPath $FrontendLog
  Show-LogTail -Title 'frontend.error.log' -LogPath $FrontendErrorLog
  throw
}

