@echo off
REM ===========================================================================
REM  Breathing Monitor - start the app (Windows)
REM  Double-click to run. Auto-runs setup the first time if needed.
REM  Opens the dashboard at http://127.0.0.1:8000
REM ===========================================================================
cd /d "%~dp0"

if not exist "breathing-monitor\Scripts\activate.bat" (
  echo Environment not found - running one-time setup first...
  call setup.bat
)
if not exist "breathing-monitor\Scripts\activate.bat" (
  echo Setup did not complete. Aborting.
  pause
  exit /b 1
)

call breathing-monitor\Scripts\activate.bat
echo Starting Breathing Monitor...
echo A browser will open at http://127.0.0.1:8000  (press Ctrl+C here to stop)
python main.py
pause
