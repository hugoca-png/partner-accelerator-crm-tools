@echo off
cd /d "%~dp0"
start "Capsule Export Server" /min cmd /k ""C:\Users\hugoc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.mjs"
