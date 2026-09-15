$ErrorActionPreference = 'Stop'
$script:MacWorkerBDir = $PSScriptRoot
$script:MacWorkerBRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$script:MacWorkerBState = if ($env:SPIKE_BRIDGE_MAC_STATE_DIR) { [IO.Path]::GetFullPath($env:SPIKE_BRIDGE_MAC_STATE_DIR) } elseif ($env:SPIKE_WORKER_B_STATE_DIR) { [IO.Path]::GetFullPath($env:SPIKE_WORKER_B_STATE_DIR) } else { Join-Path $script:MacWorkerBRoot 'state\agents\mac' }
$script:MacWorkerBPidPath = Join-Path $script:MacWorkerBState 'bridge.pid.json'
$script:MacWorkerBOut = Join-Path $script:MacWorkerBState 'bridge.stdout.log'
$script:MacWorkerBErr = Join-Path $script:MacWorkerBState 'bridge.stderr.log'
$script:MacWorkerBPort = if ($env:SPIKE_WORKER_B_PORT) { [int]$env:SPIKE_WORKER_B_PORT } else { 8766 }
$script:MacWorkerBSecretPath = if ($env:SPIKE_BRIDGE_MAC_SECRET_FILE) { [IO.Path]::GetFullPath($env:SPIKE_BRIDGE_MAC_SECRET_FILE) } else { Join-Path $script:MacWorkerBRoot 'secrets\mac\pairing.secret' }

function Write-MacWorkerBJson([object]$Value) { $Value | ConvertTo-Json -Depth 8 -Compress }
function Get-MacWorkerBSecret {
  $path = $script:MacWorkerBSecretPath
  if (-not (Test-Path -LiteralPath $path)) { throw 'pairing.secret is missing; start the bridge first' }
  return (Get-Content -LiteralPath $path -Raw).Trim()
}
function Get-MacWorkerBBearer {
  $h = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes((Get-MacWorkerBSecret)))
  try { return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes('task-api-v1')))).Replace('-', '').ToLowerInvariant() } finally { $h.Dispose() }
}
function Invoke-MacWorkerBApi([string]$Path, [string]$Method='GET', [object]$Body) {
  $headers = @{ Authorization = "Bearer $(Get-MacWorkerBBearer)" }
  $params = @{ Uri = "http://127.0.0.1:$script:MacWorkerBPort$Path"; Method = $Method; Headers = $headers; ErrorAction = 'Stop' }
  if ($null -ne $Body) { $params.ContentType = 'application/json'; $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress) }
  try { return Invoke-RestMethod @params } catch { if ($_.Exception.Response) { $reader = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream()); try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() } }; throw }
}
function Get-MacWorkerBOwnedProcess {
  if (-not (Test-Path -LiteralPath $script:MacWorkerBPidPath)) { return $null }
  $record = Get-Content -LiteralPath $script:MacWorkerBPidPath -Raw | ConvertFrom-Json
  $p = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try { if ([Math]::Abs(($p.StartTime.ToUniversalTime() - [DateTimeOffset]::Parse($record.processStartUtc).UtcDateTime).TotalSeconds) -lt 5) { return $p } } catch {}
  return $null
}
function Stop-MacWorkerBOwnedBridge {
  $p = Get-MacWorkerBOwnedProcess
  if ($p) { & taskkill.exe /PID $p.Id /T /F | Out-Null; $p.WaitForExit(5000) }
  if (Test-Path -LiteralPath $script:MacWorkerBPidPath) { try { $record = Get-Content -LiteralPath $script:MacWorkerBPidPath -Raw | ConvertFrom-Json; if ($record.launcherPath) { Remove-Item -LiteralPath $record.launcherPath -Force -ErrorAction SilentlyContinue } } catch {} }
  Remove-Item -LiteralPath $script:MacWorkerBPidPath -Force -ErrorAction SilentlyContinue
}
