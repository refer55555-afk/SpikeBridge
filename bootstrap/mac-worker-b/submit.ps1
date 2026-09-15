param([Parameter(Mandatory=$true)][string]$TaskId,[Parameter(Mandatory=$true)][string]$Task,[Parameter(Mandatory=$true)][string]$TargetCwd,[string]$Model='gpt-5.6-luna',[ValidateSet('read-only','workspace-write')][string]$Sandbox='workspace-write',[string]$ResumeSessionId,[string]$ModelLevel,[string]$StateDir,[int]$Port=0,[switch]$AllowAstra)
if ($Port -gt 0) { $env:SPIKE_WORKER_B_PORT = [string]$Port }
if ($StateDir) { $resolvedState = Resolve-Path -LiteralPath $StateDir -ErrorAction SilentlyContinue; $env:SPIKE_WORKER_B_STATE_DIR = if ($resolvedState) { $resolvedState.Path } else { [IO.Path]::GetFullPath($StateDir) } }
. (Join-Path $PSScriptRoot 'common.ps1')
$body = [ordered]@{ taskId=$TaskId; task=$Task; targetCwd=$TargetCwd; model=$Model; modelLevel=if($ModelLevel){$ModelLevel}else{$null}; sandbox=$Sandbox; allowAstra=[bool]$AllowAstra; resumeSessionId=if($ResumeSessionId){$ResumeSessionId}else{$null}; resumeStatus='pending-runtime-adapter-unverified-0.153.4' }
Write-MacWorkerBJson (Invoke-MacWorkerBApi '/api/submit' 'POST' $body)
