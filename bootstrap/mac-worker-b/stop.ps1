param([string]$StateDir)
if ($StateDir) { $resolvedState = Resolve-Path -LiteralPath $StateDir -ErrorAction SilentlyContinue; $env:SPIKE_WORKER_B_STATE_DIR = if ($resolvedState) { $resolvedState.Path } else { [IO.Path]::GetFullPath($StateDir) } }
. (Join-Path $PSScriptRoot 'common.ps1')
$before = Get-MacWorkerBOwnedProcess; Stop-MacWorkerBOwnedBridge
$stoppedPid = if($before){$before.Id}else{$null}
Write-MacWorkerBJson ([ordered]@{ ok=$true; stoppedPid=$stoppedPid })
