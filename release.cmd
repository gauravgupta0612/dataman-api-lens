@echo off
REM ---------------------------------------------------------------------------
REM  Routinel release: commit + tag + push to GitHub (and a GitHub Release with
REM  the .vsix when the GitHub CLI "gh" is installed).
REM  Every commit and tag is made as: gauravgupta0612 (no other author/co-author)
REM  Before running: bump "version" in package.json and add a "## x.y.z" section
REM  at the top of CHANGELOG.md.
REM ---------------------------------------------------------------------------
setlocal EnableDelayedExpansion
cd /d "%~dp0"

where git  >nul 2>nul || (echo Git is not installed: https://git-scm.com & pause & exit /b 1)
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VER=%%v
echo Releasing Routinel v%VER%
node scripts\release-notes.js %VER% > "%TEMP%\routinel-notes.md" || (echo Add a "## %VER%" section to CHANGELOG.md first. & pause & exit /b 1)
node scripts\release-notes.js %VER% --commit > "%TEMP%\routinel-commit.txt"
type "%TEMP%\routinel-notes.md"
echo.

git config user.name "gauravgupta0612"
git config user.email "gauravgupta0612@users.noreply.github.com"
git remote get-url origin >nul 2>nul || git remote add origin https://github.com/gauravgupta0612/dataman-api-lens.git

echo Building routinel-%VER%.vsix ...
call npx -y @vscode/vsce package --allow-missing-repository || (echo Packaging failed & pause & exit /b 1)

git add -A
git diff --cached --quiet || git commit -F "%TEMP%\routinel-commit.txt"
git tag -a v%VER% -F "%TEMP%\routinel-commit.txt" 2>nul || echo Tag v%VER% already exists - skipping tag.

echo Pushing to GitHub (sign in as gauravgupta0612 if asked) ...
git push origin main || (echo Push failed & pause & exit /b 1)
git push origin v%VER%

where gh >nul 2>nul && (
  gh release create v%VER% "routinel-%VER%.vsix" --repo gauravgupta0612/dataman-api-lens --title "Routinel v%VER%" --notes-file "%TEMP%\routinel-notes.md"
) || (
  echo.
  echo GitHub CLI not found - create the release in the browser:
  echo   https://github.com/gauravgupta0612/dataman-api-lens/releases/new?tag=v%VER%
  echo   Title: Routinel v%VER%   - paste the notes above - attach routinel-%VER%.vsix
)
echo.
echo Done.
pause
