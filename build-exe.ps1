$ErrorActionPreference = 'Stop'

$manifest = Join-Path $PSScriptRoot 'package.json'
$version = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw 'package.json must declare a three-part version.'
}

$compiler = @('Framework64', 'Framework') | ForEach-Object {
    Join-Path $env:WINDIR "Microsoft.NET/$_/v4.0.30319/csc.exe"
} | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $compiler) {
    throw 'The .NET Framework 4.x C# compiler was not found.'
}

$outputDirectory = Join-Path $PSScriptRoot 'dist'
$executable = Join-Path $outputDirectory 'DesktopPlus-zh-CN.exe'
$icon = Join-Path $PSScriptRoot 'assets/icon-logo.ico'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$resources = @('desktop-plus-zh-cn.mjs', 'installation.cjs', 'runtime.cjs', 'zh-CN.json') |
    ForEach-Object { '/resource:{0},{1}' -f (Join-Path $PSScriptRoot $_), $_ }

$assemblyInfo = Join-Path $outputDirectory ("AssemblyInfo-{0}.cs" -f [guid]::NewGuid())
try {
    @"
using System.Reflection;

[assembly: AssemblyVersion("$version.0")]
[assembly: AssemblyFileVersion("$version.0")]
[assembly: AssemblyInformationalVersion("$version")]
"@ | Set-Content -LiteralPath $assemblyInfo -Encoding UTF8

    & $compiler /nologo /target:winexe /platform:anycpu /langversion:5 /codepage:65001 /optimize+ /warnaserror+ `
        /reference:System.Drawing.dll /reference:System.Windows.Forms.dll `
        "/win32icon:$icon" "/out:$executable" @resources (Join-Path $PSScriptRoot 'Launcher.cs') $assemblyInfo

    if ($LASTEXITCODE -ne 0) {
        throw "Compilation failed (exit $LASTEXITCODE)."
    }
} finally {
    if (Test-Path -LiteralPath $assemblyInfo) {
        Remove-Item -LiteralPath $assemblyInfo
    }
}

Write-Output $executable
