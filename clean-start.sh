#!/bin/bash
# clean-start.sh
# Clears out anything that can cause the "hangs after being idle" problem,
# or a leftover process blocking the next run, then starts the bot. Run
# this instead of `npm start` whenever it's been a while since the bot
# last ran, or after a previous run didn't shut down cleanly (closed
# terminal directly, PC slept mid-run, crash, EADDRINUSE, etc.).
#
# IMPORTANT: the Chromium-killing step only targets Chromium processes
# launched BY this bot (identified by their command line referencing
# .wwebjs_auth), never your regular Chrome browser - killing by process
# name alone (chrome.exe) would also kill your actual browser tabs, since
# Puppeteer's Chromium and your normal Chrome share the same process name.

echo "Closing any leftover instance of this bot's own Chromium (not your browser)..."
# wmic has been deprecated by Microsoft and is no longer installed by
# default on newer Windows builds (Windows 11 24H2+) - if it's missing,
# the old wmic-based kill silently did nothing, which is why a crashed run
# could leave an orphaned Chromium locking .wwebjs_auth/session for every
# subsequent attempt. Get-CimInstance is the actively supported PowerShell
# replacement and works the same way: match by command line, not just
# process name, so this still never touches your actual browser.
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*wwebjs_auth*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null

# Give Windows a moment to fully release the killed process's file locks
# before Chromium tries to relaunch against the same profile folder -
# killing and immediately relaunching too fast can still see a stale lock.
sleep 1

echo "Clearing any stale WhatsApp session lock..."
find .wwebjs_auth -name "SingletonLock" -delete 2>/dev/null
find .wwebjs_auth -name "SingletonSocket" -delete 2>/dev/null
find .wwebjs_auth -name "SingletonCookie" -delete 2>/dev/null

echo "Freeing port 3000 if a previous instance is still running..."
PID=$(netstat -ano | grep ':3000 ' | grep LISTENING | awk '{print $NF}' | head -n1)
if [ -n "$PID" ]; then
  echo "  Found leftover process on port 3000 (PID $PID) - closing it..."
  taskkill //F //PID "$PID" 2>/dev/null
fi

echo "Starting the bot..."
npm start