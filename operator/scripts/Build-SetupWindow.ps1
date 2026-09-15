[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$operatorRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $PSScriptRoot 'SetupWindow.cs'
$output = Join-Path $operatorRoot 'Bridge 安装助手.exe'
$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$compiler) { throw '未找到 .NET Framework C# 编译器。' }
if (!(Test-Path -LiteralPath $source)) { throw "未找到安装助手源文件：$source" }

& $compiler /nologo /target:winexe /optimize+ "/out:$output" /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $output)) {
  throw "安装助手编译失败，退出代码：$LASTEXITCODE"
}

$built = Get-Item -LiteralPath $output
[pscustomobject]@{
  result = 'PASS'
  compiler = $compiler
  output = $built.FullName
  bytes = $built.Length
} | ConvertTo-Json -Compress
