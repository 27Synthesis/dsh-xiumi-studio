<#
.SYNOPSIS
  给秀米工作台装桌面快捷方式和开始菜单快捷方式（不需要管理员权限）。

.DESCRIPTION
  只动两处：当前用户的桌面、当前用户的开始菜单 → 程序。
  快捷方式指向 desktop\dist\秀米工作台.exe（自带图标，双击即开，--no-sandbox 已经封在启动器里）。
  可以重复执行：已存在的直接覆盖，不会多出一个。

.PARAMETER DistDir
  打包目录。默认是仓库里的 desktop\dist。

.PARAMETER NoDesktop
  跳过桌面快捷方式。

.PARAMETER NoStartMenu
  跳过开始菜单快捷方式。

.PARAMETER Launch
  装完立刻启动一次（用来验证真的能开）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\install-shortcuts.ps1
#>
[CmdletBinding()]
param(
  # $PSScriptRoot 在参数默认值里不一定是好的（-File 调用时可能为空），下面再补
  [string] $DistDir = '',
  [switch] $NoDesktop,
  [switch] $NoStartMenu,
  [switch] $Launch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AppName = '秀米工作台'
$ShortcutDesc = '秀米图文台 · 桌面版（双击打开工作台）'

function Fail($message) {
  Write-Host ''
  Write-Host "✗ 安装失败：$message" -ForegroundColor Red
  exit 1
}

try {
  # 从 .cmd 里传进来时可能是 "C:\path\dir\" 这种带尾反斜杠的形式：
  # 引号会被反斜杠吃掉，PowerShell 收到的就成了一个带引号的怪路径（GetFullPath 报 Illegal characters）。
  # 这里统一把引号和尾部分隔符去掉，谁也传不错。
  if ($DistDir) { $DistDir = $DistDir.Trim().Trim('"').TrimEnd('\', '/') }
  if (-not $DistDir) {
    $root = if ($PSScriptRoot) { $PSScriptRoot } else { (Join-Path (Get-Location) 'tools') }
    $repoDist = Join-Path $root '..\desktop\dist'
    # 发行包解开以后，脚本就躺在程序旁边（没有 desktop\dist 这一层）
    if (Test-Path -LiteralPath (Join-Path $repoDist "$AppName.exe")) { $DistDir = $repoDist }
    elseif (Test-Path -LiteralPath (Join-Path $root "$AppName.exe")) { $DistDir = $root }
    else { $DistDir = $repoDist }
  }
  $dist = [System.IO.Path]::GetFullPath($DistDir)
  if (-not (Test-Path -LiteralPath $dist -PathType Container)) {
    Fail "找不到打包目录 $dist。先在仓库根目录跑：node tools\build-desktop.mjs"
  }

  $exe = Join-Path $dist "$AppName.exe"
  $cmd = Join-Path $dist '备用启动.cmd'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    if (Test-Path -LiteralPath $cmd -PathType Leaf) {
      Write-Host "! 没有 $AppName.exe，退回用 备用启动.cmd（说明本机没有 .NET Framework，图标会由快捷方式指定）" -ForegroundColor Yellow
      $exe = $cmd
      $icon = Join-Path $dist 'icon.ico'
      if (-not (Test-Path -LiteralPath $icon)) { $icon = $null }
    } else {
      Fail "打包目录里既没有 $AppName.exe 也没有 备用启动.cmd：$dist"
    }
  }
  if (-not $icon) { $icon = "$exe,0" }

  $desktopDir = [Environment]::GetFolderPath('Desktop')
  $startMenu  = [Environment]::GetFolderPath('Programs')
  if ($NoDesktop -and $NoStartMenu) { Fail '你同时跳过了桌面和开始菜单，那就没东西可装了' }

  $targets = @()
  if (-not $NoDesktop)   { $targets += @{ Kind = '桌面';     Path = (Join-Path $desktopDir "$AppName.lnk") } }
  if (-not $NoStartMenu) { $targets += @{ Kind = '开始菜单'; Path = (Join-Path $startMenu  "$AppName.lnk") } }

  Write-Host "程序：$exe"
  Write-Host ""

  $shell = New-Object -ComObject WScript.Shell
  foreach ($t in $targets) {
    $dir = Split-Path -Parent $t.Path
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $sc = $shell.CreateShortcut($t.Path)
    $sc.TargetPath = $exe
    $sc.WorkingDirectory = $dist
    $sc.IconLocation = $icon
    $sc.Description = $ShortcutDesc
    $sc.WindowStyle = 1
    $sc.Save()

    # 立刻读回来核对，别只信 Save() 没报错
    $check = $shell.CreateShortcut($t.Path)
    if (-not (Test-Path -LiteralPath $t.Path)) { Fail "$($t.Kind)快捷方式没写出来：$($t.Path)" }
    if ($check.TargetPath -ne $exe) { Fail "$($t.Kind)快捷方式指向不对：$($check.TargetPath)" }
    Write-Host "✓ $($t.Kind)：$($t.Path)" -ForegroundColor Green
  }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

  # 让开始菜单的搜索索引尽快认得它（不报错才算数，失败也不影响快捷方式本身）
  if (-not $NoStartMenu) {
    try {
      $sig = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
      $sh = Add-Type -MemberDefinition $sig -Name 'ShellNotify' -Namespace 'Xiumi' -PassThru
      $sh::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
    } catch { Write-Host "（通知资源管理器刷新失败，可以让它自己刷新）" -ForegroundColor DarkGray }
  }

  Write-Host ''
  Write-Host "装好了。桌面上双击「$AppName」，或者开始菜单里搜「秀米」。"
  Write-Host "卸载：powershell -ExecutionPolicy Bypass -File tools\uninstall-shortcuts.ps1"

  if ($Launch) {
    Write-Host ''
    Write-Host '启动一次做验证…'
    Start-Process -FilePath $exe -WorkingDirectory $dist | Out-Null
    Write-Host '（已拉起进程，窗口稍等就会出来）'
  }
  exit 0
}
catch {
  Fail $_.Exception.Message
}
