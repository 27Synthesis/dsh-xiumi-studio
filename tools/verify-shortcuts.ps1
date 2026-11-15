$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$desk = [Environment]::GetFolderPath('Desktop')
$menu = [Environment]::GetFolderPath('Programs')
foreach ($p in @(@{k='桌面'; d=$desk}, @{k='开始菜单'; d=$menu})) {
  Write-Output "=== $($p.k)：$($p.d)"
  $items = Get-ChildItem -LiteralPath $p.d -Filter '*秀米*' -Force -ErrorAction SilentlyContinue
  if (-not $items) { Write-Output '  (没有找到)' }
  foreach ($i in $items) {
    Write-Output ("  {0}  {1} bytes  {2}" -f $i.Name, $i.Length, $i.LastWriteTime)
    if ($i.Extension -eq '.lnk') {
      $sc = $shell.CreateShortcut($i.FullName)
      Write-Output "    TargetPath    : $($sc.TargetPath)"
      Write-Output "    Arguments     : '$($sc.Arguments)'"
      Write-Output "    WorkingDir    : $($sc.WorkingDirectory)"
      Write-Output "    IconLocation  : $($sc.IconLocation)"
      Write-Output "    Description   : $($sc.Description)"
      Write-Output "    TargetExists  : $(Test-Path -LiteralPath $sc.TargetPath)"
    }
  }
}
Write-Output '=== 进程：'
$procs = Get-Process -Name 'dsh-xiumi','秀米工作台' -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output '  (没有在跑的实例)' } else { $procs | ForEach-Object { Write-Output ("  {0} PID={1} 启动于 {2}" -f $_.ProcessName, $_.Id, $_.StartTime) } }
