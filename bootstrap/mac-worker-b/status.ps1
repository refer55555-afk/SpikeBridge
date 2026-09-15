param([string]$StateDir,[int]$Port=0)
if ($Port -gt 0) { $env:SPIKE_WORKER_B_PORT = [string]$Port }
if ($StateDir) { $resolvedState = Resolve-Path -LiteralPath $StateDir -ErrorAction SilentlyContinue; $env:SPIKE_WORKER_B_STATE_DIR = if ($resolvedState) { $resolvedState.Path } else { [IO.Path]::GetFullPath($StateDir) } }
. (Join-Path $PSScriptRoot 'common.ps1')
$listener = $false; $client = [Net.Sockets.TcpClient]::new()
try { $client.Connect('127.0.0.1',$script:MacWorkerBPort); $listener=$true } catch {} finally { $client.Dispose() }
$owned = Get-MacWorkerBOwnedProcess
$api = $null; if ($listener) { try { $api = Invoke-MacWorkerBApi '/api/status' } catch {} }
$ownedPid = if($owned){$owned.Id}else{$null}; $registration = if($api){$api.registration}else{$null}; $ready = [bool]($api -and $api.ready)
Write-MacWorkerBJson ([ordered]@{ ok=$true; listener=$listener; ownedPid=$ownedPid; registration=$registration; ready=$ready })
