$ErrorActionPreference='Stop'
$dir=$PSScriptRoot
node --check (Join-Path $dir 'bridge.mjs')
python -m py_compile (Join-Path $dir 'mac-worker-b-daemon.py')
node --check (Join-Path $dir 'fixture.mjs')
node --check (Join-Path $dir 'bootstrap-generation-fixture.mjs')
node --check (Join-Path $dir 'bridge-fixture.mjs')
$bash=Get-Content (Join-Path $dir 'mac-worker-b-bootstrap.sh') -Raw
foreach($needle in @('codex --version','codex login status','launchctl load')) { if($bash -notmatch [regex]::Escape($needle)){throw "Missing static guard: $needle"} }
foreach($needle in @('stage dirs_ready','stage runtimes_resolved','stage codex_version_ok','stage login_status_ok','stage exec_help_ok','stage decode_worker_start','stage decode_worker_ok','stage plist_write_start','stage plist_write_ok','stage launchagent_start','stage launchagent_ok','stage done','trap ','bootstrap.log','base64.b64decode','sys.stdin.buffer.read','WORKER_TMP','py_compile','mv -f "$WORKER_TMP" "$WORKER"')) { if($bash -notmatch [regex]::Escape($needle)){throw "Missing bootstrap guard: $needle"} }
if($bash -match 'base64\s+-D'){throw 'Bootstrap must not depend on macOS base64 flags'}
$daemon=Get-Content (Join-Path $dir 'mac-worker-b-daemon.py') -Raw
foreach($needle in @('OPENAI_API_KEY','CODEX_SQLITE_HOME','codex-sqlite','chmod700(self.state)','subprocess.PIPE','--output-last-message','--model','--cd','--sandbox','read-only','workspace-write','SPIKE_WORKER_B_FIXTURE','gpt-5.6-luna','ProxyHandler({})','self.direct_http.open','turn.completed','inputTokens','cachedInputTokens','reasoningOutputTokens','build_codex_argv','resumeSessionId','resumeMismatch','thread.started')) { if($daemon -notmatch [regex]::Escape($needle)){throw "Missing daemon guard: $needle"} }
if($daemon -match 'chmod600\(self\.state\)'){throw 'State directory must remain traversable (0700), never 0600'}
if($daemon -match 'ask-for-approval|danger-full-access'){throw 'Unverified or unsafe capability present'}
if($bash -match 'codex login\s*$'){throw 'Bootstrap must not invoke codex login'}
foreach($wrapper in @('common.ps1','start.ps1','status.ps1','stop.ps1','submit.ps1','poll.ps1')) { if(-not (Test-Path (Join-Path $dir $wrapper))){throw "Missing wrapper: $wrapper"} }
$wrappers=(Get-ChildItem (Join-Path $dir '*.ps1') | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n"
if($wrappers -match 'codex\s+exec'){throw 'Windows wrappers must remain model-free'}
foreach($needle in @("/pair/",'pairConsumed','workerPyBase64','workerSha256','expectedCodexPath','expectedPythonPath','astraDefaultBlocked','cache-control','content-length')) { if((Get-Content (Join-Path $dir 'bridge.mjs') -Raw) -notmatch [regex]::Escape($needle)){throw "Missing pair endpoint guard: $needle"} }
foreach($needle in @('call-cards','taskSummary','modelLevel','queuedAtUtc','runningAtUtc','finishedAtUtc','lastMessagePreview','/api/card/','atomicWrite(cardFile')) { if((Get-Content (Join-Path $dir 'bridge.mjs') -Raw) -notmatch [regex]::Escape($needle)){throw "Missing call-card guard: $needle"} }
if((Get-Content (Join-Path $dir 'bridge.mjs') -Raw) -match 'pairConsumed.*consumed'){throw 'Pair token must be independent from legacy bootstrap token'}
foreach($fixture in @('fixture.py','fixture.mjs','bootstrap-generation-fixture.mjs','bridge-fixture.mjs')) {
  if($fixture -eq 'fixture.py') { python (Join-Path $dir $fixture) } else { node (Join-Path $dir $fixture) }
  if($LASTEXITCODE -ne 0) { throw "Fixture failed: $fixture (exit $LASTEXITCODE)" }
}
Write-Output 'PASS static validation and fixture lifecycle'
