param([switch]$BackgroundOnly)
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$panelUrl='http://127.0.0.1:7692'
$stateDir=Join-Path $root 'state\operator'
New-Item -ItemType Directory -Path $stateDir -Force|Out-Null
function IsReady {
  try {$r=Invoke-RestMethod -Uri ($panelUrl+'/api/ping') -TimeoutSec 2; return $r.service -eq 'spike-bridge-operator'}catch{return $false}
}
function Get-PanelListenerPid {
  $listener=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 7692 -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1
  if($listener){return [int]$listener.OwningProcess}
  return $null
}
function Stop-StaleOwnedPanel {
  $listenerPid=Get-PanelListenerPid
  if(-not $listenerPid){return}
  $receiptPath=Join-Path $stateDir 'panel-access.json'
  if(-not (Test-Path -LiteralPath $receiptPath)){throw "7692 已被 PID $listenerPid 占用，但没有控制台身份记录；拒绝终止未知进程。"}
  $receipt=Get-Content -Raw -LiteralPath $receiptPath|ConvertFrom-Json
  if([int]$receipt.pid -ne $listenerPid -or [int]$receipt.port -ne 7692 -or [string]$receipt.service -ne 'spike-bridge-operator'){
    throw "7692 已被 PID $listenerPid 占用，但与控制台身份记录不一致；拒绝终止未知进程。"
  }
  $process=Get-Process -Id $listenerPid -ErrorAction Stop
  $expectedNode=(Get-Command node.exe -ErrorAction Stop).Source
  if($process.ProcessName -ne 'node' -or [IO.Path]::GetFullPath($process.Path) -ne [IO.Path]::GetFullPath($expectedNode)){
    throw "7692 的 PID $listenerPid 不是已登记的 Operator Node；拒绝终止。"
  }
  try{
    $receiptStarted=[DateTimeOffset]::Parse([string]$receipt.startedAt)
    $processStarted=[DateTimeOffset]::new($process.StartTime.ToUniversalTime())
    if([Math]::Abs(($receiptStarted-$processStarted).TotalSeconds) -gt 30){throw 'start-time-mismatch'}
  }catch{
    throw "7692 的 PID $listenerPid 与控制台启动时间不一致；拒绝终止。"
  }
  Stop-Process -Id $listenerPid -Force -ErrorAction Stop
  $deadline=(Get-Date).AddSeconds(8)
  while(Get-PanelListenerPid){
    if((Get-Date)-gt $deadline){throw "旧 Operator PID $listenerPid 未释放 7692。"}
    Start-Sleep -Milliseconds 250
  }
}
$mutex=New-Object System.Threading.Mutex($false,'Local\SpikeBridgeOperatorLauncher')
$owned=$false
try{
  $owned=$mutex.WaitOne(10000,$false)
  if(-not $owned){throw '控制台正在启动，请稍后再次打开。'}
  $ready=IsReady
  if(-not $ready){
    for($i=0;$i -lt 3 -and -not $ready;$i++){Start-Sleep -Milliseconds 500;$ready=IsReady}
  }
  if(-not $ready){
    Stop-StaleOwnedPanel
    $node=(Get-Command node.exe -ErrorAction Stop).Source
    $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
    Start-Process -FilePath $node -ArgumentList @(('"'+(Join-Path $root 'operator\server.mjs')+'"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir ($stamp+'.stdout.log')) -RedirectStandardError (Join-Path $stateDir ($stamp+'.stderr.log'))|Out-Null
    $deadline=(Get-Date).AddSeconds(15)
    while(-not (IsReady)) {if((Get-Date)-gt $deadline){throw '控制台后台未能启动，请查看 state\operator 中的日志。'};Start-Sleep -Milliseconds 400}
  }
}finally{if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
if($BackgroundOnly){exit 0}
$receipt=Get-Content -Raw -LiteralPath (Join-Path $stateDir 'panel-access.json')|ConvertFrom-Json
if($receipt.token -notmatch '^[a-f0-9]{64}$' -or $receipt.port -ne 7692){throw '控制台窗口凭证无效。'}
$candidates=@((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),(Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'))
$edge=$candidates|Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
if(!$edge){throw '此窗口需要已安装的 Microsoft Edge。'}
$url=$panelUrl+'/#token='+$receipt.token
$profile=Join-Path $stateDir 'window-profile'
Start-Process -FilePath $edge -ArgumentList @('--app="'+$url+'"','--user-data-dir="'+$profile+'"','--no-first-run','--disable-session-crashed-bubble','--window-size=1440,940')|Out-Null
