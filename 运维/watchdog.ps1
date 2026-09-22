<#
  审核工作台 · 自愈看门狗
  ────────────────────────────────────────────────────────────────
  由计划任务「审核工作台看门狗」每 5 分钟调用一次，做四件事：

    1) 探测本机 8787 是否响应；
    2) 不响应则 8 秒后重试一次（避免某次大审核占用导致偶发超时被误判）；
    3) 仍不响应 → 找到那个跑 server.mjs 的计划任务：
         · 被禁用 → 启用
         · 显示 Running 但端口不通（进程卡死）→ 重启
         · 没在跑 → 拉起
    4) 全过程写进 watchdog.log；**正常时不写日志**（只在每天 0 点写一条心跳），
       避免日志无限膨胀；单文件超过 512 KB 自动截断保留最后 200 行。

  设计约束（与本项目其它脚本一致）：
    · 不依赖 DSH / WorkBuddy，不依赖是否有人登录 Windows；
    · 路径全部由 $PSScriptRoot 推导，不写死中文路径；
    · 任务通过「动作里含 server.mjs」来定位，不靠任务名字符串，
      这样以后任务改名也不会失效。
#>

$ErrorActionPreference = 'Continue'

$Port     = 8787
$Url      = "http://127.0.0.1:$Port/"
$Log      = Join-Path $PSScriptRoot 'watchdog.log'
$MaxLogKB = 512

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $Log -Value $line -Encoding UTF8
  if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt $MaxLogKB * 1KB)) {
    $tail = Get-Content $Log -Tail 200
    Set-Content -Path $Log -Value $tail -Encoding UTF8
  }
}

function Test-Service {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-AppTask {
  Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.Actions | Where-Object { ("$($_.Execute) $($_.Arguments)") -match 'server\.mjs' }
  }
}

# ───── 1) 探测 ─────
if (Test-Service) {
  $now = Get-Date
  if ($now.Hour -eq 0 -and $now.Minute -lt 5) {
    $t = Get-AppTask | Select-Object -First 1
    Write-Log ("OK    heartbeat - service alive, task state: " + $(if ($t) { $t.State } else { 'not found' }))
  }
  exit 0
}

Start-Sleep -Seconds 8
if (Test-Service) {
  Write-Log 'WARN  first probe failed, second succeeded (transient, no action)'
  exit 0
}

# ───── 2) 确认故障，开始自愈 ─────
Write-Log 'FAIL  port 8787 not responding after 2 probes -- starting recovery'

$task = Get-AppTask | Select-Object -First 1
if (-not $task) {
  Write-Log 'FAIL  cannot find any scheduled task running server.mjs -- manual fix needed'
  exit 1
}
Write-Log ("INFO  target task: " + $task.TaskName + "   state=" + $task.State)

try {
  if ($task.State -eq 'Disabled') {
    Enable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null
    Write-Log 'FIX   task was disabled -> enabled'
  }
  if ($task.State -eq 'Running') {
    Write-Log 'FIX   task reports Running but port is dead (hung process) -> restart'
    Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath
    Start-Sleep -Seconds 4
  }
  Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath
  Write-Log 'FIX   start issued'
} catch {
  Write-Log ("FAIL  recovery error: " + $_.Exception.Message)
}

# ───── 3) 复检 ─────
for ($i = 1; $i -le 6; $i++) {
  Start-Sleep -Seconds 5
  if (Test-Service) {
    Write-Log ("OK    service recovered after " + ($i * 5) + "s")
    exit 0
  }
}
Write-Log 'FAIL  service still down after recovery attempt -- manual intervention needed'
exit 1
