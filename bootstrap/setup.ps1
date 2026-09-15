[CmdletBinding()]
param(
  [string]$CodexBin = '',
  [switch]$SkipDependencies,
  [switch]$SkipLogin,
  [switch]$ConfigureSecondAccount,
  [switch]$SkipStart,
  [switch]$SkipPanel
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Step([string]$Text){Write-Host "`n=== $Text ===" -ForegroundColor Cyan}
function SaveJson([string]$Path,$Value){$dir=Split-Path -Parent $Path;if($dir){New-Item -ItemType Directory -Force -Path $dir|Out-Null};[IO.File]::WriteAllText($Path,(($Value|ConvertTo-Json -Depth 20)+"`n"),[Text.UTF8Encoding]::new($false))}
function ResolveCodex([string]$Candidate){
  if($Candidate){$p=$Candidate}
  elseif($env:CODEX_BIN){$p=$env:CODEX_BIN}
  else{
    $localFile=Join-Path $Root 'config\local.json';$p=''
    if(Test-Path -LiteralPath $localFile){try{$p=[string]((Get-Content -Raw -LiteralPath $localFile|ConvertFrom-Json).codexBin)}catch{}}
    if(-not $p){$cmd=Get-Command codex.exe -ErrorAction SilentlyContinue;if($cmd){$p=$cmd.Source}}
    if(-not $p){$cmd=Get-Command codex -ErrorAction SilentlyContinue;if($cmd -and [IO.Path]::GetExtension($cmd.Source) -ieq '.exe'){$p=$cmd.Source}}
    if(-not $p){$p=Read-Host '请输入本机 codex.exe 的完整路径（Codex Desktop/CLI 均可）'}
  }
  if([string]::IsNullOrWhiteSpace($p)){throw '没有配置 Codex 可执行文件。'}
  $p=[IO.Path]::GetFullPath($p.Trim('"'))
  if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw "找不到 Codex 可执行文件：$p"}
  $probe=& $p --version 2>&1
  if($LASTEXITCODE -ne 0 -or (($probe -join ' ') -notmatch 'codex-cli')){throw "该文件不是可用的 Codex CLI：$p`n$($probe -join ' ')"}
  return $p
}
function WriteAccountConfig([string]$AccountHome){
  New-Item -ItemType Directory -Force -Path $AccountHome|Out-Null
  if(Test-Path -LiteralPath (Join-Path $AccountHome 'config.toml')){return}
  $projectKey=$Root.ToLowerInvariant().Replace("'","''")
  $text="cli_auth_credentials_store = `"file`"`r`n`r`n[projects.'$projectKey']`r`ntrust_level = `"trusted`"`r`n"
  [IO.File]::WriteAllText((Join-Path $AccountHome 'config.toml'),$text,[Text.UTF8Encoding]::new($false))
}
function LoginAccount([string]$Label,[string]$AccountHome,[string]$Bin){
  if(Test-Path -LiteralPath (Join-Path $AccountHome 'auth.json')){Write-Host "$Label 已有 auth.json，跳过登录。" -ForegroundColor Green;return}
  if($SkipLogin){Write-Warning "$Label 尚未登录；之后请使用 CODEX_HOME=$AccountHome 完成 codex login。";return}
  Step "$Label 登录"
  $oldHome=$env:CODEX_HOME;$oldOpenAI=$env:OPENAI_API_KEY;$oldCodex=$env:CODEX_API_KEY;$oldAzure=$env:AZURE_OPENAI_API_KEY
  try{
    $env:CODEX_HOME=$AccountHome;Remove-Item Env:OPENAI_API_KEY,Env:CODEX_API_KEY,Env:AZURE_OPENAI_API_KEY -ErrorAction SilentlyContinue
    & $Bin login
    if($LASTEXITCODE -ne 0){throw "$Label Codex 登录未完成。"}
  }finally{
    $env:CODEX_HOME=$oldHome;$env:OPENAI_API_KEY=$oldOpenAI;$env:CODEX_API_KEY=$oldCodex;$env:AZURE_OPENAI_API_KEY=$oldAzure
  }
}
Step '检查运行环境'
$node=(Get-Command node.exe -ErrorAction Stop).Source
$npm=(Get-Command npm.cmd -ErrorAction Stop).Source
$nodeVersion=(& $node --version).Trim().TrimStart('v').Split('.')[0]
if([int]$nodeVersion -lt 22){throw 'Spike Bridge 公开版要求 Node.js 22 或更高版本。'}
$CodexBin=ResolveCodex $CodexBin
Write-Host "Node: $(& $node --version)"
Write-Host "Codex: $(& $CodexBin --version)"

Step '写入本机配置（不会提交到 Git）'
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'config'),(Join-Path $Root 'accounts'),(Join-Path $Root 'data\memory'),(Join-Path $Root 'logs'),(Join-Path $Root 'tmp'),(Join-Path $Root 'secrets\mac')|Out-Null
SaveJson (Join-Path $Root 'config\local.json') ([ordered]@{schemaVersion=1;codexBin=$CodexBin;configuredAt=(Get-Date).ToUniversalTime().ToString('o')})
if(!(Test-Path -LiteralPath (Join-Path $Root 'config\context.json'))){Copy-Item (Join-Path $Root 'config\context.example.json') (Join-Path $Root 'config\context.json')}
if(!(Test-Path -LiteralPath (Join-Path $Root 'config\operator.json'))){Copy-Item (Join-Path $Root 'config\operator.example.json') (Join-Path $Root 'config\operator.json')}
if(!(Test-Path -LiteralPath (Join-Path $Root 'config\codex-call-profile.md'))){Copy-Item (Join-Path $Root 'config\codex-call-profile.example.md') (Join-Path $Root 'config\codex-call-profile.md')}

if(-not $SkipDependencies){
  Step '安装依赖'
  & $npm ci --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw '根目录 npm ci 失败。'}
  Push-Location (Join-Path $Root 'state\safe-boot\seed-lkg\codexless-runtime')
  try{& $npm ci --no-audit --no-fund;if($LASTEXITCODE -ne 0){throw 'Codexless runtime npm ci 失败。'}}finally{Pop-Location}
}

Step '配置 Codex A'
$aHome=Join-Path $Root 'accounts\codex-a';WriteAccountConfig $aHome;LoginAccount 'Codex A' $aHome $CodexBin
$bHome=Join-Path $Root 'accounts\codex-b';WriteAccountConfig $bHome
if($ConfigureSecondAccount){LoginAccount 'Codex B' $bHome $CodexBin}else{Write-Host 'Codex B 未登录（可选）。需要第二账号时重新运行 setup.ps1 -ConfigureSecondAccount。'}

if(-not $SkipStart){
  if(!(Test-Path -LiteralPath (Join-Path $aHome 'auth.json'))){throw 'Codex A 尚未登录，不能初始化 Bridge。请先完成登录或使用 -SkipStart。'}
  Step '初始化并启动 Safe-Boot'
  $env:SPIKE_BRIDGE_ROOT=$Root;$env:CODEX_BIN=$CodexBin
  & $node (Join-Path $Root 'runtime\safe-boot\spike-home-production.g3.mjs') init-seed
  if($LASTEXITCODE -ne 0){throw 'Safe-Boot 首次初始化失败。请查看上面的结构化错误。'}
  $health=Invoke-RestMethod -Uri 'http://127.0.0.1:7690/healthz' -TimeoutSec 5
  if($health.ok -ne $true){throw 'Bridge 已启动但健康检查未通过。'}
  Write-Host "Bridge 已启动： http://127.0.0.1:7690/mcp" -ForegroundColor Green
}

if(-not $SkipPanel){
  Step '安装工作台'
  & (Join-Path $Root 'operator\scripts\Install-Panel.ps1')
  if($LASTEXITCODE -ne 0){Write-Warning '工作台快捷方式安装未完全成功；仍可运行 npm run panel。'}
}

Write-Host "`nSETUP PASS" -ForegroundColor Green
Write-Host '工作台：npm run panel'
Write-Host 'Bridge：START-SPIKE-BRIDGE.cmd'
Write-Host '健康检查：http://127.0.0.1:7690/healthz'
Write-Host '远程 ChatGPT/Fast Entry 隧道属于可选外部组件，参见 docs\TUNNEL_SETUP.md。'