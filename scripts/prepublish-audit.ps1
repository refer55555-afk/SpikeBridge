[CmdletBinding()]
param([string]$Root='')
$ErrorActionPreference='Stop'
if(-not $Root){$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path}else{$Root=[IO.Path]::GetFullPath($Root)}
$self=[IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$skip='^(?:\.git|node_modules|accounts|secrets|data|logs|tmp|cache|exports|diagnostics|runtime/state|state/safe-boot/(?:releases|work|boot-sessions|detached))(?:/|$)'
$binaryExt=@('.png','.jpg','.jpeg','.gif','.webp','.ico','.exe','.dll','.pdb','.zip','.sqlite','.db','.tgz','.gz','.pdf','.pyc')
$files=Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Where-Object {
  $full=[IO.Path]::GetFullPath($_.FullName)
  $rel=$full.Substring($Root.Length).TrimStart('\','/').Replace('\','/')
  $full -ne $self -and $rel -notmatch $skip -and $binaryExt -notcontains $_.Extension.ToLowerInvariant()
}
$badFiles=@()
foreach($f in Get-ChildItem -LiteralPath $Root -Recurse -File -Force){
  $rel=$f.FullName.Substring($Root.Length).TrimStart('\','/').Replace('\','/')
  if($rel -match '(^|/)(auth\.json|.*\.dpapi|pairing\.secret)$' -or $rel -match '^(accounts|secrets|data|logs|runtime/state)/'){$badFiles+=$rel}
  if($rel -match '^state/(?!safe-boot/seed-lkg/)'){$badFiles+=$rel}
}
$patterns=[ordered]@{
  'private-root'='F:\\SpikeBridge';
  'windows-user-path'='C:\\Users\\(?!YOUR_USER|USERNAME|<USER>|Public(?:\\|\b))[^\\\s"''`]+';
  'github-token'='\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b';
  'openai-style-secret'='\bsk-[A-Za-z0-9_-]{20,}\b';
  'bearer-secret'='Bearer\s+[A-Za-z0-9._~+\/-]{20,}';
  'tunnel-id'='\btunnel_[A-Za-z0-9]{16,}\b';
  'organization-id'='\borg-[A-Za-z0-9]{12,}\b';
  'email-address'='\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b';
}
$hits=@()
foreach($file in $files){
  $text='';try{$text=[IO.File]::ReadAllText($file.FullName)}catch{continue}
  foreach($entry in $patterns.GetEnumerator()){
    $matches=[regex]::Matches($text,$entry.Value,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
    foreach($m in $matches){
      $line=1+($text.Substring(0,$m.Index).Split("`n").Count-1)
      $hits+=[pscustomobject]@{kind=$entry.Key;file=$file.FullName.Substring($Root.Length).TrimStart('\','/').Replace('\','/');line=$line;preview=($m.Value.Substring(0,[Math]::Min(80,$m.Value.Length)))}
    }
  }
}
$badFiles=@($badFiles|Sort-Object -Unique)
if($badFiles.Count -or $hits.Count){
  Write-Host 'PUBLIC AUDIT FAIL' -ForegroundColor Red
  if($badFiles.Count){Write-Host 'Forbidden files:' -ForegroundColor Yellow;$badFiles|ForEach-Object{Write-Host ('  '+$_)}}
  if($hits.Count){Write-Host 'Sensitive-pattern hits:' -ForegroundColor Yellow;$hits|Format-Table -AutoSize|Out-String|Write-Host}
  exit 1
}
Write-Host ("PUBLIC AUDIT PASS - {0} text files scanned" -f $files.Count) -ForegroundColor Green
exit 0