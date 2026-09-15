param([int]$Port = 8766,[string]$LanIp = '',[int]$MacPort = 8767,[string]$StateDir = '')
if ($StateDir) { $resolvedState = Resolve-Path -LiteralPath $StateDir -ErrorAction SilentlyContinue; $env:SPIKE_WORKER_B_STATE_DIR = if ($resolvedState) { $resolvedState.Path } else { [IO.Path]::GetFullPath($StateDir) } }
. (Join-Path $PSScriptRoot 'common.ps1')
$script:MacWorkerBPort = $Port
$env:SPIKE_WORKER_B_PORT = [string]$Port
$env:SPIKE_WORKER_B_LAN_IP = $LanIp
$env:SPIKE_WORKER_B_MAC_PORT = [string]$MacPort
$env:SPIKE_WORKER_B_STATE_DIR = $script:MacWorkerBState
New-Item -ItemType Directory -Force -Path $script:MacWorkerBState | Out-Null
Stop-MacWorkerBOwnedBridge
Remove-Item -LiteralPath $script:MacWorkerBOut,$script:MacWorkerBErr -Force -ErrorAction SilentlyContinue
$node = (Get-Command node -ErrorAction Stop).Source
$bridge = (Resolve-Path (Join-Path $PSScriptRoot 'bridge.mjs')).Path
$tag = Get-Date -Format 'yyyyMMdd-HHmmssfff'; $outPath = Join-Path $script:MacWorkerBState "bridge.stdout.$tag.log"; $errPath = Join-Path $script:MacWorkerBState "bridge.stderr.$tag.log"
$launcherPath = Join-Path $script:MacWorkerBState "bridge-launch.$tag.cmd"
Set-Content -LiteralPath $launcherPath -Encoding ascii -Value @("@echo off", "set SPIKE_WORKER_B_PORT=$Port", "set SPIKE_WORKER_B_LAN_IP=$LanIp", "set SPIKE_WORKER_B_MAC_PORT=$MacPort", "set SPIKE_WORKER_B_STATE_DIR=$($script:MacWorkerBState)", "`"$node`" `"$bridge`" 1>`"$outPath`" 2>`"$errPath`"")
$psi = [Diagnostics.ProcessStartInfo]::new(); $psi.FileName = $env:ComSpec; $psi.WorkingDirectory = $script:MacWorkerBRoot; $psi.UseShellExecute = $true; $psi.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$psi.Arguments = '/d /c call "' + $launcherPath + '"'
$launchUtc = (Get-Date).ToUniversalTime()
$p = [Diagnostics.Process]::Start($psi)
@{ pid=$p.Id; bridgePath=$bridge; launcherPath=$launcherPath; stdoutPath=$outPath; stderrPath=$errPath; processStartUtc=$launchUtc.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $script:MacWorkerBPidPath -Encoding utf8
$deadline = (Get-Date).AddSeconds(15); $command = $null
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $outPath) { $match = Select-String -LiteralPath $outPath -Pattern '^Pair URL: (.+)$' | Select-Object -Last 1; if ($match) { $command = $match.Matches[0].Groups[1].Value; break } }
  if ($p.HasExited) { throw "bridge exited before listening; see $errPath" }
  Start-Sleep -Milliseconds 100
}
if (-not $command) { Stop-MacWorkerBOwnedBridge; throw "bridge did not report listening within timeout; see $errPath" }
$listenerLine = netstat -ano | Select-String (':{0} .*LISTENING' -f $Port) | Select-Object -Last 1
$listenerPid = if ($listenerLine) { [int](($listenerLine.ToString().Trim() -split '\s+')[-1]) } else { $null }
$nodeProcess = if ($listenerPid) { Get-Process -Id $listenerPid -ErrorAction SilentlyContinue } else { $null }
if ($nodeProcess) { @{ pid=$nodeProcess.Id; bridgePath=$bridge; launcherPath=$launcherPath; stdoutPath=$outPath; stderrPath=$errPath; processStartUtc=$nodeProcess.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $script:MacWorkerBPidPath -Encoding utf8 }
Write-MacWorkerBJson ([ordered]@{ ok=$true; pid=$p.Id; listener="127.0.0.1:$script:MacWorkerBPort"; command=$command })
