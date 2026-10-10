@echo off
REM ---------------------------------------------------------------------------
REM  Publishes Routinel to the VS Code Marketplace from this computer.
REM  Publisher: gauravgupta0612   (version comes from package.json)
REM  The first time, vsce asks for your Azure DevOps token (Marketplace > Manage)
REM  and remembers it for later runs (run  npx @vscode/vsce logout gauravgupta0612  to remove it).
REM  Alternatively set the environment variable VSCE_PAT before running this file.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VER=%%v
echo Publishing Routinel v%VER% to the VS Code Marketplace (publisher gauravgupta0612)
echo.

echo [1/4] Running tests...
call npm test --silent || (echo Tests failed - nothing was published. & pause & exit /b 1)

echo [2/4] Building routinel-%VER%.vsix ...
if exist "routinel-%VER%.vsix" ren "routinel-%VER%.vsix" "routinel-%VER%.previous.tmp" >nul 2>nul
call npx -y @vscode/vsce@3 package -o "routinel-%VER%.vsix" || (echo Packaging failed & pause & exit /b 1)

echo [3/4] Checking Marketplace sign-in...
if defined VSCE_PAT goto publish
call npx -y @vscode/vsce@3 ls-publishers 2>nul | findstr /i /x "gauravgupta0612" >nul
if errorlevel 1 (
  echo You are not signed in yet. Paste your Azure DevOps Personal Access Token when asked.
  call npx -y @vscode/vsce@3 login gauravgupta0612 || (echo Sign-in failed & pause & exit /b 1)
)

echo [4/4] Publishing...
:publish
call npx -y @vscode/vsce@3 publish --packagePath "routinel-%VER%.vsix"
if errorlevel 1 (
  echo.
  echo Publish failed. Common causes:
  echo  - version %VER% is already on the Marketplace: raise "version" in package.json, run release.cmd, try again
  echo  - token expired or missing "Marketplace - Manage" scope: run  npx @vscode/vsce logout gauravgupta0612  and retry
  pause & exit /b 1
)
echo.
echo Done. It appears in a few minutes at:
echo   https://marketplace.visualstudio.com/items?itemName=gauravgupta0612.routinel
pause
