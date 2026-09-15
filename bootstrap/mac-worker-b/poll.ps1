param([Parameter(Mandatory=$true)][string]$TaskId,[string]$StateDir,[int]$Port=0)
if ($Port -gt 0) { $env:SPIKE_WORKER_B_PORT = [string]$Port }
if ($StateDir) { $resolvedState = Resolve-Path -LiteralPath $StateDir -ErrorAction SilentlyContinue; $env:SPIKE_WORKER_B_STATE_DIR = if ($resolvedState) { $resolvedState.Path } else { [IO.Path]::GetFullPath($StateDir) } }
. (Join-Path $PSScriptRoot 'common.ps1')
Write-MacWorkerBJson (Invoke-MacWorkerBApi ("/api/poll/{0}" -f [Uri]::EscapeDataString($TaskId)))
