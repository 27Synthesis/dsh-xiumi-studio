<#
.SYNOPSIS
  卸载秀米工作台的桌面/开始菜单快捷方式。

.DESCRIPTION
  只删本脚本装的那两个 .lnk（名字对得上才删），程序目录和作品文件一概不动。
  可以重复执行：已经没有的话就说一句「本来就没有」，不算失败。

.PARAMETER RemoveData
  连应用数据一起删（%LOCALAPPDATA%\dsh-xiumi-desktop：配置、日志、缓存）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\uninstall-shortcuts.ps1
#>
[CmdletBinding()]
param(
  [switch] $RemoveData
)

$ErrorActionPreference = 'Stop'
$AppName = '秀米工作台'

function Fail($message) {
  Write-Host ''
  Write-Host "✗ 卸载失败：$message" -ForegroundColor Red
  exit 1
}

try {
  $targets = @(
    @{ Kind = '桌面';     Path = (Join-Path ([Environment]::GetFolderPath('Desktop'))  "$AppName.lnk") },
    @{ Kind = '开始菜单'; Path = (Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk") }
  )
  $removed = 0
  foreach ($t in $targets) {
    if (Test-Path -LiteralPath $t.Path) {
      Remove-Item -LiteralPath $t.Path -Force
      Write-Host "✓ 已删除$($t.Kind)快捷方式：$($t.Path)" -ForegroundColor Green
      $removed++
    } else {
      Write-Host "- $($t.Kind)本来就没有：$($t.Path)" -ForegroundColor DarkGray
    }
  }

  if ($RemoveData) {
    $data = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'dsh-xiumi-desktop'
    if (Test-Path -LiteralPath $data) {
      Remove-Item -LiteralPath $data -Recurse -Force
      Write-Host "✓ 已删除应用数据：$data" -ForegroundColor Green
    } else {
      Write-Host "- 应用数据本来就没有：$data" -ForegroundColor DarkGray
    }
  } else {
    Write-Host '（应用数据保留在 %LOCALAPPDATA%\dsh-xiumi-desktop；要一起删加 -RemoveData）' -ForegroundColor DarkGray
  }

  if ($removed -eq 0) { Write-Host '没有要删的东西。' }
  exit 0
}
catch {
  Fail $_.Exception.Message
}
