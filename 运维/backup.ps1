<#
  工程咨询成果审核工作台 · 完整备份
  ════════════════════════════════════════════════════════════════
  目的：电脑出故障后能在另一台机器上完整恢复这套系统。

  备份内容（缺一样都恢复不了，所以全都要）：
    app\            整个项目目录（代码 + 配置 + 数据 + 技能 + 运维脚本）
    machine\        不在文件系统里的东西：计划任务、防火墙规则、环境变量、依赖清单
    manifest.json   文件清单 + 每个文件的 SHA256 + 环境快照（用于校验完整性）
    restore.ps1     异机恢复脚本
    README-恢复说明.md

  用法：
    # 默认备份到 E:\ 盘（与源盘 D: 不是同一块物理盘）
    powershell -File backup.ps1

    # 指定位置（可同时备份到多块盘，用逗号分隔）
    powershell -File backup.ps1 -Dest "E:\系统备份"

    # 不压缩，直接留目录（便于网盘同步 / 增量）
    powershell -File backup.ps1 -NoZip

    # 精简模式：任务留档里只保留元数据与成果文本，不打包上传原件与大 PDF
    # （体积从 ~100MB 降到 ~5MB，但恢复后打不开历史报告原件）
    powershell -File backup.ps1 -Light

    # 把 DeepSeek API Key 一并写进备份（默认不写，见下面的安全说明）
    powershell -File backup.ps1 -IncludeApiKey

  安全说明（重要）：
    · 备份包内含 users.json（账号密码哈希，scrypt 加盐）与全部审核报告留档，
      属于敏感数据，**不要放到公共网盘或群里**。
    · DEEPSEEK_API_KEY 默认**不写进备份**——它是可再生的凭据，而备份可能长期躺在移动盘上。
      恢复时用 -IncludeApiKey 导出的文件，或手工重新设置环境变量即可。
#>

[CmdletBinding()]
param(
  # ⚠️ 用 -File 调用时 PowerShell 5.1 不支持数组参数（"a","b" 会被拼成一整串），
  #    所以这里收一个字符串，多个目标用 ; 或 , 分隔。
  [string]$Dest = 'E:\系统备份',
  [switch]$IncludeApiKey,
  [switch]$Light,
  [switch]$NoZip,
  # 每个目标盘上最多保留几份（0 = 不清理，全部保留）。
  # 定时备份必须设这个，否则移动盘会被慢慢塞满。
  [int]$Keep = 0
)

# 把 -Dest 拆成目标列表，顺便去掉引号与尾部反斜杠
$DestList = @($Dest -split '[;,]' | ForEach-Object { $_.Trim().Trim('"').TrimEnd('\') } | Where-Object { $_ })

$ErrorActionPreference = 'Stop'

# ── 项目根目录 = 本脚本所在目录的上一级 ──
$OpsDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Split-Path -Parent $OpsDir
$Version = '1.0.0'
try {
  $vtxt = Get-Content (Join-Path $AppRoot 'VERSION.txt') -Encoding UTF8 -ErrorAction SilentlyContinue
  $m = $vtxt | Select-String -Pattern '^VERSION\s*=\s*(.+)$'
  if ($m) { $Version = $m.Matches[0].Groups[1].Value.Trim() }
} catch { }

$Stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$BkName = "审核工作台_v$Version`_$Stamp"

function Say($msg) { Write-Host $msg }

Say "═══════════════════════════════════════════════════"
Say "  工程咨询成果审核工作台 · 完整备份"
Say "  版本 v$Version    时间 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say "  源目录 $AppRoot"
Say "═══════════════════════════════════════════════════"

# ─────────── 1. 收集「不在文件系统里」的环境信息 ───────────
$machineDir = Join-Path $env:TEMP "wb-machinesnap-$Stamp"
New-Item -ItemType Directory -Force -Path $machineDir | Out-Null

Say ''
Say '[1/5] 收集系统环境信息…'

# 1.1 计划任务（导出 XML，恢复时可直接导入）
$taskDir = Join-Path $machineDir 'scheduled-tasks'
New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
$taskNames = @()
Get-ScheduledTask | Where-Object { $_.TaskName -like '*审核工作台*' } | ForEach-Object {
  $xml = Export-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath
  $safe = ($_.TaskName -replace '[\\/:*?"<>|]', '_')
  [System.IO.File]::WriteAllText((Join-Path $taskDir "$safe.xml"), $xml, (New-Object System.Text.UTF8Encoding($false)))
  $taskNames += $_.TaskName
  Say "      · 计划任务：$($_.TaskName)  ($($_.State))"
}
if (-not $taskNames) { Say '      ⚠ 没找到「审核工作台」相关计划任务' }

# 1.2 防火墙规则
$fw = Get-NetFirewallRule -DisplayName '*8787*' -ErrorAction SilentlyContinue
if ($fw) {
  $lines = foreach ($r in $fw) {
    $pf = $r | Get-NetFirewallPortFilter
    $af = $r | Get-NetFirewallAddressFilter
    "名称: $($r.DisplayName)"
    "启用: $($r.Enabled)   动作: $($r.Action)   配置文件: $($r.Profile)"
    "协议: $($pf.Protocol)   本地端口: $($pf.LocalPort -join ',')"
    "允许来源: $($af.RemoteAddress -join ',')"
    "---"
    "重建命令："
    "New-NetFirewallRule -DisplayName '$($r.DisplayName)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $($pf.LocalPort -join ',') -RemoteAddress $($af.RemoteAddress -join ',')"
  }
  [System.IO.File]::WriteAllLines((Join-Path $machineDir 'firewall-8787.txt'), $lines, (New-Object System.Text.UTF8Encoding($false)))
  Say "      · 防火墙规则：$(@($fw).Count) 条"
} else { Say '      ⚠ 没找到 8787 防火墙规则' }

# 1.3 环境变量
$apiKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'Machine')
$envLines = @(
  "# 恢复时需要重新设置的环境变量",
  "# 生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "",
  "## DEEPSEEK_API_KEY"
)
if ($apiKey) {
  if ($IncludeApiKey) {
    $envLines += "DEEPSEEK_API_KEY=$apiKey"
    $envLines += ""
    $envLines += "# ⚠ 本文件含明文密钥，用完请销毁，不要随备份包一起外传。"
    Say "      · API Key：已包含（前缀 $($apiKey.Substring(0,7))…）"
  } else {
    $envLines += "# 备份时系统里有这把 key（前缀 $($apiKey.Substring(0,7))…），但按安全默认**没有写进备份**。"
    $envLines += "# 恢复时请用你自己的记录重新设置，命令见 restore.ps1 输出。"
    Say "      · API Key：未包含（安全默认）"
  }
} else {
  $envLines += "# 备份时系统里没有设置 DEEPSEEK_API_KEY"
  Say "      ⚠ 机器级 DEEPSEEK_API_KEY 未设置"
}
[System.IO.File]::WriteAllLines((Join-Path $machineDir 'api-key.txt'), $envLines, (New-Object System.Text.UTF8Encoding($false)))

# 1.4 依赖清单与版本
$deps = @(
  @{ n='Node.js';     p='C:\Program Files\nodejs\node.exe';                                     a='--version'; must=$true },
  @{ n='LibreOffice'; p='C:\Program Files\LibreOffice\program\soffice.exe';                     a='--version'; must=$true },
  @{ n='MarkItDown';  p="$env:LOCALAPPDATA\Programs\Python\Python312\Scripts\markitdown.exe";   a='--version'; must=$true },
  @{ n='Pandoc';      p="$env:USERPROFILE\scoop\shims\pandoc.exe";                              a='--version'; must=$false },
  @{ n='Chrome';      p='C:\Program Files\Google\Chrome\Application\chrome.exe';                a='--version'; must=$false },
  @{ n='Edge';        p='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe';         a='--version'; must=$false }
)
$depLines = @('# 运行依赖清单', '', '| 组件 | 是否必需 | 路径 | 版本 |', '|---|---|---|---|')
foreach ($d in $deps) {
  # ⚠️ 不要用 `xxx.exe --version`：Chrome 会直接弹出浏览器窗口，soffice 的输出也拿不到。
  #    统一读文件版本信息，稳定且无副作用。
  $ver = '（未安装）'
  if (Test-Path $d.p) {
    try {
      $vi = (Get-Item $d.p).VersionInfo
      $ver = if ($vi.ProductVersion) { $vi.ProductVersion } elseif ($vi.FileVersion) { $vi.FileVersion } else { '（已安装）' }
    } catch { $ver = '（已安装）' }
  }
  $depLines += "| $($d.n) | $(if ($d.must) { '必需' } else { '可选' }) | ``$($d.p)`` | $ver |"
  Say ("      · {0,-12} {1}" -f $d.n, $ver)
}
$depLines += ''
$depLines += '> MarkItDown 安装：`pip install markitdown`'
$depLines += '> 若把依赖装在别的路径，恢复后需要改 `web\lib.mjs` 顶部的 MARKITDOWN / SOFFICE / PANDOC 常量。'
[System.IO.File]::WriteAllLines((Join-Path $machineDir 'prerequisites.md'), $depLines, (New-Object System.Text.UTF8Encoding($false)))

# 1.5 机器快照
$snap = [ordered]@{
  backupAt    = (Get-Date).ToString('o')
  version     = $Version
  hostname    = $env:COMPUTERNAME
  os          = (Get-CimInstance Win32_OperatingSystem).Caption
  psVersion   = $PSVersionTable.PSVersion.ToString()
  sourcePath  = $AppRoot
  scheduledTasks = $taskNames
  drives      = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    @{ letter = $_.DeviceID; sizeGB = [math]::Round($_.Size/1GB,1); freeGB = [math]::Round($_.FreeSpace/1GB,1) }
  })
  physicalDisks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
    @{ model = $_.Model; sizeGB = [math]::Round($_.Size/1GB,0) }
  })
  netIPv4     = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                    Where-Object { $_.IPAddress -notlike '127.*' } | ForEach-Object { $_.IPAddress })
  accounts    = @(Get-LocalUser | Where-Object { $_.Enabled } | ForEach-Object { $_.Name })
  portListening = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
                    ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" })
}
[System.IO.File]::WriteAllText((Join-Path $machineDir 'machine-info.json'), ($snap | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

# ─────────── 2. 准备备份目录 ───────────
Say ''
Say '[2/5] 准备备份目录…'
$targets = @()
foreach ($root in $DestList) {
  try {
    $dir = Join-Path $root $BkName
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $targets += $dir
    Say "      → $dir"
  } catch {
    Say "      ✗ 无法创建 $root\$BkName ：$($_.Exception.Message)（跳过）"
  }
}
if (-not $targets) { throw '没有任何可写入的备份目标，已中止' }

$staging = $targets[0]     # 先在第一个目标上完整生成，再复制到其余目标

# ─────────── 3. 复制项目文件 ───────────
Say ''
Say '[3/5] 复制项目文件…'

$appDest = Join-Path $staging 'app'
New-Item -ItemType Directory -Force -Path $appDest | Out-Null

# 排除规则：临时文件、系统垃圾、以及 -Light 模式下的重体积产物
$excludeDirs  = @('node_modules', '$RECYCLE.BIN', '.git')
$excludeExt   = @('.tmp', '.bak', '.swp')
$lightExt     = @('.doc', '.docx', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg')

$files = Get-ChildItem $AppRoot -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
  $rel = $_.FullName.Substring($AppRoot.Length).TrimStart('\')
  $parts = $rel -split '\\'
  if ($parts | Where-Object { $excludeDirs -contains $_ }) { return $false }
  if ($excludeExt -contains $_.Extension.ToLower()) { return $false }
  # -Light：任务留档里只留元数据与成果文本，不搬原件和大文件
  if ($Light -and $rel -like 'web\data\tasks\*' -and ($lightExt -contains $_.Extension.ToLower())) { return $false }
  return $true
}

$copied = 0; $bytes = 0
foreach ($f in $files) {
  $rel = $f.FullName.Substring($AppRoot.Length).TrimStart('\')
  $out = Join-Path $appDest $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null
  Copy-Item $f.FullName $out -Force
  $copied++; $bytes += $f.Length
}
Say ("      · 已复制 {0:N0} 个文件，{1:N1} MB" -f $copied, ($bytes/1MB))
if ($Light) { Say '      · 精简模式：任务留档里的原件与 PDF 未打包' }

# 机器信息
$machineDest = Join-Path $staging 'machine'
Copy-Item $machineDir $machineDest -Recurse -Force

# ─────────── 4. 写清单与恢复说明 ───────────
Say ''
Say '[4/5] 生成清单与恢复说明…'

$manifest = [ordered]@{
  system      = '工程咨询成果审核工作台'
  version     = $Version
  backupAt    = (Get-Date).ToString('o')
  hostname    = $env:COMPUTERNAME
  sourcePath  = $AppRoot
  light       = [bool]$Light
  apiKeyIncluded = [bool]$IncludeApiKey
  fileCount   = 0
  totalBytes  = 0
  files       = @()
}
$allFiles = Get-ChildItem $staging -Recurse -File -Force | Where-Object { $_.Name -ne 'manifest.json' }
foreach ($f in $allFiles) {
  $rel = $f.FullName.Substring($staging.Length).TrimStart('\')
  $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
  $manifest.files += @{ path = $rel; size = $f.Length; sha256 = $h }
  $manifest.fileCount++
  $manifest.totalBytes += $f.Length
}
# 用无 BOM 写入：带 BOM 的 JSON 会让 Node 的 JSON.parse、jq 等直接报错（踩过）
[System.IO.File]::WriteAllText((Join-Path $staging 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Say ("      · 已登记 {0:N0} 个文件的 SHA256，共 {1:N1} MB" -f $manifest.fileCount, ($manifest.totalBytes/1MB))

# 恢复脚本与说明随包携带
Copy-Item (Join-Path $OpsDir 'restore.ps1') (Join-Path $staging 'restore.ps1') -Force
Copy-Item (Join-Path $OpsDir 'README-恢复说明.md') (Join-Path $staging 'README-恢复说明.md') -Force

# ─────────── 5. 复制到其余目标 / 压缩 ───────────
Say ''
Say '[5/5] 分发到其它目标盘…'
for ($i = 1; $i -lt $targets.Count; $i++) {
  $t = $targets[$i]
  try {
    Copy-Item (Join-Path $staging '*') $t -Recurse -Force
    Say "      → $t"
  } catch { Say "      ✗ 复制到 $t 失败：$($_.Exception.Message)" }
}

if (-not $NoZip) {
  Say ''
  Say '压缩打包…'
  foreach ($t in $targets) {
    $zip = "$t.zip"
    try {
      if (Test-Path $zip) { Remove-Item $zip -Force }
      Compress-Archive -Path (Join-Path $t '*') -DestinationPath $zip -CompressionLevel Optimal
      $zmb = [math]::Round((Get-Item $zip).Length/1MB, 1)
      Say "      → $zip  ($zmb MB)"
    } catch { Say "      ✗ 压缩失败：$($_.Exception.Message)" }
  }
}

Remove-Item $machineDir -Recurse -Force -ErrorAction SilentlyContinue

# ─────────── 6. 轮转：每个目标盘只留最近 N 份 ───────────
# 定时备份必须做这一步，否则移动盘会被一份份 112MB 慢慢塞满。
if ($Keep -gt 0) {
  Say ''
  Say "轮转：每个目标盘只保留最近 $Keep 份…"
  foreach ($root in $DestList) {
    $made = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like '审核工作台_v*' } | Sort-Object Name -Descending
    $drop = @($made | Select-Object -Skip $Keep)
    foreach ($d in $drop) {
      Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item "$($d.FullName).zip" -Force -ErrorAction SilentlyContinue
      Say "      − 删除旧备份 $($d.Name)"
    }
    Say "      · $root 保留 $(@($made | Select-Object -First $Keep).Count) 份"
  }
}

# ─────────── 7. 记一行历史（定时任务跑完可回溯）───────────
$histLine = "{0}  v{1}  {2}  文件 {3}  体积 {4:N1}MB  目标 {5}  {6}" -f `
  (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Version, $BkName, $manifest.fileCount, ($manifest.totalBytes / 1MB),
  ($targets -join ' '), $(if ($Light) { '精简' } else { '完整' })
try {
  Add-Content -Path (Join-Path $OpsDir 'backup-history.log') -Value $histLine -Encoding UTF8
} catch { }

Say ''
Say '═══════════════════════════════════════════════════'
Say '  备份完成'
foreach ($t in $targets) { Say "    $t" }
Say "  历史记录：$OpsDir\backup-history.log"
Say ''
Say '  ⚠ 备份包含账号密码哈希与全部审核报告，属敏感数据，'
Say '    请勿上传公共网盘或发到群里。建议至少两块盘各放一份。'
Say '═══════════════════════════════════════════════════'
