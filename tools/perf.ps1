# perf.ps1 —— 统计本项目相关进程的资源占用（内存 / CPU / 句柄）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\perf.ps1
$ErrorActionPreference = 'SilentlyContinue'

$procs = Get-CimInstance Win32_Process

# 1) 宿主
$hostProc = $procs | Where-Object { $_.Name -eq 'RemindersWidget.exe' } | Select-Object -First 1

# 2) 宿主的子孙进程（WebView2 那一串）
$tree = @()
if ($hostProc) {
  $seen = @{}
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($hostProc.ProcessId)
  $seen[$hostProc.ProcessId] = $true
  while ($queue.Count -gt 0) {
    $pid0 = $queue.Dequeue()
    $tree += $pid0
    foreach ($c in $procs | Where-Object { $_.ParentProcessId -eq $pid0 }) {
      if (-not $seen.ContainsKey($c.ProcessId)) { $seen[$c.ProcessId] = $true; $queue.Enqueue($c.ProcessId) }
    }
  }
}

# 3) 本地同步服务（命令行里带本项目 server.js 的 node）
$svc = $procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*ios-reminders-widget\server.js*' }

$rows = @()
foreach ($p in $procs) {
  if ($tree -contains $p.ProcessId -or ($svc -and $svc.ProcessId -contains $p.ProcessId)) {
    $gp = Get-Process -Id $p.ProcessId
    $tag = '其他'
    if ($p.Name -eq 'RemindersWidget.exe') { $tag = '宿主' }
    elseif ($p.Name -eq 'node.exe') { $tag = '本地服务' }
    elseif ($p.CommandLine -match '--type=renderer') { $tag = 'WebView2-渲染' }
    elseif ($p.CommandLine -match '--type=gpu-process') { $tag = 'WebView2-GPU' }
    elseif ($p.CommandLine -match '--type=utility') { $tag = 'WebView2-工具' }
    elseif ($p.CommandLine -match 'crashpad') { $tag = 'WebView2-崩溃上报' }
    elseif ($p.Name -eq 'msedgewebview2.exe') { $tag = 'WebView2-浏览器' }
    $rows += [PSCustomObject]@{
      角色 = $tag
      PID = $p.ProcessId
      内存MB = [math]::Round($p.WorkingSetSize / 1MB, 1)
      私有MB = [math]::Round($p.PrivatePageCount / 1MB, 1)
      CPU秒 = if ($gp) { [math]::Round($gp.CPU, 1) } else { 0 }
      句柄 = if ($gp) { $gp.HandleCount } else { 0 }
      线程 = if ($gp) { $gp.Threads.Count } else { 0 }
    }
  }
}

$rows | Sort-Object 角色, PID | Format-Table -AutoSize
""
"合计: {0} 个进程 | 工作集 {1} MB | 私有 {2} MB | 句柄 {3}" -f `
  $rows.Count, `
  [math]::Round(($rows | Measure-Object 内存MB -Sum).Sum, 1), `
  [math]::Round(($rows | Measure-Object 私有MB -Sum).Sum, 1), `
  ($rows | Measure-Object 句柄 -Sum).Sum
