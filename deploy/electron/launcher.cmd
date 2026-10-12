@echo off
rem Launcher for Atrium. WorkBuddy / some Node setups inject NODE_OPTIONS=--require=...
rem which Electron (packaged app) rejects and exits immediately ("won't open").
rem We clear NODE_OPTIONS here, then start the real exe located in this folder.
rem
rem Keep this file ASCII-only and CRLF-terminated: cmd.exe reads .cmd in the OEM
rem code page, so non-ASCII comments get mangled into garbage commands. LF-only
rem batch files are also a known weak spot around label/goto constructs.
rem
rem Prefer Atrium.exe by name; fall back to the first .exe in this folder. The
rem earlier version always took the first one, so a stray second exe (antivirus
rem or unzip leftovers) would launch the wrong thing.
setlocal
set "NODE_OPTIONS="
if exist "%~dp0Atrium.exe" (
  start "" "%~dp0Atrium.exe"
  exit /b 0
)
for /f "delims=" %%I in ('dir /b /a-d "%~dp0*.exe" 2^>nul') do (
  start "" "%~dp0%%I"
  goto :launched
)
:launched
exit /b 0
