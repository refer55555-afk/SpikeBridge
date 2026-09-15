[CmdletBinding()]
param(
  [int]$Port = 7691,
  [switch]$Replace,
  [string]$AHome = '',
  [string]$MemoryDb = '',
  [string]$RuntimeRoot = '',
  [int]$ReadyTimeoutSec = 30,
  [switch]$BreakGlassMutableProduction
)
$ErrorActionPreference='Stop'
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Node=(Get-Command node.exe -ErrorAction Stop).Source
$Overlay=Join-Path $Root 'runtime\codexless\mcp-http-with-git-commit-and-spike-context.mjs'
$localPath=Join-Path $Root 'config\local.json'
if(!(Test-Path -LiteralPath $localPath)){throw 'Missing config/local.json. Run bootstrap/setup.ps1 first.'}
$local=Get-Content -Raw -LiteralPath $localPath|ConvertFrom-Json
$CodexBin=[IO.Path]::GetFullPath([string]$local.codexBin)
if(!(Test-Path -LiteralPath $CodexBin)){throw "Configured Codex executable is missing: $CodexBin"}
if(-not $RuntimeRoot){$RuntimeRoot=Join-Path $Root 'state\safe-boot\seed-lkg\codexless-runtime'}
$RuntimeRoot=[IO.Path]::GetFullPath($RuntimeRoot)
$BreakGlassAuthorized=$BreakGlassMutableProduction -and $env:SPIKE_SAFE_BOOT_BREAK_GLASS -eq '1'
if($Port -eq 7690 -and -not $BreakGlassAuthorized){throw 'Production port 7690 is Safe-Boot managed. Use START-SPIKE-BRIDGE.cmd.'}
$env:SPIKE_SAFE_BOOT_BREAK_GLASS=$null
$CanonicalAHome=Join-Path $Root 'accounts\codex-a'
if(-not $AHome){$AHome=$CanonicalAHome}
$AHome=[IO.Path]::GetFullPath($AHome)
if(-not (Test-Path -LiteralPath (Join-Path $AHome 'auth.json'))){throw "Codex A auth.json is missing. Run bootstrap/setup.ps1 and complete Codex login: $AHome"}
if(-not $MemoryDb){$MemoryDb=if($Port -eq 7690){Join-Path $Root 'data\memory\experience.db'}else{Join-Path $Root "tmp\canary-memory-$Port.db"}}
$CallProfile=Join-Path $Root 'config\codex-call-profile.md'
$MacSecret=Join-Path $Root 'secrets\mac\pairing.secret'
$ZCodeState=Join-Path $Root 'state\agents\zcode\jobs.json'
$AgentAState=Join-Path $Root 'state\agents\codex-a\agent-task-cards.json'
$LogDir=Join-Path $Root 'logs\bridge'
$BridgeStateDir=Join-Path $Root 'state\bridge'
New-Item -ItemType Directory -Force -Path $LogDir,$BridgeStateDir,(Split-Path $MemoryDb),(Split-Path $AgentAState),(Split-Path $ZCodeState)|Out-Null
$env:SPIKE_BRIDGE_ROOT=$Root
$env:SPIKE_HOME_CODEXLESS_RUNTIME_ROOT=$RuntimeRoot
$env:CODEX_BIN=$CodexBin
$env:CODEX_HOME=$AHome
$env:CODEXLESS_CODEX_RUNTIME='existing'
$env:CODEXLESS_DEFAULT_CWD=$Root
$env:TOOLBOX_DEFAULT_CWD=$Root
$env:CODEX_TOOLBOX_DEFAULT_CWD=$Root
$env:CODEX_TOOLBOX_PUBLIC_HOST='127.0.0.1'
$env:CODEX_TOOLBOX_PUBLIC_PORT=[string]$Port
$env:SPIKE_BRIDGE_MEMORY_DB=$MemoryDb
$env:CODEXLESS_CALL_PROFILE_FILE=$CallProfile
$env:CODEXLESS_AGENT_TASK_STATE_FILE=$AgentAState
$env:SPIKE_BRIDGE_ZCODE_STATE_FILE=$ZCodeState
$env:SPIKE_BRIDGE_MAC_SECRET_FILE=$MacSecret
$env:SPIKE_BRIDGE_CONTEXT_FILE=Join-Path $Root 'config\context.json'
& $Node $Overlay