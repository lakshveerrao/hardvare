@echo off
setlocal
cd /d "%~dp0.."

if not exist ".cloudflared\hardvare-app.token" (
  echo Missing tunnel token file: .cloudflared\hardvare-app.token
  exit /b 1
)

".cloudflared-extract\cloudflared\cloudflared.exe" tunnel --no-autoupdate --pidfile ".cloudflared\hardvare-app.pid" --logfile "cloudflared-hardvare.log" --loglevel info run --token-file ".cloudflared\hardvare-app.token"
