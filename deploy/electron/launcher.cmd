@echo off
rem Launcher for Atrium. WorkBuddy / some Node setups inject NODE_OPTIONS=--require=...
rem which Electron (packaged app) rejects and exits immediately ("won't open").
rem We clear NODE_OPTIONS here, then start the real exe located in this folder.
set "NODE_OPTIONS="
for /f "delims=" %%I in ('dir /b /a-d "*.exe" 2^>nul') do (
  start "" "%%~fI"
  goto :launched
)
:launched
exit /b
