@echo off
REM ===========================================================================
REM  Creates a "Breathing Monitor" shortcut on your Desktop that launches run.bat
REM ===========================================================================
cd /d "%~dp0"
set "TARGET=%~dp0run.bat"
set "WORKDIR=%~dp0"

powershell -NoProfile -Command ^
  "$sh = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $sh.CreateShortcut([System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'Breathing Monitor.lnk'));" ^
  "$lnk.TargetPath = '%TARGET%';" ^
  "$lnk.WorkingDirectory = '%WORKDIR%';" ^
  "$lnk.IconLocation = '%SystemRoot%\System32\shell32.dll,14';" ^
  "$lnk.Description = 'Start Breathing Monitor';" ^
  "$lnk.Save()"

if errorlevel 1 (
  echo Could not create the shortcut.
  pause
  exit /b 1
)
echo Desktop shortcut "Breathing Monitor" created. Double-click it to launch.
pause
