<#
  工程咨询成果审核工作台 · 异机恢复
  ════════════════════════════════════════════════════════════════
  在一台新电脑上，从备份包把这套系统恢复起来。

  用法（在备份目录里执行）：
    # 1) 先干跑，看看会做什么、依赖缺不缺（不改任何东西）
    powershell -File restore.ps1 -Target "D:\审核工作台" -DryRun

    # 2) 确认无误后真正恢复
    powershell -File restore.ps1 -Target "D:\审核工作台"

    # 3) 恢复后设置 API Key 并启动
    powershell -File restore.ps1 -Target "D:\审核工作台" -ApiKey "sk-xxxxxxxx"

  恢复脚本会做：
    ① 校验 manifest.json 里每个文件的 SHA256（发现损坏会明确报出来）
    ② 检查运行依赖（Node / LibreOffice / MarkItDown / Pandoc / Chrome）
    ③ 把 app\ 复制到目标目录
    ④ 导入两个计划任务，并把里面的路径改成本机新路径
    ⑤ 重建 8787 防火墙规则
    ⑥ 设置机器级 DEEPSEEK_API_KEY（给了 -ApiKey 才做）
    ⑦ 打印启动与验证步骤

  注意：恢复**不会**覆盖已存在的目标目录里的文件，除非加 -Force。
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Target,
  [string]$ApiKey = '',
  [switch]$DryRun,
  [switch]$Force,
  [switch]$SkipTasks
)

$ErrorActionPreference = 'Stop'
$BkRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m) { Write-Host $m }
function Step($n, $m) { Write-Host ''; Write-Host "[$n] $m" }

Say '═══════════════════════════════════════════════════'
Say '  工程咨询成果审核工作台 · 恢复'
Say "  备份包 $BkRoot"
Say "  目标   $Target"
if ($DryRun) { Say '  模式   干跑（不改动任何东西）' }
Say '═══════════════════════════════════════════════════'

# ─────────── ① 校验完整性 ───────────
Step '1/7' '校验备份完整性…'
$mfPath = Join-Path $BkRoot 'manifest.json'
if (-not (Test-Path $mfPath)) { throw "备份包不完整：找不到 manifest.json" }
$mf = Get-Content $mfPath -Raw -Encoding UTF8 | ConvertFrom-Json
Say "      系统 $($mf.system)  v$($mf.version)"
Say "      备份于 $($mf.backupAt)   源机器 $($mf.hostname)"
Say "      文件 $($mf.fileCount) 个，$([math]::Round($mf.totalBytes/1MB,1)) MB"
if ($mf.light) { Say '      ⚠ 这是精简备份：任务留档里的原件与大 PDF 未包含' }

$bad = @(); $checked = 0
foreach ($f in $mf.files) {
  $p = Join-Path $BkRoot $f.path
  if (-not (Test-Path $p)) { $bad += "缺失: $($f.path)"; continue }
  $h = (Get-FileHash $p -Algorithm SHA256).Hash
  if ($h -ne $f.sha256) { $bad += "校验不符: $($f.path)" }
  $checked++
}
if ($bad.Count) {
  Say "      ✗ 有 $($bad.Count) 个文件有问题："
  $bad | Select-Object -First 20 | ForEach-Object { Say "        $_" }
  if (-not $Force) { throw '备份包校验未通过，已中止（确认无碍可加 -Force 继续）' }
  Say '      已加 -Force，继续。'
} else {
  Say "      ✓ $checked 个文件 SHA256 全部匹配"
}

# ─────────── ② 检查依赖 ───────────
Step '2/7' '检查运行依赖…'
$deps = @(
  @{ n='Node.js';     p='C:\Program Files\nodejs\node.exe';                                   must=$true;  how='https://nodejs.org/ （装 24.x 或更高）' },
  @{ n='LibreOffice'; p='C:\Program Files\LibreOffice\program\soffice.exe';                   must=$true;  how='https://zh-cn.libreoffice.org/download/ （用于 .doc 转换）' },
  @{ n='MarkItDown';  p="$env:LOCALAPPDATA\Programs\Python\Python312\Scripts\markitdown.exe"; must=$true;  how='先装 Python 3.12，再 pip install markitdown' },
  @{ n='Pandoc';      p="$env:USERPROFILE\scoop\shims\pandoc.exe";                            must=$false; how='scoop install pandoc （备用转换，可选）' },
  @{ n='Chrome/Edge'; p='C:\Program Files\Google\Chrome\Application\chrome.exe';             must=$false; how='任意 Chrome 或 Edge 即可（成果转 PDF 用）' }
)
$missingMust = @()
foreach ($d in $deps) {
  $ok = Test-Path $d.p
  if (-not $ok -and $d.n -eq 'Chrome/Edge') {
    $ok = Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  }
  Say ("      {0} {1,-12} {2}" -f $(if ($ok) { '✓' } else { '✗' }), $d.n, $(if ($ok) { '已安装' } else { "缺失 → $($d.how)" }))
  if (-not $ok -and $d.must) { $missingMust += $d.n }
}
if ($missingMust.Count) {
  Say ''
  Say "      ⚠ 缺少必需组件：$($missingMust -join '、')"
  Say '        装好之后再启动服务；装到非默认路径的话要改 web\lib.mjs 顶部的常量。'
}

# ─────────── ③ 复制应用文件 ───────────
Step '3/7' '复制应用文件…'
$src = Join-Path $BkRoot 'app'
if (-not (Test-Path $src)) { throw '备份包里找不到 app\ 目录' }
if (Test-Path $Target) {
  $exist = (Get-ChildItem $Target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($exist -gt 0 -and -not $Force) {
    throw "目标目录已存在且有 $exist 个文件：$Target`n如确认要覆盖，请加 -Force"
  }
}
if ($DryRun) {
  $n = (Get-ChildItem $src -Recurse -File | Measure-Object).Count
  Say "      （干跑）将把 $n 个文件复制到 $Target"
} else {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Copy-Item (Join-Path $src '*') $Target -Recurse -Force
  $n = (Get-ChildItem $Target -Recurse -File | Measure-Object).Count
  Say "      ✓ 已复制 $n 个文件到 $Target"
}

# ─────────── ④ 导入计划任务 ───────────
Step '4/7' '导入计划任务…'
if ($SkipTasks) {
  Say '      （已跳过）'
} else {
  $taskDir = Join-Path $BkRoot 'machine\scheduled-tasks'
  if (-not (Test-Path $taskDir)) { Say '      备份里没有计划任务，跳过' }
  else {
    foreach ($xmlFile in Get-ChildItem $taskDir -Filter '*.xml') {
      $xml = Get-Content $xmlFile.FullName -Raw -Encoding UTF8
      # 把备份时的源路径替换成本机新路径（计划任务的动作里写的是绝对路径）
      $oldPath = $mf.sourcePath
      $xml = $xml -replace [regex]::Escape($oldPath), $Target
      $tmp = Join-Path $env:TEMP ("task-$($xmlFile.BaseName).xml")
      [System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::Unicode)
      if ($DryRun) {
        Say "      （干跑）将导入计划任务：$($xmlFile.BaseName)   路径 $oldPath → $Target"
      } else {
        try {
          Register-ScheduledTask -Xml (Get-Content $tmp -Raw -Encoding Unicode) -TaskName $xmlFile.BaseName -Force | Out-Null
          Say "      ✓ 已导入：$($xmlFile.BaseName)"
        } catch { Say "      ✗ 导入 $($xmlFile.BaseName) 失败：$($_.Exception.Message)" }
      }
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
    Say '      提示：若新机器的登录账号与旧机不同，可能要在「任务计划程序」里重设运行身份。'
  }
}

# ─────────── ⑤ 防火墙 ───────────
Step '5/7' '重建防火墙规则…'
$fwFile = Join-Path $BkRoot 'machine\firewall-8787.txt'
if (Test-Path $fwFile) {
  $cmd = (Get-Content $fwFile -Encoding UTF8 | Where-Object { $_ -like 'New-NetFirewallRule*' } | Select-Object -First 1)
  if ($cmd) {
    if ($DryRun) { Say "      （干跑）将执行：$cmd" }
    else {
      $exist = Get-NetFirewallRule -DisplayName '*8787*' -ErrorAction SilentlyContinue
      if ($exist) { Say '      已存在同名规则，先移除旧的' ; $exist | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
      try { Invoke-Expression $cmd | Out-Null; Say '      ✓ 防火墙规则已重建' }
      catch { Say "      ✗ 重建失败：$($_.Exception.Message)" }
    }
  }
} else { Say '      备份里没有防火墙信息，跳过' }

# ─────────── ⑥ API Key ───────────
Step '6/7' '配置 DeepSeek API Key…'
$keyFile = Join-Path $BkRoot 'machine\api-key.txt'
$keyInBackup = ''
if (Test-Path $keyFile) {
  $line = Get-Content $keyFile -Encoding UTF8 | Where-Object { $_ -match '^DEEPSEEK_API_KEY=sk-' } | Select-Object -First 1
  if ($line) { $keyInBackup = $line.Split('=', 2)[1].Trim() }
}
$useKey = if ($ApiKey) { $ApiKey } else { $keyInBackup }
if ($useKey) {
  if ($DryRun) {
    Say "      （干跑）将设置机器级 DEEPSEEK_API_KEY = $($useKey.Substring(0,7))…（长度 $($useKey.Length)）"
  } else {
    [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $useKey, 'Machine')
    Say "      ✓ 已设置机器级 DEEPSEEK_API_KEY（$($useKey.Substring(0,7))…）"
  }
} else {
  Say '      ⚠ 备份里没有 key（这是安全默认）。恢复后请手工设置：'
  Say '        [Environment]::SetEnvironmentVariable(''DEEPSEEK_API_KEY'',''sk-你的key'',''Machine'')'
}

# ─────────── ⑦ 后续步骤 ───────────
Step '7/7' '完成，接下来这样做'
Say ''
Say "  1) 确认依赖装齐（缺 Node / LibreOffice / MarkItDown 的话先装）"
Say "  2) 启动服务："
Say "     Start-ScheduledTask -TaskName '审核工作台Web服务'"
Say "     Start-ScheduledTask -TaskName '审核工作台看门狗'"
Say "     （若计划任务导入失败，手工执行：cd `"$Target\web`"; node server.mjs）"
Say "  3) 自检（零 API 调用，应全部通过）："
Say "     node `"$Target\engine\test-timing.mjs`""
Say "     node `"$Target\engine\test-duplicate.mjs`""
Say "     node `"$Target\engine\test-standards.mjs`""
Say "  4) 打开 http://127.0.0.1:8787 用原账号登录（账号密码随备份一起恢复）"
# 旧机内网 IP 记在 machine-info.json 里（manifest 不含它）
$oldIp = ''
$miPath = Join-Path $BkRoot 'machine\machine-info.json'
if (Test-Path $miPath) {
  try { $oldIp = ((Get-Content $miPath -Raw -Encoding UTF8 | ConvertFrom-Json).netIPv4 -join ', ') } catch { }
}
Say "  5) 内网访问地址若变了，告诉同事新地址（旧机是 $(if ($oldIp) { $oldIp } else { '见 machine\machine-info.json' }))"
Say ''
Say '  ⚠ 恢复完成后请销毁本目录里可能残留的明文 key（machine\api-key.txt）。'
Say '═══════════════════════════════════════════════════'
