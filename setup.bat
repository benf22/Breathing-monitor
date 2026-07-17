@echo off
REM ===========================================================================
REM  Breathing Monitor - one-time setup (Windows)
REM  Creates a virtual environment named "breathing-monitor" and installs deps.
REM  Double-click this once, then use run.bat to start the app.
REM ===========================================================================
cd /d "%~dp0"

echo Creating virtual environment "breathing-monitor"...
python -m venv breathing-monitor
if errorlevel 1 (
  echo.
  echo ERROR: could not create the environment.
  echo Make sure Python 3.10+ is installed and on your PATH ^(python --version^).
  echo Download it from https://www.python.org/downloads/ and tick "Add to PATH".
  echo.
  pause
  exit /b 1
)

call breathing-monitor\Scripts\activate.bat
echo Upgrading pip...
python -m pip install --upgrade pip
echo Installing dependencies ^(this can take a few minutes the first time^)...
pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo ERROR: dependency installation failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo ===========================================================================
echo  Setup complete!  Double-click  run.bat  to start Breathing Monitor.
echo  (Optional: run  create_desktop_shortcut.bat  for a Desktop icon.)
echo ===========================================================================
pause
