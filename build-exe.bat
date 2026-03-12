@echo off
:: ─────────────────────────────────────────────────────────────────
:: Electron Forge V4 — Self-contained exe builder (pkg)
:: Produces: dist\ElectronForgeV4.exe
:: Run this from the electron-forge-v4 directory.
:: ─────────────────────────────────────────────────────────────────

echo.
echo  ⚡ Electron Forge V4 — building self-contained exe...
echo.

:: Check Node
node --version >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Node.js not found. Install from https://nodejs.org
  pause & exit /b 1
)

:: Install deps if needed
if not exist node_modules (
  echo  Installing dependencies...
  call npm install
  if errorlevel 1 ( echo  npm install failed & pause & exit /b 1 )
)

:: Install pkg globally if not present
where pkg >nul 2>&1
if errorlevel 1 (
  echo  Installing pkg...
  call npm install -g pkg
  if errorlevel 1 ( echo  pkg install failed & pause & exit /b 1 )
)

:: Create output dir
if not exist dist mkdir dist

echo  Building Windows x64 exe...
call pkg server.js --target node18-win-x64 --output dist\ElectronForgeV4.exe --compress GZip --assets "public/**/*"

if errorlevel 1 (
  echo.
  echo  Build failed. Check output above.
  pause & exit /b 1
)

echo.
echo  ✅ Done!  dist\ElectronForgeV4.exe
echo.
echo  Usage:
echo    Double-click ElectronForgeV4.exe  — opens in browser automatically
echo    Or:  ElectronForgeV4.exe          — then visit http://localhost:3847
echo.
echo  An 'electron-forge-data' folder will be created next to the exe
echo  for uploads and build artifacts.
echo.
pause
