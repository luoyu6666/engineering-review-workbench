<#
  无线网卡 IP 设置（给不熟悉电脑的使用方；由同名 .bat 提权后调用）

  为什么做成 .ps1 而不是全写在 .bat 里：cmd 对括号、引号与中文的解析容易出错
  （经实测：提示语里一个半角括号就报"命令语法不正确"），而 .ps1 没有这些问题。

  用法（由 .bat 调用）：
    powershell -NoProfile -ExecutionPolicy Bypass -File 网络IP设置.ps1 -Fix     # 固定当前 IP
    powershell -NoProfile -ExecutionPolicy Bypass -File 网络IP设置.ps1 -Auto    # 改回自动获取
#>
param([switch]$Fix, [switch]$Auto, [switch]$Check)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding

function Line { param([string]$t = '') Write-Host $t }
function Title { param([string]$t)
  Line ('=' * 64); Line ('   ' + $t); Line ('=' * 64); Line
}

# ── 找到正在使用的无线网卡 ──
function Get-WifiAdapter {
  $list = Get-NetAdapter | Where-Object {
    $_.Status -eq 'Up' -and ($_.PhysicalMediaType -match '802\.11' -or $_.Name -match 'WLAN|无线|Wi-Fi|WIFI')
  }
  return ($list | Select-Object -First 1)
}

# ── 把前缀长度换算成子网掩码（用 Int64 计算：32 位有符号整数在 /24 会溢出成负数）──
function Convert-PrefixToMask {
  param([int]$Prefix)
  $m = [int64]0
  for ($k = 0; $k -lt $Prefix; $k++) { $m = $m -bor ([int64]1 -shl (31 - $k)) }
  $b = [BitConverter]::GetBytes($m)
  return "$($b[3]).$($b[2]).$($b[1]).$($b[0])"
}

# ── 读取当前参数 ──
function Get-CurrentConfig {
  param([string]$Alias)
  $c = Get-NetIPConfiguration -InterfaceAlias $Alias
  $ip = $c.IPv4Address
  $gw = ($c.IPv4DefaultGateway | Select-Object -First 1).NextHop
  $dns = @(($c.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | Select-Object -First 1).ServerAddresses)
  return [pscustomobject]@{
    IP = $ip.IPAddress; Prefix = [int]$ip.PrefixLength; Mask = (Convert-PrefixToMask -Prefix ([int]$ip.PrefixLength))
    Gateway = $gw; Dns1 = $dns[0]; Dns2 = $dns[1]
  }
}

# ── 主流程 ──
if ($Fix) {
  Title '把无线网卡改成"固定 IP"（以后开机关机 IP 都不变）'
  $ad = Get-WifiAdapter
  if (-not $ad) {
    Line '[没找到] 这台电脑现在没有连着无线网。'
    Line '         请先连上单位的无线网络，再双击"设置固定IP.bat"。'
    Line '         用网线上网的台式机不需要做这件事。'
    Line; Read-Host '看完请按回车关闭'; exit 1
  }
  Line ("正在使用的无线网卡：" + $ad.Name); Line
  $cf = Get-CurrentConfig -Alias $ad.Name
  if (-not $cf.IP) {
    Line '[没读到] 没能读到当前网络的 IP 参数，可能是网卡还没拿到地址。'
    Line '         请确认能上网后重试。'; Line; Read-Host '看完请按回车关闭'; exit 1
  }
  Line '当前自动获取到的参数（将被固定成下面这些值）：'
  Line ("    IP 地址 ：" + $cf.IP)
  Line ("    子网掩码：" + $cf.Mask)
  Line ("    网    关：" + $cf.Gateway)
  Line ("    DNS     ：" + $cf.Dns1 + '  ' + $cf.Dns2)
  Line
  Line '提示：固定后请把上面这个 IP 地址报给管理员，登记一次白名单即可，以后不用再报。'
  Line
  $ok = Read-Host '确认要固定成上面的设置吗？输入 Y 再回车（其它键取消）'
  if ($ok -notmatch '^[Yy]$') { Line '已取消，未做任何修改。'; Line; Read-Host '看完请按回车关闭'; exit 0 }

  netsh interface ip set address name="$($ad.Name)" source=static addr=$($cf.IP) mask=$($cf.Mask) gateway=$($cf.Gateway) gwmetric=1 | Out-Null
  if ($cf.Dns1) { netsh interface ip set dns name="$($ad.Name)" source=static addr=$($cf.Dns1) register=primary | Out-Null }
  if ($cf.Dns2) { netsh interface ip add dns name="$($ad.Name)" addr=$($cf.Dns2) index=2 | Out-Null }
  Start-Sleep -Seconds 2

  Line; Line '── 结果 ──'
  $now = Get-NetIPAddress -InterfaceAlias $ad.Name -AddressFamily IPv4 | Select-Object -First 1
  Line ("当前 IP：" + $now.IPAddress)
  if ($now.IPAddress -eq $cf.IP) {
    Line '设置成功：今后开机关机，这个 IP 都不会再变。'
    Line ("请把 IP 地址 " + $cf.IP + ' 发给管理员登记（只需报一次）。')
  } else {
    Line '注意：设置后读到的 IP 与预期不一致，请把本窗口截图发给管理员。'
  }
  Line; Line '出差或在家上网前，请双击"改回自动获取IP.bat"，否则上不了网。'
  Line; Read-Host '看完请按回车关闭'
  exit 0
}

if ($Auto) {
  Title '把无线网卡改回"自动获取 IP"（出差、回家上网用）'
  $ad = Get-WifiAdapter
  if (-not $ad) {
    Line '[没找到] 这台电脑现在没有连着无线网。'
    Line '         先连上任意无线网络（手机热点也可以），再双击"改回自动获取IP.bat"。'
    Line; Read-Host '看完请按回车关闭'; exit 1
  }
  Line ("正在使用的无线网卡：" + $ad.Name); Line
  $ok = Read-Host '确认改回"自动获取 IP"吗？输入 Y 再回车（其它键取消）'
  if ($ok -notmatch '^[Yy]$') { Line '已取消，未做任何修改。'; Line; Read-Host '看完请按回车关闭'; exit 0 }

  netsh interface ip set address name="$($ad.Name)" source=dhcp | Out-Null
  netsh interface ip set dns name="$($ad.Name)" source=dhcp | Out-Null
  ipconfig /renew "$($ad.Name)" | Out-Null
  Start-Sleep -Seconds 3

  Line; Line '── 结果 ──'
  $cfg = Get-NetIPConfiguration -InterfaceAlias $ad.Name
  Line ('当前 IP：' + $cfg.IPv4Address.IPAddress)
  Line '已改回自动获取：出差/在家都能正常上网了。'
  Line '回到单位后再运行"设置固定IP.bat"，把 IP 固定一次即可。'
  Line; Read-Host '看完请按回车关闭'
  exit 0
}

if ($Check) {
  $ad = Get-WifiAdapter
  if (-not $ad) { Line '没有连着无线网。'; exit 1 }
  $cf = Get-CurrentConfig -Alias $ad.Name
  Line ("无线网卡：" + $ad.Name)
  Line ("IP：" + $cf.IP + "  掩码：" + $cf.Mask + "  网关：" + $cf.Gateway + "  DNS：" + $cf.Dns1 + ' ' + $cf.Dns2)
  exit 0
}

Line '请用同目录下的 .bat 运行（设置固定IP.bat / 改回自动获取IP.bat）。'
Read-Host '看完请按回车关闭'
