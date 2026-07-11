#!/bin/bash
# clean-start.sh
# Clears out anything that can cause the "hangs after being idle" problem,
# then starts the bot. Run this instead of `npm start` whenever it's been
# a while since the bot last ran, or after a previous run didn't shut down
# cleanly (closed terminal directly, PC slept mid-run, crash, etc.).
#
# IMPORTANT: this only targets Chromium processes launched BY this bot
# (identified by their command line referencing .wwebjs_auth), never your
# regular Chrome browser - killing by process name alone (chrome.exe) would
# also kill your actual browser tabs, since Puppeteer's Chromium and your
# normal Chrome share the same process name.

echo "Closing any leftover instance of this bot's own Chromium (not your browser)..."
wmic process where "name='chrome.exe' and commandline like '%wwebjs_auth%'" call terminate >/dev/null 2>&1

echo "Clearing any stale WhatsApp session lock..."
find .wwebjs_auth -name "SingletonLock" -delete 2>/dev/null

echo "Starting the bot..."
npm start