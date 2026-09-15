param([int]$Port=8766)
$ErrorActionPreference='Stop'
$rule="Spike Home Mac Worker B bridge TCP $Port (Private only)"
Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Private' | Out-Null
if (-not (Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Private')) { throw 'No active Private network profile; refusing to add a firewall rule.' }
if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null }
Write-Output "Private-profile-only firewall rule ready for TCP $Port."
