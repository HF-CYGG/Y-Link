<#
妯″潡璇存槑锛歴top-local-dev.ps1
  鏂囦欢鑱岃矗锛氬仠姝㈢敱 `start-local-dev.ps1` 璁板綍鐨勬湰鍦拌仈璋冨墠鍚庣杩涚▼锛屽苟娓呯悊涓存椂杩愯鏂囦欢銆?
  瀹炵幇閫昏緫锛氫粠 `.local-dev/processes.json` 璇诲彇 shell PID 涓庣洃鍚?PID锛岄€掑綊缁堟杩涚▼鏍戝悗鍐嶅垹闄ゅ惎鍔ㄦ椂鐢熸垚鐨勪复鏃舵枃浠躲€?
#>

$ErrorActionPreference = 'Stop'

# 鎵€鏈夎繍琛屾€佷俊鎭兘浠庝粨搴撴牴鐩綍涓嬬殑 `.local-dev` 鐩綍璇诲彇锛?
# 杩欐牱鏃犺鐢ㄦ埛褰撳墠鍦ㄥ摢涓?PowerShell 宸ヤ綔鐩綍鎵ц鍋滄鑴氭湰锛屾竻鐞嗙洰鏍囬兘淇濇寔涓€鑷淬€?
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $ProjectRoot '.local-dev'
$PidFile = Join-Path $RuntimeRoot 'processes.json'

# 鍦ㄢ€滄湁璁板綍浣嗘竻鐞嗕俊鎭笉瀹屾暣鈥濇椂杈撳嚭鎻愰啋锛屼究浜庡揩閫熷垽鏂綋鍓嶅仠姝㈤摼璺槸鍚﹀畬鏁淬€?
function Write-WarnMessage {
  param([string]$Message)
  Write-Host "[local-dev][warn] $Message" -ForegroundColor Yellow
}

function Write-Info {
  param([string]$Message)
  Write-Host "[local-dev] $Message"
}

# 閫掑綊鏀堕泦鎵€鏈夊瓙瀛欒繘绋嬶紝闃叉鍙叧闂埗杩涚▼鍚庢畫鐣?npm/node 鐩戝惉銆?
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

# 鍋滄椤哄簭涓庡惎鍔ㄨ剼鏈竴鑷达細浼樺厛瀛愯繘绋嬶紝鍐嶅仠姝㈡牴杩涚▼銆?
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
  Write-Info '鏈壘鍒版湰鍦拌仈璋冭繘绋嬭褰曪紝鏃犻渶鍋滄銆?
  exit 0
}

$record = Get-Content -Path $PidFile -Raw | ConvertFrom-Json
# 鍚屾椂鍏煎鏃ц褰曚腑鐨?shell PID 鍜屾柊璁板綍涓殑鐩戝惉 PID銆?
$processIds = @(Get-RecordedProcessIds -Record $record)

if (-not $processIds.Count) {
  Write-WarnMessage '妫€娴嬪埌鏈湴鑱旇皟璁板綍鏂囦欢锛屼絾鍏朵腑娌℃湁鍙敤鐨?PID 淇℃伅銆?
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
  # 鍚姩鑴氭湰浼氬垱寤轰竴涓┖ stdin 鏂囦欢缁欓殣钘忓瓙杩涚▼澶嶇敤锛岃繖閲屽悓姝ユ竻鐞嗭紝閬垮厤 `.local-dev` 鐩綍娈嬬暀鍣０鏂囦欢銆?
  Remove-Item -Path $childProcessInputFile -Force -ErrorAction SilentlyContinue
}

# 先删除 PID 记录文件，再输出完成提示，避免下次启动时误判为仍有旧运行态残留。
Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
Write-Info '已停止记录中的本地联调进程，并完成运行痕迹清理。'
