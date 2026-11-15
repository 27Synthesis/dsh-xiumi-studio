<#
.SYNOPSIS
  把「秀米工作台」的窗口抓成 PNG（不依赖前台、不需要桌面可见）。

.DESCRIPTION
  PrintWindow(hwnd, PW_RENDERFULLCONTENT) —— 窗口被别的窗口挡住也能拿到它自己的画面，
  比整屏截图干净，也不会把别的东西拍进去。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\shot-window.ps1 -Out _inspect\shots\window.png
#>
param(
  [string] $Out = 'window.png',
  [string] $Name = 'dsh-xiumi'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
# 启动器进程名是「秀米工作台」，Electron 本体是 dsh-xiumi；两个都找，只要带窗口的
$p = Get-Process -Name $Name, '秀米工作台' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $p) { Write-Output 'NO_WINDOW'; exit 2 }
$h = $p.MainWindowHandle
$r = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Output 'BAD_RECT'; exit 3 }
Write-Output ("窗口：" + $p.ProcessName + " " + $w + "x" + $ht + " 「" + $p.MainWindowTitle + "」")
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [W]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$dir = Split-Path -Parent ([System.IO.Path]::GetFullPath($Out))
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save([System.IO.Path]::GetFullPath($Out), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("PRINTWINDOW=" + $ok + " -> " + [System.IO.Path]::GetFullPath($Out))
