@echo off
REM ---------------------------------------------------------------------------
REM  Routinel - one-click release
REM   1. asks for the new version and what changed (writes CHANGELOG.md + package.json)
REM   2. runs the tests
REM   3. commits as gauravgupta0612, tags vX.Y.Z and pushes to GitHub
REM  GitHub Actions (.github/workflows/release.yml) then builds the .vsix and creates
REM  the GitHub Release automatically (and publishes to the Marketplace if VSCE_PAT is set).
REM ---------------------------------------------------------------------------
setlocal EnableDelayedExpansion
cd /d "%~dp0"
where git  >nul 2>nul || (echo Git is not installed: https://git-scm.com & pause & exit /b 1)
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set CUR=%%v
echo Current version: %CUR%
echo   [Enter] = patch   or type: minor / major / an exact version (e.g. 1.4.0) / current
set "KIND=patch"
set /p "KIND=New version: "

set "NOTES="
echo.
echo What changed? One line per change, empty line to finish (empty = keep CHANGELOG as it is):
:notes
set "LINE="
set /p "LINE=  - "
if not defined LINE goto notesdone
set NOTES=!NOTES! "!LINE!"
goto notes
:notesdone

for /f "delims=" %%v in ('node scripts\bump.js %KIND% !NOTES!') do set VER=%%v
echo.
node scripts\release-notes.js %VER% || (echo CHANGELOG.md has no section for %VER% & pause & exit /b 1)
echo.

echo Running tests...
call npm test --silent || (echo Tests failed - nothing was committed. & pause & exit /b 1)

git config user.name "gauravgupta0612"
git config user.email "gauravgupta0612@users.noreply.github.com"
git remote get-url origin >nul 2>nul || git remote add origin https://github.com/gauravgupta0612/dataman-api-lens.git

git pull -q --rebase --autostash origin main
REM never publish local editor data (saved requests, environments)
git rm -r --cached --ignore-unmatch -q .routinel .dataman test/fixtures/.routinel test/fixtures/.dataman >nul 2>nul
git add -A
node scripts\release-notes.js %VER% --commit > "%TEMP%\routinel-commit.txt"
git diff --cached --quiet || git commit -q -F "%TEMP%\routinel-commit.txt"

git rev-parse -q --verify "refs/tags/v%VER%" >nul && (echo Tag v%VER% already exists - choose a new version. & pause & exit /b 1)
git tag -a v%VER% -F "%TEMP%\routinel-commit.txt"

echo Pushing to GitHub (sign in as gauravgupta0612 if asked)...
git push origin main || (echo Push failed & pause & exit /b 1)
git push origin v%VER% || (echo Tag push failed & pause & exit /b 1)

echo.
echo Done. GitHub is now building and publishing the release:
echo   https://github.com/gauravgupta0612/dataman-api-lens/actions
echo   https://github.com/gauravgupta0612/dataman-api-lens/releases/tag/v%VER%
pause
