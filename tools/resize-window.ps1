param([int] $W = 1680, [int] $H = 1000)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32Move {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
'@
$p = Get-Process dsh-xiumi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw 'main window not found' }
[Win32Move]::MoveWindow($p.MainWindowHandle, 0, 0, $W, $H, $true) | Out-Null
Start-Sleep -Milliseconds 1500
Write-Output ("resized -> " + $W + "x" + $H)
