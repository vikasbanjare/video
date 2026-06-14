@echo off
REM CutPilot one-click installer for Windows.
REM Enables CEP debug mode, clears the CEP cache (so updates actually show),
REM and copies the plugin into Premiere's extensions folder.

echo.
echo   Installing CutPilot v0.6.2 for Premiere Pro...
echo.
echo   QUIT Premiere Pro completely first, then press any key.
pause >nul

for %%v in (6 7 8 9 10 11 12) do (
  reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

set "DEST=%APPDATA%\Adobe\CEP\extensions\CutPilot"
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%~dp0" "%DEST%\" /e /i /q /y >nul

REM clear CEP cache so the new files load
if exist "%LOCALAPPDATA%\Temp\cep_cache" rmdir /s /q "%LOCALAPPDATA%\Temp\cep_cache" >nul 2>&1

echo.
if exist "%DEST%\index.html" (
  echo   Installed.
  echo   1. Open Premiere Pro
  echo   2. Window ^> Extensions ^> CutPilot
  echo   3. Check the panel top says v0.6.2 (confirms the new build loaded).
) else (
  echo   Copy failed. Manually copy this folder to: %DEST%
)
echo.
pause
