@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更高版本，再启动探针。
  pause
  exit /b 1
)
node -e "for (const [name,version] of Object.entries(require('./package.json').dependencies)) { require(name); if (require(name + '/package.json').version !== version) process.exit(1) }" >nul 2>&1
if errorlevel 1 (
  call npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    echo 探针依赖安装失败，请检查 npm 网络连接后重试。
    pause
    exit /b 1
  )
)
node agent/main.ts %*
set "probeExit=%errorlevel%"
if "%~1"=="" pause
exit /b %probeExit%
