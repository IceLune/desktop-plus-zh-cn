$ErrorActionPreference = 'Stop'

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

& $compiler /nologo /target:winexe /platform:anycpu /langversion:5 /codepage:65001 /optimize+ /warnaserror+ `
    /reference:System.Drawing.dll /reference:System.Windows.Forms.dll `
    "/win32icon:$icon" "/out:$executable" @resources (Join-Path $PSScriptRoot 'Launcher.cs')

if ($LASTEXITCODE -ne 0) {
    throw "Compilation failed (exit $LASTEXITCODE)."
}

Write-Output $executable
