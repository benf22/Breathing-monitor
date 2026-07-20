# Desktop tray alert

A tiny system-tray app that turns its **icon red** when the phone sends a
breathing alert, and back to green after a hold time. **No popups.**

This exists because the web can't do it: a browser tab or installed PWA cannot
recolor its taskbar icon — the App Badge API only draws a system-colored
dot/number. A native tray app is the only way to get a real color-changing icon.

## Run

```bash
cd desktop
pip install -r requirements.txt
python tray_alert.py <your-topic>        # same topic as the phone's Config
```

Options:

- `--hold 60` — seconds the icon stays red after an alert (default 60).
- `--server https://ntfy.sh` — use a self-hosted ntfy instead.

Right-click the tray icon → **Clear** (force green) or **Quit**.

## Autostart on Windows (optional)

1. Make a shortcut to: `pythonw tray_alert.py <your-topic>`
   (`pythonw` runs it without a console window).
2. Press `Win+R`, type `shell:startup`, drop the shortcut in that folder.

Now the green/red tray icon runs on login, no popups.

## Package as a single .exe (optional)

```bash
pip install pyinstaller
pyinstaller --onefile --noconsole --name BreathingAlerts tray_alert.py
```
The exe in `dist/` takes the topic as an argument (or hardcode it in the script).
