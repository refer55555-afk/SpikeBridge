$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$operator=Join-Path $root 'operator'
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(!(Test-Path $csc)){$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'}
if(!(Test-Path $csc)){throw '未找到系统自带的窗口启动器编译工具。'}
$exe=Join-Path $operator 'Bridge.exe'
& $csc /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll ('/out:'+$exe) (Join-Path $PSScriptRoot 'PanelLauncher.cs')
if($LASTEXITCODE -ne 0){throw 'Bridge 窗口启动器编译失败。'}
$shell=New-Object -ComObject WScript.Shell
$desktop=[Environment]::GetFolderPath('Desktop')
$linkPath=Join-Path $desktop 'Bridge.lnk'
$link=$shell.CreateShortcut($linkPath)
$link.TargetPath=$exe;$link.WorkingDirectory=$root;$link.Description='Bridge：查看任务、Token、规则、Memory、Bridge A/B 和安全恢复';$link.Save()
foreach($legacy in @((Join-Path $operator '桥接控制台.exe'),(Join-Path $desktop '桥接控制台.lnk'))){if(Test-Path -LiteralPath $legacy){Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue}}
$startupOutput=& (Join-Path $PSScriptRoot 'system.ps1') -Action startupEnable
$startupOk=$LASTEXITCODE -eq 0
@{result=if($startupOk){'PASS'}else{'PARTIAL'};exe=$exe;shortcut=$linkPath;startupEnabled=$startupOk;startupDetail=($startupOutput -join ' ')}|ConvertTo-Json -Compress
# Installing the usable window must not be reported as a total failure when
# Windows refuses only the optional automatic-start registration.
exit 0
