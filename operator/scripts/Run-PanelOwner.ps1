$ErrorActionPreference='Stop'
while($true){
  try {
    & (Join-Path $PSScriptRoot 'Start-Panel.ps1') -BackgroundOnly
    do {
      Start-Sleep -Seconds 5
      $healthy=$false
      try{$r=Invoke-RestMethod -Uri 'http://127.0.0.1:7692/api/ping' -TimeoutSec 3;$healthy=$r.service -eq 'spike-bridge-operator'}catch{}
    }while($healthy)
  } catch { Start-Sleep -Seconds 15 }
}
