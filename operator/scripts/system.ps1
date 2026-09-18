param(
  [Parameter(Mandatory=$true)][ValidateSet('inspect','channelStart','channelStop','channelRestart','startupEnable','startupDisable')][string]$Action,
  [ValidateSet('','a','b')][string]$Lane=''
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
function TaskName([string]$letter){ if($letter -eq 'a'){return 'SpikeBridge-Account-A'}; if($letter -eq 'b'){return 'SpikeBridge-Account-B'}; throw '没有指定连接通道。' }
function Snapshot([string]$name){
  $t=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if($null -eq $t){return @{exists=$null;name=$name;state='unavailable';queryStatus='failed'}}
  $i=Get-ScheduledTaskInfo -TaskName $name
  $ownerManageable=$false
  try {
    $service=New-Object -ComObject Schedule.Service
    $service.Connect()
    $sd=[Security.AccessControl.RawSecurityDescriptor]::new($service.GetFolder('\').GetTask($name).GetSecurityDescriptor(4))
    $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $ownerManageable=@($sd.DiscretionaryAcl|Where-Object {$_.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $_.SecurityIdentifier.Value -eq $currentSid -and ($_.AccessMask -band 0x1f01ff) -eq 0x1f01ff}).Count -gt 0
  } catch {}
  return @{exists=$true;name=$name;state=[string]$t.State;ownerManageable=$ownerManageable;lastResult=$i.LastTaskResult;lastRun=$i.LastRunTime.ToString('o');nextRun=$i.NextRunTime.ToString('o')}
}
function VerifiedRuntime([string]$letter){
  $ownerPath=Join-Path $root ('runtime\state\tunnel-client-'+$letter+'\task-owner.json')
  if(!(Test-Path -LiteralPath $ownerPath)){return $null}
  $o=Get-Content -Raw -LiteralPath $ownerPath|ConvertFrom-Json
  if(!$o.runtime_pid){return $null}
  $runtimePid=[int]$o.runtime_pid
  $r=Get-Process -Id $runtimePid -ErrorAction SilentlyContinue
  if($null -eq $r){return $null}
  $expected=[IO.Path]::GetFullPath((Join-Path $root 'tunnel\tunnel-client.exe'))
  $actual=if($r.Path){[IO.Path]::GetFullPath($r.Path)}else{$null}
  if($r.ProcessName -ne 'tunnel-client'){throw '通道进程身份不一致，已拒绝结束进程。'}
  if($actual -and $actual -ne $expected){throw '通道进程路径不一致，已拒绝结束进程。'}
  try{
    $receiptAt=[DateTimeOffset]::Parse([string]$o.timestamp)
    $startedAt=[DateTimeOffset]::new($r.StartTime.ToUniversalTime())
    if($startedAt -gt $receiptAt){throw 'pid-reused'}
  }catch{
    throw '通道进程启动时间与 owner receipt 不一致，已拒绝结束进程。'
  }
  return [pscustomobject]@{ProcessId=$runtimePid;StartTime=$r.StartTime;Path=$r.Path}
}
try {
  switch($Action){
    'inspect' {
      $bridgeProcess=$null
      try {
        $health=Invoke-RestMethod -Uri 'http://127.0.0.1:7690/healthz' -TimeoutSec 3
        $proc=Get-Process -Id ([int]$health.pid) -ErrorAction Stop
        $receiptPath=Join-Path $root 'state\bridge\bridge-7690.pid.json'
        $receipt=if(Test-Path -LiteralPath $receiptPath){Get-Content -Raw -LiteralPath $receiptPath|ConvertFrom-Json}else{$null}
        $expectedNode=(Get-Command node.exe -ErrorAction Stop).Source
        $owned=$null -ne $receipt -and [int]$receipt.pid -eq [int]$health.pid -and [string]$receipt.artifactDigest -eq [string]$health.artifactDigest -and $proc.ProcessName -eq 'node' -and [IO.Path]::GetFullPath($proc.Path) -eq [IO.Path]::GetFullPath($expectedNode)
        $bridgeProcess=@{pid=[int]$health.pid;startedAt=$proc.StartTime.ToUniversalTime().ToString('o');owned=$owned}
      } catch {}
      $uptimeMs=[Environment]::TickCount64
      # Windows PowerShell 5.1 lacks Environment.TickCount64; a null value
      # otherwise reports the current time as the last Windows boot time.
      if($null -eq $uptimeMs){
        if(-not ('SpikeBridgeBootClock' -as [type])){
          Add-Type 'using System.Runtime.InteropServices; public static class SpikeBridgeBootClock { [DllImport("kernel32.dll")] public static extern ulong GetTickCount64(); }'
        }
        $uptimeMs=[SpikeBridgeBootClock]::GetTickCount64()
      }
      $bootTime=(Get-Date).ToUniversalTime().AddMilliseconds(-[double]$uptimeMs).ToString('o')
      @{result='PASS';tasks=@{a=(Snapshot 'SpikeBridge-Account-A');b=(Snapshot 'SpikeBridge-Account-B');panel=(Snapshot 'SpikeBridge-Operator')};bridgeProcess=$bridgeProcess;bootTime=$bootTime}|ConvertTo-Json -Depth 8 -Compress
      exit 0
    }
    'startupEnable' {
      $node=(Get-Command node.exe -ErrorAction Stop).Source
      $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      $ps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $taskAction=New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'Run-PanelOwner.ps1')+'"') -WorkingDirectory $root
      $triggers=@((New-ScheduledTaskTrigger -AtLogOn -User $user),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)))
      $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
      Register-ScheduledTask -TaskName 'SpikeBridge-Operator' -Action $taskAction -Trigger $triggers -Principal $principal -Settings $settings -Description 'Bridge 后台：本机任务、Token、规则、Memory、通道与安全恢复；关闭窗口不停止服务。' -Force|Out-Null
      & (Join-Path $root 'scripts\admin\SET-BRIDGE-TASK-OWNER-ACCESS.ps1') -TaskNames 'SpikeBridge-Operator' | Out-Null
      @{result='PASS';message='控制台后台已启用登录自启与每分钟存活检查。'}|ConvertTo-Json -Compress
      exit 0
    }
    'startupDisable' {
      Disable-ScheduledTask -TaskName 'SpikeBridge-Operator'|Out-Null
      @{result='PASS';message='已关闭后续登录自启，当前后台继续运行。'}|ConvertTo-Json -Compress
      exit 0
    }
  }
  $name=TaskName $Lane
  if($Action -eq 'channelStart'){
    Enable-ScheduledTask -TaskName $name|Out-Null
    Start-ScheduledTask -TaskName $name
    @{result='PASS';message='已请求启动通道，连接状态会自动刷新。'}|ConvertTo-Json -Compress
    exit 0
  }
  # Stop the scheduler owner first; the existing runtime is stopped only after exact identity verification.
  $r=VerifiedRuntime $Lane
  Disable-ScheduledTask -TaskName $name|Out-Null
  Stop-ScheduledTask -TaskName $name
  Start-Sleep -Milliseconds 400
  $r=VerifiedRuntime $Lane
  if($null -ne $r){Stop-Process -Id ([int]$r.ProcessId) -Force -ErrorAction Stop}
  if($Action -eq 'channelRestart'){
    Enable-ScheduledTask -TaskName $name|Out-Null
    Start-ScheduledTask -TaskName $name
    @{result='PASS';message='已请求重新连接所选通道，另一条通道未变动。'}|ConvertTo-Json -Compress
  }else{
    @{result='PASS';message='所选通道已停用，重新启用前不会被定时任务拉起。'}|ConvertTo-Json -Compress
  }
} catch {
  @{result='FAIL';error=$_.Exception.Message}|ConvertTo-Json -Compress
  exit 1
}
