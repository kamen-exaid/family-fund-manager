@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git was not found. Please install Git or add it to PATH.
    pause
    exit /b 1
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Windows PowerShell was not found.
    pause
    exit /b 1
)

for %%I in ("%CD%") do set "PROJECT_NAME=%%~nxI"
for /f %%I in ('powershell.exe -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%I"

set "ARCHIVE=%CD%\%PROJECT_NAME%_%STAMP%.zip"
set "FILE_LIST=%TEMP%\fund_account_package_%RANDOM%_%RANDOM%.txt"

echo Collecting project files and node_modules...
git -c core.quotepath=false ls-files -z --cached --others --exclude-standard > "%FILE_LIST%"
if errorlevel 1 (
    echo [ERROR] Failed to collect the file list.
    del /q "%FILE_LIST%" >nul 2>nul
    pause
    exit /b 1
)

for %%I in ("%FILE_LIST%") do if %%~zI==0 (
    echo [ERROR] No files were found to package.
    del /q "%FILE_LIST%" >nul 2>nul
    pause
    exit /b 1
)

echo Creating "%ARCHIVE%"...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "$bytes = [IO.File]::ReadAllBytes($env:FILE_LIST);" ^
    "$files = [Text.Encoding]::UTF8.GetString($bytes).Split([char]0, [StringSplitOptions]::RemoveEmptyEntries);" ^
    "$root = (Resolve-Path -LiteralPath '.').Path.TrimEnd('\') + '\';" ^
    "if (Test-Path -LiteralPath 'node_modules' -PathType Container) { $files += Get-ChildItem -LiteralPath 'node_modules' -File -Recurse | ForEach-Object { $_.FullName.Substring($root.Length) } }" ^
    "Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
    "$zip = [IO.Compression.ZipFile]::Open($env:ARCHIVE, [IO.Compression.ZipArchiveMode]::Create);" ^
    "try { foreach ($file in $files) { if (![string]::IsNullOrWhiteSpace($file) -and (Test-Path -LiteralPath $file -PathType Leaf)) { $source = (Resolve-Path -LiteralPath $file).Path; $entry = $file.Replace('\', '/'); [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source, $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null } } } finally { $zip.Dispose() }"
set "RESULT=%ERRORLEVEL%"
del /q "%FILE_LIST%" >nul 2>nul

if not "%RESULT%"=="0" (
    del /q "%ARCHIVE%" >nul 2>nul
    echo [ERROR] Packaging failed. A tracked file may be missing.
    pause
    exit /b %RESULT%
)

echo.
echo Done: "%ARCHIVE%"
for %%I in ("%ARCHIVE%") do echo Size: %%~zI bytes
pause
exit /b 0
